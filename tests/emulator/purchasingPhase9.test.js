/**
 * Phase 9 additions to suppliers and purchasing, against the emulators (`npm run test:emulator`): supplier details and
 * documents, taxes and charges on orders, partial receiving with damaged/missing goods, advance payments, refunds,
 * adjustments, the supplier ledger, the dashboard and report tables, concurrency and permissions. Everything is created
 * in a throwaway "demo-" database. Tests share state and run in order.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const warehouses = await import("../../functions/services/warehouses.js");
const accounting = await import("../../functions/services/accounting.js");
const accReports = await import("../../functions/services/accountingReports.js");
const suppliers = await import("../../functions/services/suppliers.js");
const purchaseOrders = await import("../../functions/services/purchaseOrders.js");
const goods = await import("../../functions/services/goodsReceipts.js");
const payments = await import("../../functions/services/supplierPayments.js");
const returns = await import("../../functions/services/purchaseReturns.js");
const adjustments = await import("../../functions/services/supplierAdjustments.js");
const dashboard = await import("../../functions/services/purchaseDashboard.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { priceOrder } = await import("../../functions/shared/purchase.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");
const TODAY = pktDateKey(new Date());
const TOKENS = {
  buyer: { uid: "buyer-1", staff: true, perms: ["purchases.read", "suppliers.manage", "purchases.manage"], auth_time: 9999999999 },
  payer: { uid: "payer-1", staff: true, perms: ["purchases.read", "suppliers.pay"], auth_time: 9999999999 },
  adjuster: { uid: "adj-1", staff: true, perms: ["purchases.read", "suppliers.pay", "suppliers.adjust"], auth_time: 9999999999 },
  reader: { uid: "reader-1", staff: true, perms: ["purchases.read"], auth_time: 9999999999 },
  customer: { uid: "c-1" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

const stock = async (p, wid) => ((await db.doc(`inventory/${p.productId}__${p.variantId}`).get()).data().byWarehouse?.[wid]?.onHand ?? 0);
const sup = async (id) => (await db.doc(`suppliers/${id}`).get()).data();
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const journalOf = async (type, id) => (await db.doc(`journalEntries/${type}__${id}`).get()).data();
const partyBal = async (id) => (await db.doc(`partyBalances/supplier__${id}`).get()).data()?.balance ?? 0;
/** What the books hold for a supplier: the ledger balance less any opening balance (opening balances are posted to the books separately, in Accounting → Opening balances). */
const booked = async (id) => ((await sup(id)).balance ?? 0) - ((await sup(id)).openingBalance ?? 0);

async function makeVariant(name, slug, sku) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price: 2000000, salePrice: null }), { actorUid: STAFF, canEditCost: false });
  return { productId, variantId: products.variantKey(ids.black, ids.s42) };
}
const newSupplier = async (name, over = {}) => (await suppliers.saveSupplier(schemas.saveSupplierInput.parse({ name, ...over }), STAFF)).id;
const line = (p, qty, unitCost, discount = 0) => ({ productId: p.productId, variantId: p.variantId, qty, unitCost, discount });
async function orderedPO(supplierId, lines, extra = {}) {
  const { id } = await purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ supplierId, warehouseId: ids.shop, lines, ...extra }), STAFF);
  await purchaseOrders.approvePurchaseOrder({ id }, STAFF);
  return id;
}
const receive = (poId, lines, over = {}) => goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: poId, lines, ...over }), STAFF);
const pay = (supplierId, amount, over = {}, opts = {}) => payments.recordSupplierPayment(schemas.supplierPaymentInput.parse({ idempotencyKey: key(), supplierId, amount, method: "cash", paidAt: TODAY, ...over }), STAFF, opts);

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "c-1") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: true });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  ids.p1 = await makeVariant("Oxford One", "oxford-one", "OX-1");
  ids.p2 = await makeVariant("Loafer Two", "loafer-two", "LF-2");
});

test("suppliers keep contact, WhatsApp, tax number and uploaded documents; documents must come from the receipt uploader", async () => {
  const doc = { url: "receipts/buyer-1/agreement.pdf", name: "agreement.pdf", type: "application/pdf", size: 4000 };
  const r = await call("saveSupplier", "buyer", { name: "Al-Noor Traders", contactPerson: "Bilal", phone: "0300 1234567", whatsapp: "0300 7654321", taxNumber: "NTN-1234567-8", email: "a@noor.pk", address: "Lahore", notes: "Net 30", documents: [doc], openingBalance: 500000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.s1 = r.body.data.id;
  const s = await sup(ids.s1);
  assert.deepEqual([s.whatsapp, s.taxNumber, s.documents.length, s.balance, s.openingBalance], ["0300 7654321", "NTN-1234567-8", 1, 500000, 500000]);
  assert.equal((await call("saveSupplier", "buyer", { name: "Bad Docs", documents: [{ ...doc, url: "https://evil.example.com/x.pdf" }] })).status, 400);
  assert.equal((await call("saveSupplier", "buyer", { id: ids.s1, name: "Al-Noor Traders", whatsapp: "0300 1111111" })).status, 200, "an edit keeps the opening balance");
  assert.deepEqual([(await sup(ids.s1)).openingBalance, (await sup(ids.s1)).balance], [500000, 500000]);
  assert.equal((await db.collection("supplierLedger").where("supplierId", "==", ids.s1).get()).size, 1, "the opening balance is the one ledger line");
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "supplier.created"));
});

test("an order with tax and extra charges: the server calculates it; stock does not move until goods are received", async () => {
  const lines = [line(ids.p1, 10, 100000)];
  const t = priceOrder(lines, 100000, { taxPercent: 10, charges: 50000 });
  assert.deepEqual([t.subtotal, t.taxTotal, t.chargesTotal, t.total, t.lines[0].effective], [1000000, 90000, 50000, 1040000, 1040000]);
  const input = { supplierId: ids.s1, warehouseId: ids.shop, lines, discount: 100000, taxPercent: 10, charges: [{ label: "Freight", amount: 50000 }], purchaseDate: TODAY, expectedDate: TODAY, supplierReference: "QT-77", attachments: [{ url: "receipts/buyer-1/quote.pdf", name: "quote.pdf", type: "application/pdf", size: 900 }] };
  const bad = await call("savePurchaseOrder", "buyer", { ...input, taxPercent: 150 });
  assert.equal(bad.status, 400);
  assert.equal((await call("savePurchaseOrder", "buyer", { ...input, charges: [{ label: "Freight", amount: 0 }] })).status, 400, "a charge needs an amount");
  const r = await call("savePurchaseOrder", "buyer", input);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = (await db.doc(`purchaseOrders/${r.body.data.id}`).get()).data();
  assert.deepEqual([doc.subtotal, doc.orderDiscount, doc.taxTotal, doc.chargesTotal, doc.total, doc.status, doc.purchaseDate, doc.attachments.length], [1000000, 100000, 90000, 50000, 1040000, "draft", TODAY, 1]);
  assert.equal(doc.lines.reduce((n, l) => n + l.effective, 0), doc.total, "the lines add up to the order total");
  assert.equal((await call("savePurchaseOrder", "buyer", { ...input, total: 1, subtotal: 1 })).status, 200, "totals sent by the browser are ignored");
  await purchaseOrders.approvePurchaseOrder({ id: r.body.data.id }, STAFF);
  assert.equal(await stock(ids.p1, ids.shop), 0, "creating or approving an order adds no stock");
  ids.po1 = r.body.data.id;
});

test("receiving: only accepted pairs become stock and are owed for, damaged and missing pairs are recorded, partial deliveries never double-count", async () => {
  const key1 = key();
  const first = await goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key1, purchaseOrderId: ids.po1, supplierInvoiceNo: "INV-1", lines: [{ lineIndex: 0, acceptedQty: 4, rejectedQty: 2, rejectReason: "Soles split", rejectKind: "damaged" }] }), STAFF);
  assert.equal((await goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key1, purchaseOrderId: ids.po1, lines: [{ lineIndex: 0, acceptedQty: 4, rejectedQty: 2, rejectReason: "Soles split" }] }), STAFF)).existing, true, "the same delivery sent twice counts once");
  assert.equal(await stock(ids.p1, ids.shop), 4);
  assert.equal((await db.doc(`purchaseOrders/${ids.po1}`).get()).data().status, "partially_received");
  const g1 = (await db.doc(`goodsReceipts/${first.grnId}`).get()).data();
  assert.deepEqual([g1.acceptedUnits, g1.rejectedUnits, g1.lines[0].rejectKind, g1.value], [4, 2, "damaged", 416000]);
  const j1 = await journalOf("grn", first.grnId);
  assert.deepEqual(j1.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1200", 416000, 0], ["2010", 0, 416000]]);
  const second = await receive(ids.po1, [{ lineIndex: 0, acceptedQty: 3, rejectedQty: 1, rejectReason: "Never arrived", rejectKind: "missing" }]);
  assert.equal(await stock(ids.p1, ids.shop), 7);
  const mid = (await db.doc(`purchaseOrders/${ids.po1}`).get()).data();
  assert.equal(mid.status, "received", "4 + 2 + 3 + 1 = all 10 ordered pairs accounted for");
  await assert.rejects(receive(ids.po1, [{ lineIndex: 0, acceptedQty: 2, rejectedQty: 0 }]), (e) => /only 0 still to receive|only 1 still/i.test(e.message) || e.code === "failed-precondition", "more than is pending is refused");
  const done = (await db.doc(`purchaseOrders/${ids.po1}`).get()).data();
  assert.deepEqual([done.status, done.receivedValue], ["received", 7 * 104000], "the parts add up to exactly the accepted pairs' value");
  const grns = [first, second].map((g) => g.grnId);
  assert.equal((await Promise.all(grns.map((id) => db.doc(`goodsReceipts/${id}`).get()))).reduce((n, d) => n + d.data().value, 0), 7 * 104000);
  const cost = (await db.doc(`variantCosts/${ids.p1.productId}__${ids.p1.variantId}`).get()).data();
  assert.equal(cost.costPrice, 104000, "the landed cost per pair includes discount, tax and freight");
  assert.equal((await db.collection("variantCostHistory").get()).size, 2, "every receipt keeps its own cost record");
  assert.equal(await sup(ids.s1).then((s) => s.balance), 500000 + 7 * 104000);
  const movements = (await db.collection("stockMovements").where("inventoryId", "==", `${ids.p1.productId}__${ids.p1.variantId}`).get()).docs.map((d) => d.data());
  assert.deepEqual(movements.map((m) => m.change).sort(), [3, 4]);
  assert.ok(movements.every((m) => m.sourceType === "grn" && m.warehouseId === ids.shop));
});

test("advance payments need their own permission and an explicit tick; they leave the supplier holding a credit that later purchases use up", async () => {
  const s2 = await newSupplier("Advance Footwear Co");
  ids.s2 = s2;
  await assert.rejects(pay(s2, 100000), (e) => /not owed anything/.test(e.message), "an ordinary payment can't be more than is owed");
  await assert.rejects(pay(s1(), 99999999999), (e) => /can't pay more than that/.test(e.message));
  await assert.rejects(pay(s2, 100000, { advance: true }, { canAdvance: false }), (e) => e.code === "permission-denied");
  const k = key();
  const a = await pay(s2, 300000, { advance: true, idempotencyKey: k });
  assert.equal((await pay(s2, 300000, { advance: true, idempotencyKey: k })).existing, true, "the same payment sent twice is recorded once");
  assert.equal((await sup(s2)).balance, -300000, "the supplier now holds a credit");
  const p = (await db.doc(`supplierPayments/${a.paymentId}`).get()).data();
  assert.deepEqual([p.isAdvance, p.advancePortion, p.amount], [true, 300000, 300000]);
  assert.deepEqual((await journalOf("supplierpayment", a.paymentId)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["2010", 300000, 0], ["1010", 0, 300000]]);
  assert.equal(await partyBal(s2), -300000, "the payables ledger agrees");
  const poId = await orderedPO(s2, [line(ids.p2, 10, 50000)]);
  await assert.rejects(pay(s2, 10000, { advance: true, purchaseOrderId: poId }), (e) => /can't be tied/.test(e.message));
  await receive(poId, [{ lineIndex: 0, acceptedQty: 10, rejectedQty: 0 }]);
  assert.equal((await sup(s2)).balance, 200000, "goods received use the advance up: 500,000 of goods − 300,000 already paid");
  assert.equal(await partyBal(s2), 200000);
  // Mixed: pay more than is owed by marking it an advance: only the excess is an advance.
  const mixed = await pay(s2, 250000, { advance: true });
  assert.equal((await db.doc(`supplierPayments/${mixed.paymentId}`).get()).data().advancePortion, 50000);
  assert.equal((await sup(s2)).balance, -50000);
  ids.poS2 = poId;
});
const s1 = () => ids.s1;

test("refunds from a supplier: only up to the credit they hold, posted Dr cash / Cr payables, once", async () => {
  const s2 = ids.s2;
  const input = (amount, over = {}) => schemas.supplierRefundInput.parse({ idempotencyKey: key(), supplierId: s2, amount, method: "cash", receivedAt: TODAY, ...over });
  await assert.rejects(adjustments.recordSupplierRefund(input(50001), STAFF), (e) => /holds/.test(e.message), "more than the credit");
  await assert.rejects(adjustments.recordSupplierRefund(input(1000, { supplierId: ids.s1 }), STAFF), (e) => /doesn't hold any credit/.test(e.message));
  assert.equal(schemas.supplierRefundInput.safeParse({ ...input(1000), method: "bank_transfer", reference: "" }).success, false, "a bank refund needs a reference");
  const cash0 = await net("1010");
  const i = input(30000);
  const r = await adjustments.recordSupplierRefund(i, STAFF);
  assert.equal((await adjustments.recordSupplierRefund(i, STAFF)).existing, true);
  assert.match(r.number, /^SR-\d{6}$/);
  assert.equal((await sup(s2)).balance, -20000);
  assert.equal((await net("1010")) - cash0, 30000);
  assert.deepEqual((await journalOf("supplierrefund", r.refundId)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1010", 30000, 0], ["2010", 0, 30000]]);
  assert.equal(await partyBal(s2), -20000);
  assert.equal((await db.collection("supplierRefunds").get()).size, 1);
  assert.equal((await sup(s2)).totalRefunded, 30000);
});

test("balance adjustments: a reason, an account the person chooses (never payables), both sides posted, in the ledger and the audit log", async () => {
  const inp = (over = {}) => schemas.supplierAdjustmentInput.parse({ idempotencyKey: key(), supplierId: ids.s1, direction: "decrease", amount: 40000, accountCode: "5020", reason: "Early-payment discount", date: TODAY, ...over });
  const before = (await sup(ids.s1)).balance;
  await assert.rejects(adjustments.recordSupplierAdjustment(inp({ accountCode: "2010" }), STAFF), (e) => /other than the payables/.test(e.message));
  await assert.rejects(adjustments.recordSupplierAdjustment(inp({ accountCode: "6000" }), STAFF), (e) => /active account/.test(e.message), "a heading can't take postings");
  await assert.rejects(adjustments.recordSupplierAdjustment(inp({ accountCode: "9999" }), STAFF), (e) => /active account/.test(e.message));
  await assert.rejects(adjustments.recordSupplierAdjustment(inp({ accountCode: "1110" }), STAFF), (e) => /other than/.test(e.message), "the receivables control account isn't allowed");
  assert.equal(schemas.supplierAdjustmentInput.safeParse({ ...inp(), reason: "" }).success, false);
  const i = inp();
  const r = await adjustments.recordSupplierAdjustment(i, STAFF);
  assert.equal((await adjustments.recordSupplierAdjustment(i, STAFF)).existing, true);
  assert.equal((await sup(ids.s1)).balance, before - 40000);
  assert.deepEqual((await journalOf("supplieradjustment", r.adjustmentId)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["2010", 40000, 0], ["5020", 0, 40000]]);
  const up = await adjustments.recordSupplierAdjustment(inp({ direction: "increase", amount: 15000, reason: "Unlisted unloading charge" }), STAFF);
  assert.deepEqual((await journalOf("supplieradjustment", up.adjustmentId)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["5020", 15000, 0], ["2010", 0, 15000]]);
  assert.equal((await sup(ids.s1)).balance, before - 40000 + 15000);
  assert.equal(await partyBal(ids.s1), before - 25000 - 500000, "the books hold everything except the opening balance, which is posted separately");
  const led = (await db.collection("supplierLedger").where("supplierId", "==", ids.s1).get()).docs.map((d) => d.data()).filter((l) => l.type === "adjustment");
  assert.deepEqual(led.map((l) => [l.debit, l.credit]).sort(), [[0, 15000], [40000, 0]]);
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "supplier.adjustment" && d.data().changes.reason === "Early-payment discount"));
});

test("purchase returns refer to the received goods, take stock out, reduce what is owed and can't exceed what was received", async () => {
  const grn = (await db.collection("goodsReceipts").where("purchaseOrderId", "==", ids.po1).orderBy("createdAt").get()).docs[0];
  const before = (await sup(ids.s1)).balance;
  const stock0 = await stock(ids.p1, ids.shop);
  const r = await returns.createPurchaseReturn(schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId: grn.id, reason: "Wrong size sent", supplierReference: "CN-5521", lines: [{ lineIndex: 0, qty: 2 }] }), STAFF);
  assert.equal(r.value, 208000);
  assert.equal(await stock(ids.p1, ids.shop), stock0 - 2);
  assert.equal((await sup(ids.s1)).balance, before - 208000);
  const doc = (await db.doc(`purchaseReturns/${r.returnId}`).get()).data();
  assert.deepEqual([doc.grnId, doc.supplierReference, doc.reason], [grn.id, "CN-5521", "Wrong size sent"]);
  await assert.rejects(returns.createPurchaseReturn(schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId: grn.id, reason: "Again", lines: [{ lineIndex: 0, qty: 3 }] }), STAFF), (e) => e.code === "failed-precondition", "only 2 of the 4 received pairs can still go back");
  assert.equal(await partyBal(ids.s1), await booked(ids.s1));
});

test("concurrent receiving never receives more than was ordered, and never double-counts stock or the supplier's balance", async () => {
  const s3 = await newSupplier("Concurrent Supplies");
  const p = await makeVariant("Racer", "racer", "RC-1");
  const poId = await orderedPO(s3, [line(p, 10, 10000)]);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => receive(poId, [{ lineIndex: 0, acceptedQty: 4, rejectedQty: 0 }])));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 2, "4 + 4 fits in 10; a third delivery of 4 would not");
  assert.equal(await stock(p, ids.shop), 8);
  assert.equal((await sup(s3)).balance, 80000);
  assert.equal(await partyBal(s3), 80000);
  assert.equal((await db.collection("goodsReceipts").where("purchaseOrderId", "==", poId).get()).size, 2);
  // Simultaneous payments can't push a balance below zero without being advances.
  const pays = await Promise.allSettled(Array.from({ length: 4 }, () => pay(s3, 30000)));
  assert.equal(pays.filter((r) => r.status === "fulfilled").length, 2, "80,000 owed: two 30,000 payments fit, a third would not");
  assert.equal((await sup(s3)).balance, 20000);
});

test("supplier ledger: opening balance, purchases, payments, returns, refunds and adjustments with a running balance that matches the books", async () => {
  const rep = await dashboard.purchaseReportTables({ report: "ledger", from: "2020-01-01", to: TODAY, supplierId: ids.s2 });
  const t = rep.tables[0];
  assert.equal(t.rows[0].type, "Opening balance");
  let running = t.rows[0].balance;
  for (const r of t.rows.slice(1)) {
    running = running + (r.credit ?? 0) - (r.debit ?? 0);
    assert.equal(r.balance, running, `${r.type} ${r.ref}`);
  }
  assert.equal(t.totals.balance, (await sup(ids.s2)).balance);
  assert.deepEqual([...new Set(t.rows.map((r) => r.type))].sort(), ["Goods received", "Opening balance", "Payment", "Refund from supplier"].sort());
  const s1rep = (await dashboard.purchaseReportTables({ report: "ledger", from: "2020-01-01", to: TODAY, supplierId: ids.s1 })).tables[0];
  assert.deepEqual([...new Set(s1rep.rows.map((r) => r.type))].sort(), ["Adjustment", "Goods received", "Opening balance", "Return (credit note)"]);
  assert.equal(s1rep.totals.balance, (await sup(ids.s1)).balance);
  const later = (await dashboard.purchaseReportTables({ report: "ledger", from: "2999-01-01", to: "2999-01-31", supplierId: ids.s1 })).tables[0];
  assert.deepEqual([later.rows.length, later.rows[0].balance, later.totals.balance], [1, (await sup(ids.s1)).balance, (await sup(ids.s1)).balance], "a later period starts from the balance carried forward");
  await assert.rejects(dashboard.purchaseReportTables({ report: "ledger", from: TODAY, to: TODAY, supplierId: "ghost" }), (e) => e.code === "not-found");
  assert.equal(schemas.purchaseReportTablesInput.safeParse({ report: "ledger", from: TODAY, to: TODAY }).success, false, "a ledger needs a supplier");
});

test("the dashboard and report tables add up the saved records", async () => {
  const d = await dashboard.purchaseDashboard({ from: "2020-01-01", to: TODAY });
  const grns = (await db.collection("goodsReceipts").get()).docs.map((x) => x.data());
  const rets = (await db.collection("purchaseReturns").get()).docs.map((x) => x.data());
  const pays = (await db.collection("supplierPayments").get()).docs.map((x) => x.data());
  const allSup = (await db.collection("suppliers").get()).docs.map((x) => x.data());
  assert.equal(d.purchases, grns.reduce((n, g) => n + g.value, 0));
  assert.equal(d.receipts, grns.length);
  assert.equal(d.returns, rets.reduce((n, r) => n + r.value, 0));
  assert.equal(d.payments, pays.reduce((n, p) => n + p.amount, 0));
  assert.equal(d.payables, allSup.reduce((n, s) => n + Math.max(0, s.balance), 0));
  assert.equal(d.supplierCredits, allSup.reduce((n, s) => n + Math.max(0, -s.balance), 0));
  assert.equal(d.advancePayments, pays.reduce((n, p) => n + (p.advancePortion ?? 0), 0));
  assert.equal(d.refunds, 30000);
  assert.equal(d.recent.length, Math.min(10, grns.length));
  const ordered = await orderedPO(ids.s1, [line(ids.p2, 5, 20000)]);
  const d2 = await dashboard.purchaseDashboard({ from: "2020-01-01", to: TODAY });
  assert.equal(d2.pendingOrders.count, d.pendingOrders.count + 1, "an approved order counts as pending");
  assert.equal(d2.pendingOrders.value, d.pendingOrders.value + 100000);
  assert.equal(d2.purchases, d.purchases, "…but it is not a purchase until goods are received");
  await receive(ordered, [{ lineIndex: 0, acceptedQty: 2, rejectedQty: 0 }]);
  assert.equal((await dashboard.purchaseDashboard({ from: "2020-01-01", to: TODAY })).partiallyReceived.count, d.partiallyReceived.count + 1);
  const empty = await dashboard.purchaseDashboard({ from: "2001-01-01", to: "2001-01-31" });
  assert.deepEqual([empty.purchases, empty.returns, empty.payments, empty.recent.length > 0], [0, 0, 0, true], "no invented figures for an empty period (recent purchases are always the latest)");

  const tables = async (report) => (await dashboard.purchaseReportTables({ report, from: "2020-01-01", to: TODAY })).tables;
  const reg = await tables("register");
  assert.equal(reg[1].totals.value, grns.reduce((n, g) => n + g.value, 0) + 2 * 20000);
  assert.equal(reg[0].totals.total, (await db.collection("purchaseOrders").get()).docs.reduce((n, x) => n + x.data().total, 0));
  const bySup = (await tables("supplier"))[0];
  const fresh = (await db.collection("suppliers").get()).docs.map((x) => x.data());
  assert.equal(bySup.totals.outstanding, fresh.reduce((n, x) => n + x.balance, 0), "owed today = the supplier balances");
  const byProduct = (await tables("product"))[0];
  assert.ok(byProduct.rows.some((r) => r.product === "Oxford One" && r.units === 7 && r.returned === 2));
  assert.equal(byProduct.totals.value, reg[1].totals.value);
  const rr = (await tables("returns"))[0];
  assert.deepEqual([rr.rows.length, rr.rows[0].creditNote, rr.totals.value], [1, "CN-5521", 208000]);
  const out = (await tables("outstanding"))[0];
  assert.equal(out.totals.owed - out.totals.credit, fresh.reduce((n, x) => n + x.balance, 0), "owed less credits = the balances");
  assert.ok(out.rows.every((r) => r.owed > 0 || r.credit > 0));
  const grn = await tables("grn");
  assert.deepEqual(grn[1].rows.map((r) => [r.kind, r.qty]).sort(), [["Damaged", 2], ["Missing", 1]], "damaged and missing pairs are reported separately");
  assert.equal(grn[0].totals.rejected, 3);
});

test("accounting: purchases, payments, returns, refunds and adjustments each have one balanced journal; payables match the supplier balances; the trial balance balances", async () => {
  const js = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(js.every((j) => j.totalDebit === j.totalCredit && j.status === "posted"));
  for (const [collection, type] of [["goodsReceipts", "grn"], ["supplierPayments", "supplierpayment"], ["purchaseReturns", "purchasereturn"], ["supplierRefunds", "supplierrefund"], ["supplierAdjustments", "supplieradjustment"]]) {
    for (const d of (await db.collection(collection).get()).docs) assert.equal(js.filter((j) => j.id === `${type}__${d.id}`).length, 1, `${collection}/${d.data().number}`);
  }
  const sups = (await db.collection("suppliers").get()).docs;
  for (const s of sups) assert.equal(await partyBal(s.id), await booked(s.id), `${s.data().name}: payables ledger = supplier balance (less any unposted opening balance)`);
  assert.equal(-(await net("2010")), sups.reduce((n, x) => n + x.data().balance - (x.data().openingBalance ?? 0), 0), "the payables account = what the suppliers' balances add up to");
  const tb = await accReports.trialBalance({ from: "2000-01-01", to: TODAY });
  assert.equal(tb.balanced, true);
  assert.equal((await db.collection("accountingExceptions").get()).size, 0);
});

test("permissions: managing suppliers, paying, advances/refunds/adjustments, and reading reports each need their own permission", async () => {
  const range = { from: "2020-01-01", to: TODAY };
  for (const name of ["purchaseDashboard", "purchaseReportTables"]) {
    const data = name === "purchaseDashboard" ? range : { report: "register", ...range };
    assert.equal((await call(name, null, data)).status, 401);
    assert.equal((await call(name, "customer", data)).status, 403);
    assert.equal((await call(name, "reader", data)).status, 200, `${name} reader`);
  }
  const adj = { idempotencyKey: key(), supplierId: ids.s1, direction: "decrease", amount: 100, accountCode: "5020", reason: "Test only", date: TODAY };
  const ref = { idempotencyKey: key(), supplierId: ids.s2, amount: 100, method: "cash", receivedAt: TODAY };
  for (const t of ["reader", "buyer", "payer"]) {
    assert.equal((await call("recordSupplierAdjustment", t, adj)).status, 403, `${t} can't adjust`);
    assert.equal((await call("recordSupplierRefund", t, ref)).status, 403, `${t} can't take refunds`);
  }
  const pa = { idempotencyKey: key(), supplierId: ids.s2, amount: 1000, method: "cash", paidAt: TODAY, advance: true };
  assert.equal((await call("recordSupplierPayment", "payer", pa)).status, 403, "paying isn't the same as paying in advance");
  assert.equal((await call("recordSupplierPayment", "adjuster", pa)).status, 200, JSON.stringify((await call("recordSupplierPayment", "adjuster", { ...pa, idempotencyKey: key() })).body));
  assert.equal((await call("recordSupplierAdjustment", "adjuster", adj)).status, 200);
  assert.equal((await call("recordSupplierRefund", "adjuster", { ...ref, supplierId: ids.s2 })).status, 200);
  assert.equal((await call("saveSupplier", "payer", { name: "Nope Ltd" })).status, 403);
  const { authorizeBlobUpload } = await import("../../functions/services/images.js");
  const go = (name, pathname) => authorizeBlobUpload({ pathname, authorization: "Bearer x" }, { verifyToken: async () => TOKENS[name] });
  assert.ok((await go("buyer", "receipts/buyer-1/quote.pdf")).allowedContentTypes.includes("application/pdf"), "buyers can attach documents");
  await assert.rejects(go("reader", "receipts/reader-1/x.pdf"), /permission/i);
});
