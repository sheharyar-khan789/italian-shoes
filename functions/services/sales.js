/**
 * Sales: the one record of every sale, whatever channel it came from. The ONLY code that creates a sale or
 * changes its status and payment summary (the order and payment services call it inside their own
 * transactions, so a sale can never disagree with its order).
 *
 *   sales/{id}        the sale: snapshot of lines, prices, discounts, delivery, totals, payment summary, status
 *   saleCosts/{id}    the cost snapshot of those lines and the gross profit (separate so rules can keep cost
 *                     away from staff who may only see sales; read needs costs.read)
 *   counters/sales    { next }   (SL-000001 …)
 *
 * An ONLINE sale has the same id as its order (sales/{orderId}), created in the very transaction that creates
 * the order (and takes the stock). That makes "exactly one sale per order" a property of the database, not of
 * careful code: creating the same id twice fails, and the order's idempotency record makes a retried request
 * return early before anything is written. A POS sale (future) will have its own id; nothing in the POS screens
 * is built yet.
 *
 * Stock is NOT touched here. The stock service deducts and restocks (once, in the order transaction); the sale
 * records where each pair came from. Money is whole paisa; every sale is checked by saleSchema before it is saved.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { saleSchema } from "../shared/schemas/sales.js";
import { computeSaleLines, costTotals, salePaymentFields } from "../shared/sales.js";
import { DEFAULT_WAREHOUSE_ID } from "../shared/schemas/warehouses.js";

export const saleRef = (id) => db.collection("sales").doc(id);
const costRef = (id) => db.collection("saleCosts").doc(id);
export const salesCounter = () => db.collection("counters").doc("sales");

/** The next sale number from the counter snapshot read in the transaction. @param {FirebaseFirestore.DocumentSnapshot} counter */
export function nextSaleNumber(counter) {
  const seq = (counter.exists ? counter.data().next : 1) ?? 1;
  return { number: `SL-${String(seq).padStart(6, "0")}`, nextValue: seq + 1 };
}

/**
 * Build (and validate) a sale and its cost snapshot from an order.
 * @param {Record<string, any>} order the order as saved: items, totals, customer, address, status, payment fields
 * @param {{ orderId: string, number: string, unitCosts: (number | null | undefined)[], allocations: ({ warehouseId: string, qty: number }[] | null | undefined)[], actorUid: string, idempotencyKey: string | null, pay: Record<string, any> }} ctx
 */
export function saleFromOrder(order, { orderId, number, unitCosts, allocations, actorUid, idempotencyKey, pay }) {
  const { lines, costLines } = computeSaleLines(order.items, order.discountTotal ?? 0, unitCosts, allocations, DEFAULT_WAREHOUSE_ID);
  const warehouseIds = [...new Set(lines.flatMap((l) => l.allocations.map((a) => a.warehouseId)))];
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const discountTotal = order.discountTotal ?? 0;
  const netSales = subtotal - discountTotal;
  const parsed = saleSchema.safeParse({
    number,
    channel: "online",
    orderId,
    orderNumber: order.number,
    customerId: order.userId ?? null,
    customer: order.customer ? { name: order.customer.name ?? "", phone: order.customer.phone ?? "", email: order.customer.email ?? null } : null,
    customerPhone: order.customer?.phone ?? null,
    address: order.address ?? null,
    shippingMethod: order.shippingMethod ?? null,
    warehouseId: warehouseIds[0],
    warehouseIds,
    lines,
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
    grossSales: lines.reduce((n, l) => n + l.regularPrice * l.qty, 0),
    itemDiscountTotal: lines.reduce((n, l) => n + l.itemDiscount, 0),
    subtotal,
    discountTotal,
    couponCode: order.couponCode ?? null,
    netSales,
    taxTotal: order.taxTotal ?? 0,
    shippingTotal: order.shippingTotal ?? 0,
    total: order.grandTotal,
    paymentMethod: order.paymentMethod ?? "cod",
    ...salePaymentFields(pay),
    status: order.status,
    stockApplied: true,
    idempotencyKey,
    createdBy: actorUid,
  });
  if (!parsed.success) {
    // A sale that doesn't add up is a bug in the caller, never something to store.
    throw new AppError("internal", `Sale ${number} failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { sale: parsed.data, saleCost: { costLines, ...costTotals(costLines, netSales) } };
}

/**
 * Build (and validate) a walk-in (POS) sale and its cost snapshot. Prices, discounts and costs are those the server
 * worked out; nothing here comes from the browser.
 * @param {{ number: string, items: any[], discountTotal: number, taxTotal: number, total: number, unitCosts: (number | null | undefined)[], allocations: ({ warehouseId: string, qty: number }[] | null | undefined)[], customerId: string | null, customer: { name: string, phone: string, email: string | null } | null, sessionId: string, cashier: { uid: string, name: string }, idempotencyKey: string, paymentMethod: string, tenders: any[], note: string, offline?: { offlineId: string, recordedAt: string } | null, loyalty?: Record<string, any> | null, crmDiscount?: Record<string, any> | null }} p
 */
export function saleForPos(p) {
  const { lines, costLines } = computeSaleLines(p.items, p.discountTotal, p.unitCosts, p.allocations, DEFAULT_WAREHOUSE_ID);
  const warehouseIds = [...new Set(lines.flatMap((l) => l.allocations.map((a) => a.warehouseId)))];
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const netSales = subtotal - p.discountTotal;
  const parsed = saleSchema.safeParse({
    number: p.number,
    channel: "pos",
    orderId: null,
    orderNumber: null,
    customerId: p.customerId,
    customer: p.customer,
    customerPhone: p.customer?.phone || null,
    address: null,
    shippingMethod: null,
    warehouseId: warehouseIds[0],
    warehouseIds,
    lines,
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
    grossSales: lines.reduce((n, l) => n + l.regularPrice * l.qty, 0),
    itemDiscountTotal: lines.reduce((n, l) => n + l.itemDiscount, 0),
    subtotal,
    discountTotal: p.discountTotal,
    couponCode: null,
    netSales,
    taxTotal: p.taxTotal,
    shippingTotal: 0,
    total: p.total,
    paymentMethod: p.paymentMethod,
    paymentStatus: "pending",
    paidTotal: 0,
    refundedTotal: 0,
    amountDue: p.total,
    status: "completed",
    stockApplied: true,
    idempotencyKey: p.idempotencyKey,
    createdBy: p.cashier.uid,
    sessionId: p.sessionId,
    cashierUid: p.cashier.uid,
    cashierName: p.cashier.name,
    pos: { tenders: p.tenders, note: p.note, ...(p.offline ? { offline: p.offline } : {}) },
    loyalty: p.loyalty ?? null,
    crmDiscount: p.crmDiscount ?? null,
  });
  if (!parsed.success) throw new AppError("internal", `POS sale ${p.number} failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { sale: parsed.data, saleCost: { costLines, ...costTotals(costLines, netSales) } };
}

/**
 * Write a sale and its cost snapshot inside a transaction. `createdAt`/`updatedAt` default to now; the backfill
 * passes the order's own dates so history keeps its original timing.
 * @param {FirebaseFirestore.Transaction} tx
 */
export function createSale(tx, id, { sale, saleCost }, { createdAt = FieldValue.serverTimestamp(), updatedAt = createdAt } = {}) {
  tx.create(saleRef(id), { ...sale, createdAt, updatedAt, updatedBy: sale.createdBy });
  tx.create(costRef(id), { saleId: id, number: sale.number, channel: sale.channel, status: sale.status, netSales: sale.netSales, ...saleCost, createdAt });
}

/**
 * Change a sale from inside the transaction that changes its order or payment. Does nothing when the sale
 * doesn't exist (orders placed before sales were introduced have none until the backfill creates it).
 * @param {FirebaseFirestore.Transaction} tx @param {FirebaseFirestore.DocumentSnapshot | null | undefined} saleSnap
 * @param {Record<string, any>} patch @param {string} actorUid
 */
export function syncSale(tx, saleSnap, patch, actorUid) {
  if (!saleSnap?.exists) return;
  tx.update(saleSnap.ref, { ...patch, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
  // The cost record carries the status so reports can skip cancelled sales without reading the sale itself.
  if (patch.status) tx.update(costRef(saleSnap.id), { status: patch.status });
}

/** What changes on the sale when its order moves to a new status. @param {string} to */
export const statusPatch = (to) => ({ status: to, [`${to}At`]: FieldValue.serverTimestamp() });

/** What changes on the sale when its payment record changes. @param {Record<string, any>} pay */
export const paymentPatch = (pay) => salePaymentFields(pay);
