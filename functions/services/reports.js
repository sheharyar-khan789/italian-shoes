/**
 * Reports, computed from real orders and stock at request time. Nothing is estimated or stored
 * separately, so the numbers can't drift from the orders. Days are Pakistan time (UTC+5).
 *
 * Definitions (shown on screen too):
 *   Orders / Sales   orders placed in the range that are not cancelled
 *   Cash collected   COD cash recorded by staff, minus refunds
 *   Best sellers     units on non-cancelled, non-returned orders
 */
import { db, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";

const MAX_ORDERS = 5000;
const PKT_OFFSET_MS = 5 * 3600000;
export const pktDay = (ms) => new Date(ms + PKT_OFFSET_MS).toISOString().slice(0, 10);

/** @param {{ from: Date, to: Date }} range */
export async function salesReport({ from, to }) {
  const start = Timestamp.fromMillis(from.getTime());
  const end = Timestamp.fromMillis(to.getTime());
  const snap = await db.collection("orders").where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt").limit(MAX_ORDERS + 1).get();
  if (snap.size > MAX_ORDERS) throw new AppError("failed-precondition", `That range has more than ${MAX_ORDERS} orders. Please choose a shorter range.`);

  const byStatus = {};
  const daily = new Map();
  const products = new Map();
  const customers = new Set();
  let sales = 0;
  let discounts = 0;
  let orderCount = 0;
  let units = 0;

  for (const d of snap.docs) {
    const o = d.data();
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    if (o.status === "cancelled") continue;
    orderCount += 1;
    sales += o.grandTotal;
    discounts += o.discountTotal ?? 0;
    customers.add(o.userId);
    const day = pktDay(o.createdAt.toMillis());
    const row = daily.get(day) ?? { day, orders: 0, sales: 0 };
    row.orders += 1;
    row.sales += o.grandTotal;
    daily.set(day, row);
    if (o.status === "returned" || o.status === "refunded") continue;
    for (const l of o.items) {
      units += l.qty;
      const p = products.get(l.productId) ?? { productId: l.productId, name: l.productName, units: 0, revenue: 0 };
      p.units += l.qty;
      p.revenue += l.lineTotal;
      products.set(l.productId, p);
    }
  }

  // Cash actually collected / refunded in the same range (by order date).
  let collected = 0;
  let refunded = 0;
  const pays = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).limit(MAX_ORDERS + 1).get();
  for (const p of pays.docs) {
    const txs = await p.ref.collection("transactions").get();
    for (const t of txs.docs) {
      if (t.data().type === "collection") collected += t.data().amount;
      if (t.data().type === "refund") refunded += t.data().amount;
    }
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    orders: orderCount,
    sales,
    discounts,
    averageOrder: orderCount ? Math.round(sales / orderCount) : 0,
    customers: customers.size,
    units,
    cashCollected: collected - refunded,
    byStatus,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    bestSellers: [...products.values()].sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, 10),
  };
}

/** Stock position: what's out, what's low (uses the owner's threshold), total units on hand. */
export async function inventoryReport() {
  const [inv, priv] = await Promise.all([db.collection("inventory").get(), db.doc("settings/private").get()]);
  const threshold = priv.data()?.lowStockThreshold ?? 0;
  const rows = inv.docs.map((d) => { const [productId, variantId] = d.id.split("__"); return { productId, variantId, onHand: d.data().onHand ?? 0, reserved: d.data().reserved ?? 0 }; });
  return {
    threshold,
    variants: rows.length,
    unitsOnHand: rows.reduce((n, r) => n + r.onHand, 0),
    outOfStock: rows.filter((r) => r.onHand <= 0),
    lowStock: rows.filter((r) => r.onHand > 0 && r.onHand <= threshold),
  };
}
