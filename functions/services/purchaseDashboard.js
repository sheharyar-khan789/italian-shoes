/**
 * Purchase dashboard and report tables. Everything is read from saved records (goods receipts, returns, payments,
 * refunds, orders, the supplier ledger and the suppliers' own balances); nothing is typed in or estimated. Reports come
 * back as plain tables ({ title, columns, rows, totals }) used by the screen, the CSV export and the print view.
 * Purchases are counted when goods are RECEIVED (accepted pairs), never when an order is created.
 */
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { pktDateKey } from "../shared/accounting.js";

const MAX_DOCS = 5000;
const SUPPLIER_LIMIT = 500;
const col = (key, label, type = "text") => ({ key, label, type });
const table = (title, columns, rows, totals = null) => ({ title, columns, rows, totals });
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
const startOf = (key) => Timestamp.fromDate(new Date(`${key}T00:00:00+05:00`));
const endOf = (key) => Timestamp.fromDate(new Date(`${key}T23:59:59.999+05:00`));
const dayOf = (t) => (t?.toDate ? pktDateKey(t.toDate()) : "");

/** @returns {Promise<Record<string, any>[]>} */
async function inRange(collection, from, to, field = "createdAt") {
  const snap = await db.collection(collection).where(field, ">=", startOf(from)).where(field, "<=", endOf(to)).orderBy(field).limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", `That range has more than ${MAX_DOCS} records. Please choose a shorter range.`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @returns {Promise<Record<string, any>[]>} */
async function allSuppliers() {
  const snap = await db.collection("suppliers").limit(SUPPLIER_LIMIT + 1).get();
  if (snap.size > SUPPLIER_LIMIT) throw new AppError("failed-precondition", `There are more than ${SUPPLIER_LIMIT} suppliers; this can't total them all.`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @param {{ from: string, to: string }} range */
export async function purchaseDashboard({ from, to }) {
  const [grns, returns, payments, refunds, suppliers, ordered, partial, drafts, recent] = await Promise.all([
    inRange("goodsReceipts", from, to),
    inRange("purchaseReturns", from, to),
    inRange("supplierPayments", from, to),
    inRange("supplierRefunds", from, to),
    allSuppliers(),
    db.collection("purchaseOrders").where("status", "==", "ordered").limit(501).get(),
    db.collection("purchaseOrders").where("status", "==", "partially_received").limit(501).get(),
    db.collection("purchaseOrders").where("status", "==", "draft").count().get(),
    db.collection("goodsReceipts").orderBy("createdAt", "desc").limit(10).get(),
  ]);
  const pendingValue = (snap) => snap.docs.reduce((n, d) => n + Math.max(0, (d.data().total ?? 0) - (d.data().receivedValue ?? 0)), 0);
  return {
    from,
    to,
    purchases: sum(grns, "value"),
    receipts: grns.length,
    returns: sum(returns, "value"),
    payments: sum(payments, "amount"),
    advancePayments: payments.filter((p) => p.isAdvance).reduce((n, p) => n + (p.advancePortion ?? 0), 0),
    refunds: sum(refunds, "amount"),
    payables: suppliers.reduce((n, s) => n + Math.max(0, s.balance ?? 0), 0),
    supplierCredits: suppliers.reduce((n, s) => n + Math.max(0, -(s.balance ?? 0)), 0),
    suppliers: suppliers.length,
    pendingOrders: { count: ordered.size, value: pendingValue(ordered) },
    partiallyReceived: { count: partial.size, value: pendingValue(partial) },
    drafts: drafts.data().count,
    recent: recent.docs.map((d) => ({ id: d.id, number: d.data().number, date: dayOf(d.data().createdAt), supplier: d.data().supplierName, order: d.data().purchaseOrderNumber, value: d.data().value, acceptedUnits: d.data().acceptedUnits ?? 0, rejectedUnits: d.data().rejectedUnits ?? 0 })),
  };
}

const LEDGER_TYPE = { opening: "Opening balance", purchase: "Goods received", payment: "Payment", return: "Return (credit note)", refund: "Refund from supplier", adjustment: "Adjustment" };
const KIND = { damaged: "Damaged", missing: "Missing", wrong_item: "Wrong size / item" };

/** @param {{ report: string, from: string, to: string, supplierId?: string }} input */
export async function purchaseReportTables({ report, from, to, supplierId }) {
  if (report === "ledger") {
    const ref = db.collection("suppliers").doc(/** @type {string} */ (supplierId));
    const [sup, before, within] = await Promise.all([
      ref.get(),
      db.collection("supplierLedger").where("supplierId", "==", supplierId).where("at", "<", startOf(from)).orderBy("at", "desc").limit(1).get(),
      db.collection("supplierLedger").where("supplierId", "==", supplierId).where("at", ">=", startOf(from)).where("at", "<=", endOf(to)).orderBy("at").limit(MAX_DOCS + 1).get(),
    ]);
    if (!sup.exists) throw new AppError("not-found", "That supplier doesn't exist.");
    if (within.size > MAX_DOCS) throw new AppError("failed-precondition", "That range has too many entries. Choose a shorter range.");
    const opening = before.empty ? 0 : before.docs[0].data().balanceAfter;
    const rows = within.docs.map((d) => ({ date: dayOf(d.data().at), type: LEDGER_TYPE[d.data().type] ?? d.data().type, ref: d.data().refNumber, note: d.data().note ?? "", debit: d.data().debit, credit: d.data().credit, balance: d.data().balanceAfter }));
    const closing = rows.length ? rows[rows.length - 1].balance : opening;
    return {
      title: `Supplier ledger — ${sup.data().name}`,
      from,
      to,
      tables: [table("Ledger", [col("date", "Date"), col("type", "Entry"), col("ref", "Reference"), col("note", "Note"), col("debit", "Debit (paid / returned)", "money"), col("credit", "Credit (owed)", "money"), col("balance", "Balance owed", "money")], [{ date: from, type: "Opening balance", ref: "", note: "Balance before this period", debit: null, credit: null, balance: opening }, ...rows], { date: "Total", type: "", ref: "", note: `Closing balance ${(closing / 100).toFixed(2)}`, debit: sum(rows, "debit"), credit: sum(rows, "credit"), balance: closing })],
      notes: ["Positive balance = you owe the supplier. A negative balance means the supplier holds a credit with you (for example an advance)."],
    };
  }

  if (report === "outstanding") {
    const sups = (await allSuppliers()).filter((s) => (s.balance ?? 0) !== 0).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    const rows = sups.map((s) => ({ name: s.name, phone: s.phone ?? "", whatsapp: s.whatsapp ?? "", owed: Math.max(0, s.balance ?? 0), credit: Math.max(0, -(s.balance ?? 0)), active: s.isActive === false ? "Off" : "On" }));
    return { title: "Supplier outstanding report", from, to, tables: [table("What you owe each supplier today", [col("name", "Supplier"), col("phone", "Phone"), col("whatsapp", "WhatsApp"), col("owed", "You owe", "money"), col("credit", "Supplier holds credit", "money"), col("active", "Status")], rows, { name: "Total", phone: "", whatsapp: "", owed: sum(rows, "owed"), credit: sum(rows, "credit"), active: "" })], notes: ["Balances are as of now; the dates above don't apply to this report."] };
  }

  const [grns, returns, payments, refunds] = await Promise.all([inRange("goodsReceipts", from, to), inRange("purchaseReturns", from, to), inRange("supplierPayments", from, to), inRange("supplierRefunds", from, to)]);

  if (report === "register") {
    const orders = await inRange("purchaseOrders", from, to);
    const money = "money";
    return {
      title: "Purchase register",
      from,
      to,
      tables: [
        table("Purchase orders", [col("date", "Date"), col("number", "Order"), col("supplier", "Supplier"), col("status", "Status"), col("total", "Order total", money), col("received", "Received value", money), col("returned", "Returned", money), col("paid", "Paid", money), col("payment", "Payment")], orders.map((o) => ({ date: dayOf(o.createdAt), number: o.number, supplier: o.supplierName, status: String(o.status).replace("_", " "), total: o.total, received: o.receivedValue ?? 0, returned: o.returnedValue ?? 0, paid: o.paidTotal ?? 0, payment: o.paymentStatus ?? "" })), { date: "Total", number: "", supplier: "", status: "", total: sum(orders, "total"), received: sum(orders, "receivedValue"), returned: sum(orders, "returnedValue"), paid: sum(orders, "paidTotal"), payment: "" }),
        table("Goods received", [col("date", "Date"), col("number", "GRN"), col("order", "Order"), col("supplier", "Supplier"), col("invoice", "Supplier invoice"), col("accepted", "Accepted pairs", "number"), col("rejected", "Rejected pairs", "number"), col("value", "Value", money)], grns.map((g) => ({ date: dayOf(g.createdAt), number: g.number, order: g.purchaseOrderNumber, supplier: g.supplierName, invoice: g.supplierInvoiceNo ?? "", accepted: g.acceptedUnits ?? 0, rejected: g.rejectedUnits ?? 0, value: g.value })), { date: "Total", number: "", order: "", supplier: "", invoice: "", accepted: sum(grns, "acceptedUnits"), rejected: sum(grns, "rejectedUnits"), value: sum(grns, "value") }),
      ],
      notes: ["Purchases are counted when goods are received, at the accepted pairs' value (after discount, tax and charges)."],
    };
  }

  if (report === "supplier") {
    const sups = new Map((await allSuppliers()).map((s) => [s.id, s]));
    /** @type {Map<string, any>} */
    const by = new Map();
    const row = (id, name) => by.get(id) ?? (by.set(id, { supplier: name ?? sups.get(id)?.name ?? id, purchased: 0, returned: 0, paid: 0, refunded: 0 }), by.get(id));
    for (const g of grns) row(g.supplierId, g.supplierName).purchased += g.value;
    for (const r of returns) row(r.supplierId, r.supplierName).returned += r.value;
    for (const p of payments) row(p.supplierId, p.supplierName).paid += p.amount;
    for (const r of refunds) row(r.supplierId, r.supplierName).refunded += r.amount;
    const rows = [...by.entries()].map(([id, r]) => ({ ...r, net: r.purchased - r.returned, outstanding: sups.get(id)?.balance ?? 0 })).sort((a, b) => b.purchased - a.purchased);
    return { title: "Supplier-wise purchase report", from, to, tables: [table("By supplier", [col("supplier", "Supplier"), col("purchased", "Purchased", "money"), col("returned", "Returned", "money"), col("net", "Net purchases", "money"), col("paid", "Paid", "money"), col("refunded", "Refunded to us", "money"), col("outstanding", "Owed today", "money")], rows, { supplier: "Total", purchased: sum(rows, "purchased"), returned: sum(rows, "returned"), net: sum(rows, "net"), paid: sum(rows, "paid"), refunded: sum(rows, "refunded"), outstanding: sum(rows, "outstanding") })], notes: ["\"Owed today\" is the supplier's balance now, whatever the dates; the other columns are for the chosen period."] };
  }

  if (report === "product") {
    /** @type {Map<string, any>} */
    const by = new Map();
    for (const g of grns)
      for (const l of g.lines ?? []) {
        const k = `${l.productId}/${l.variantId}`;
        const r = by.get(k) ?? { product: l.productName, variant: l.variantLabel, sku: l.sku ?? "", units: 0, returned: 0, value: 0 };
        r.units += l.acceptedQty ?? 0;
        r.returned += l.returnedQty ?? 0;
        r.value += l.value ?? 0;
        by.set(k, r);
      }
    const rows = [...by.values()].map((r) => ({ ...r, avg: r.units ? Math.round(r.value / r.units) : 0 })).sort((a, b) => b.value - a.value);
    return { title: "Product-wise purchase report", from, to, tables: [table("By product and variant (accepted pairs)", [col("product", "Product"), col("variant", "Variant"), col("sku", "SKU"), col("units", "Pairs received", "number"), col("returned", "Pairs returned", "number"), col("value", "Value", "money"), col("avg", "Average cost", "money")], rows, { product: "Total", variant: "", sku: "", units: sum(rows, "units"), returned: sum(rows, "returned"), value: sum(rows, "value"), avg: null })] };
  }

  if (report === "returns") {
    const rows = returns.map((r) => ({ date: dayOf(r.createdAt), number: r.number, supplier: r.supplierName, grn: r.grnNumber, reason: r.reason, creditNote: r.supplierReference ?? "", pairs: (r.lines ?? []).reduce((n, l) => n + (l.qty ?? 0), 0), value: r.value }));
    return { title: "Purchase return report", from, to, tables: [table("Returns to suppliers (credit notes)", [col("date", "Date"), col("number", "Return"), col("supplier", "Supplier"), col("grn", "Goods receipt"), col("reason", "Reason"), col("creditNote", "Supplier credit-note no."), col("pairs", "Pairs", "number"), col("value", "Credit value", "money")], rows, { date: "Total", number: "", supplier: "", grn: "", reason: "", creditNote: "", pairs: sum(rows, "pairs"), value: sum(rows, "value") })] };
  }

  // grn: the goods receiving report
  const rows = grns.map((g) => ({ date: dayOf(g.createdAt), number: g.number, order: g.purchaseOrderNumber, supplier: g.supplierName, warehouse: g.warehouseName ?? "", invoice: g.supplierInvoiceNo ?? "", accepted: g.acceptedUnits ?? 0, rejected: g.rejectedUnits ?? 0, value: g.value }));
  const rejected = grns.flatMap((g) => (g.lines ?? []).filter((l) => (l.rejectedQty ?? 0) > 0).map((l) => ({ date: dayOf(g.createdAt), number: g.number, supplier: g.supplierName, product: `${l.productName} (${l.variantLabel})`, qty: l.rejectedQty, kind: KIND[l.rejectKind] ?? "Damaged", reason: l.rejectReason ?? "" })));
  return {
    title: "Goods receiving report",
    from,
    to,
    tables: [
      table("Goods received", [col("date", "Date"), col("number", "GRN"), col("order", "Order"), col("supplier", "Supplier"), col("warehouse", "Warehouse"), col("invoice", "Supplier invoice"), col("accepted", "Accepted pairs", "number"), col("rejected", "Rejected pairs", "number"), col("value", "Value", "money")], rows, { date: "Total", number: "", order: "", supplier: "", warehouse: "", invoice: "", accepted: sum(rows, "accepted"), rejected: sum(rows, "rejected"), value: sum(rows, "value") }),
      table("Rejected, damaged and missing pairs (not added to stock, not owed for)", [col("date", "Date"), col("number", "GRN"), col("supplier", "Supplier"), col("product", "Item"), col("qty", "Pairs", "number"), col("kind", "What happened"), col("reason", "Reason")], rejected, { date: "Total", number: "", supplier: "", product: "", qty: sum(rejected, "qty"), kind: "", reason: "" }),
    ],
  };
}
