/**
 * Purchase report, computed from the real receipts, returns and payments in a date range (days are Pakistan
 * time, UTC+5, like the sales report). Nothing is stored separately, so it can't drift from the records.
 *
 *   Purchased   value of ACCEPTED goods received in the range (rejected goods are not purchases)
 *   Returned    value of goods sent back in the range
 *   Paid        supplier payments recorded in the range
 *   Payable     what the store owes suppliers right now (sum of balances; not a range figure)
 */
import { db, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";

const MAX_DOCS = 2000;
const SUPPLIER_LIMIT = 500;

/** @param {FirebaseFirestore.Query} q */
async function inRange(q, start, end) {
  const snap = await q.where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt").limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", `That range has more than ${MAX_DOCS} records. Please choose a shorter range.`);
  return snap.docs.map((d) => d.data());
}

/** @param {{ from: Date, to: Date }} range */
export async function purchaseReport({ from, to }) {
  const start = Timestamp.fromMillis(from.getTime());
  const end = Timestamp.fromMillis(to.getTime());
  const [receipts, returns, payments, suppliers] = await Promise.all([
    inRange(db.collection("goodsReceipts"), start, end),
    inRange(db.collection("purchaseReturns"), start, end),
    inRange(db.collection("supplierPayments"), start, end),
    db.collection("suppliers").limit(SUPPLIER_LIMIT + 1).get(),
  ]);
  if (suppliers.size > SUPPLIER_LIMIT) throw new AppError("failed-precondition", `There are more than ${SUPPLIER_LIMIT} suppliers; the report can't total them all.`);

  /** @type {Map<string, { supplierId: string, name: string, purchased: number, returned: number, paid: number }>} */
  const bySupplier = new Map();
  const row = (id, name) => {
    if (!bySupplier.has(id)) bySupplier.set(id, { supplierId: id, name, purchased: 0, returned: 0, paid: 0 });
    return /** @type {NonNullable<ReturnType<typeof bySupplier.get>>} */ (bySupplier.get(id));
  };
  /** @type {Map<string, { productId: string, variantId: string, name: string, label: string, units: number, value: number }>} */
  const items = new Map();
  let purchased = 0;
  let acceptedUnits = 0;
  let rejectedUnits = 0;
  for (const g of receipts) {
    purchased += g.value;
    acceptedUnits += g.acceptedUnits ?? 0;
    rejectedUnits += g.rejectedUnits ?? 0;
    row(g.supplierId, g.supplierName).purchased += g.value;
    for (const l of g.lines) {
      const k = `${l.productId}/${l.variantId}`;
      const it = items.get(k) ?? { productId: l.productId, variantId: l.variantId, name: l.productName, label: l.variantLabel, units: 0, value: 0 };
      it.units += l.acceptedQty;
      it.value += l.value;
      items.set(k, it);
    }
  }
  let returned = 0;
  for (const r of returns) {
    returned += r.value;
    row(r.supplierId, r.supplierName).returned += r.value;
  }
  let paid = 0;
  const byMethod = {};
  for (const p of payments) {
    paid += p.amount;
    row(p.supplierId, p.supplierName).paid += p.amount;
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
  }

  const owing = suppliers.docs.map((d) => ({ supplierId: d.id, name: d.data().name, balance: d.data().balance ?? 0, isActive: d.data().isActive !== false })).filter((s) => s.balance !== 0);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    purchased,
    returned,
    netPurchases: purchased - returned,
    paid,
    receipts: receipts.length,
    acceptedUnits,
    rejectedUnits,
    payable: owing.reduce((n, s) => n + s.balance, 0),
    paidByMethod: byMethod,
    bySupplier: [...bySupplier.values()].sort((a, b) => b.purchased - a.purchased),
    topItems: [...items.values()].sort((a, b) => b.value - a.value).slice(0, 10),
    owing: owing.sort((a, b) => b.balance - a.balance),
  };
}
