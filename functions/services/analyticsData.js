/**
 * Data access for the analytics layer: bounded reads of real records, the line-level "facts" every sales report is built from,
 * and a carefully invalidated cache. Nothing here writes business data and nothing is estimated.
 *
 *   facts        one row per sold line: quantity, list value, discounts, net value and (when the sale's saved cost snapshot has it) cost.
 *                Costs come from `saleCosts`, the cost recorded WITH each sale, so a later cost change never rewrites history.
 *   counted      every sale except cancelled / returned / refunded ones (same rule as the sales report and the CRM).
 *   cache        `analyticsCache/{key}`: a finished result plus a "stamp" (the newest record in each source collection). A cached result is
 *                reused only while the stamp is unchanged and it is younger than 10 minutes, so a new sale, journal or stock movement
 *                shows up at once and a financial figure is never older than the records behind it.
 */
import { Timestamp } from "firebase-admin/firestore";
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { pktDateKey } from "../shared/accounting.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { configRef } from "./accounting.js";

export const MAX_DOCS = 5000;
export const startOf = (key) => Timestamp.fromDate(new Date(`${key}T00:00:00+05:00`));
export const endOf = (key) => Timestamp.fromDate(new Date(`${key}T23:59:59.999+05:00`));
export const dayOf = (t) => (t?.toDate ? pktDateKey(t.toDate()) : t ? pktDateKey(new Date(t)) : "");
export const col = (key, label, type = "text") => ({ key, label, type });
export const table = (title, columns, rows, totals = null) => ({ title, columns, rows, totals });
export const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
export const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Documents created in a date range, bounded, with a clear message when the range is too large. @returns {Promise<Record<string, any>[]>} */
export async function inRange(collection, from, to, field = "createdAt", limit = MAX_DOCS) {
  const snap = await db.collection(collection).where(field, ">=", startOf(from)).where(field, "<=", endOf(to)).orderBy(field).limit(limit + 1).get();
  if (snap.size > limit) throw new AppError("failed-precondition", `That range has more than ${limit} ${collection} records. Please choose a shorter range.`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Read documents by id in chunks (no per-document round trips). @param {string} collection @param {string[]} ids @returns {Promise<Map<string, Record<string, any>>>} */
export async function byIds(collection, ids) {
  const out = new Map();
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 300) {
    const snaps = await db.getAll(...unique.slice(i, i + 300).map((id) => db.collection(collection).doc(id)));
    for (const s of snaps) if (s.exists) out.set(s.id, /** @type {Record<string, any>} */ (s.data()));
  }
  return out;
}

/** The chart-of-accounts configuration, or null when accounting isn't set up. */
export async function accountingConfig() {
  const snap = await configRef().get();
  return snap.exists && snap.data()?.enabled ? snap.data() : null;
}

/** Product → category lookups for a set of product ids. @param {string[]} productIds */
export async function productMeta(productIds) {
  const [products, cats] = await Promise.all([byIds("products", productIds), db.collection("categories").limit(500).get()]);
  const catName = new Map(cats.docs.map((d) => [d.id, d.data().name]));
  /** @type {Map<string, { name: string, categoryId: string, categoryName: string }>} */
  const out = new Map();
  for (const [id, p] of products) out.set(id, { name: p.name, categoryId: p.categoryId ?? "", categoryName: catName.get(p.categoryId) ?? "Uncategorised" });
  return out;
}

/**
 * Sales in a range plus the saved cost snapshots, narrowed by the filters. Line filters (products, categories) keep only the matching lines.
 * @param {{ from: string, to: string }} range
 * @param {{ productIds?: string[], categoryIds?: string[], customerIds?: string[], paymentMethods?: string[], warehouseId?: string | null, channel?: string }} filters
 * @param {{ canSeeCost: boolean }} opts
 */
export async function loadFacts({ from, to }, filters = {}, { canSeeCost }) {
  const [salesAll, costAll] = await Promise.all([inRange("sales", from, to), canSeeCost ? inRange("saleCosts", from, to) : []]);
  const costs = new Map();
  for (const c of costAll) costs.set(c.id, c);
  const sales = salesAll.filter((s) => (!filters.channel || s.channel === filters.channel) && (!filters.paymentMethods?.length || filters.paymentMethods.includes(s.paymentMethod)) && (!filters.customerIds?.length || filters.customerIds.includes(s.customerId)) && (!filters.warehouseId || (s.warehouseIds ?? [s.warehouseId]).includes(filters.warehouseId)));
  const meta = await productMeta(sales.flatMap((s) => (s.lines ?? []).map((l) => l.productId)));
  const wantProducts = filters.productIds?.length ? new Set(filters.productIds) : null;
  const wantCategories = filters.categoryIds?.length ? new Set(filters.categoryIds) : null;
  const lineFilter = Boolean(wantProducts || wantCategories);
  /** @type {Record<string, any>[]} */
  const facts = [];
  /** @type {Record<string, any>[]} */
  const kept = [];
  for (const s of sales) {
    const counted = !UNCOUNTED_SALE_STATUSES.includes(s.status);
    const cost = costs.get(s.id);
    let any = false;
    (s.lines ?? []).forEach((l, i) => {
      const m = meta.get(l.productId);
      if ((wantProducts && !wantProducts.has(l.productId)) || (wantCategories && !wantCategories.has(m?.categoryId ?? ""))) return;
      any = true;
      const cl = cost?.costLines?.[i];
      facts.push({ saleId: s.id, number: s.number, date: dayOf(s.createdAt), counted, status: s.status, channel: s.channel, method: s.paymentMethod, cashierUid: s.cashierUid ?? null, cashierName: s.cashierName ?? null, customerId: s.customerId ?? null, warehouseIds: s.warehouseIds ?? [s.warehouseId], productId: l.productId, variantId: l.variantId, productName: l.productName, colour: l.colorName ?? "", size: l.sizeLabel ?? "", categoryId: m?.categoryId ?? "", categoryName: m?.categoryName ?? "Uncategorised", allocations: l.allocations ?? [], qty: l.qty, gross: (l.regularPrice ?? l.unitPrice) * l.qty, itemDiscount: l.itemDiscount ?? 0, couponShare: l.couponShare ?? 0, net: l.lineNet ?? l.lineTotal - (l.couponShare ?? 0), cost: cl?.costKnown ? cl.lineCost : null });
    });
    if (any || !lineFilter) kept.push(s);
  }
  return { sales: kept, facts, costs, lineFilter, canSeeCost };
}

/** Totals of the counted sales (sale level: includes tax and delivery in `total`). @param {Record<string, any>[]} sales */
export function saleTotals(sales) {
  const t = { orders: 0, units: 0, total: 0, gross: 0, itemDiscounts: 0, discounts: 0, net: 0, tax: 0, delivery: 0, returns: 0, returnedSales: 0 };
  for (const s of sales) {
    if (s.status !== "cancelled") t.returns += s.refundedTotal ?? 0;
    if (["returned", "refunded"].includes(s.status)) t.returnedSales += 1;
    if (UNCOUNTED_SALE_STATUSES.includes(s.status)) continue;
    t.orders += 1;
    t.units += s.itemCount ?? 0;
    t.total += s.total ?? 0;
    t.gross += s.grossSales ?? 0;
    t.itemDiscounts += s.itemDiscountTotal ?? 0;
    t.discounts += s.discountTotal ?? 0;
    t.net += s.netSales ?? 0;
    t.tax += s.taxTotal ?? 0;
    t.delivery += s.shippingTotal ?? 0;
  }
  return t;
}

/** Group facts by a key, summing the money / quantity columns. @param {Record<string, any>[]} facts @param {(f: Record<string, any>) => string} keyFn @returns {Record<string, any>[]} */
export function groupFacts(facts, keyFn) {
  /** @type {Map<string, Record<string, any>>} */
  const by = new Map();
  for (const f of facts) {
    if (!f.counted) continue;
    const k = keyFn(f);
    const r = by.get(k) ?? { key: k, units: 0, orders: new Set(), gross: 0, itemDiscount: 0, couponShare: 0, net: 0, costKnownNet: 0, cost: 0, lines: 0, linesWithoutCost: 0 };
    r.units += f.qty;
    r.orders.add(f.saleId);
    r.gross += f.gross;
    r.itemDiscount += f.itemDiscount;
    r.couponShare += f.couponShare;
    r.net += f.net;
    r.lines += 1;
    if (f.cost === null) r.linesWithoutCost += 1;
    else {
      r.cost += f.cost;
      r.costKnownNet += f.net;
    }
    by.set(k, r);
  }
  return [...by.values()].map((r) => ({ ...r, orders: r.orders.size, profit: r.costKnownNet - r.cost }));
}

/* ───────── Cache ───────── */

/** For each source: the collections (and the time fields) whose newest record tells us something changed. A record that is edited later (a refund, a status change) moves its `updatedAt`, so edits are noticed as well as new records. */
const SOURCES = {
  sales: [["sales", "createdAt"], ["sales", "updatedAt"]],
  journals: [["journalEntries", "createdAt"]],
  stock: [["stockMovements", "at"]],
  customers: [["crmCustomers", "createdAt"], ["crmCustomers", "updatedAt"]],
  purchases: [["goodsReceipts", "createdAt"]],
  payments: [["supplierPayments", "createdAt"]],
  expenses: [["financeEntries", "createdAt"], ["financeEntries", "updatedAt"]],
  adjustments: [["stockAdjustments", "createdAt"], ["stockAdjustments", "updatedAt"]],
  loyalty: [["loyaltyTransactions", "at"]],
  orders: [["purchaseOrders", "createdAt"], ["purchaseOrders", "updatedAt"]],
};

/** The newest record in each source, as one string. A new sale, journal, movement or edit changes it. @param {(keyof typeof SOURCES)[]} names */
async function stampOf(names) {
  const parts = await Promise.all(names.flatMap((n) => SOURCES[n].map(async ([c, f]) => {
    const s = await db.collection(c).orderBy(f, "desc").limit(1).get();
    return s.empty ? `${c}.${f}:0` : `${c}.${f}:${s.docs[0].id}:${s.docs[0].data()[f]?.toMillis?.() ?? 0}`;
  })));
  return parts.join("|");
}

const CACHE_MS = 10 * 60 * 1000;

/**
 * Return a fresh result, from the cache when nothing it depends on has changed in the last 10 minutes.
 * @template T
 * @param {string} key @param {(keyof typeof SOURCES)[]} sources @param {() => Promise<T>} compute @returns {Promise<T & { cached?: boolean }>}
 */
export async function cached(key, sources, compute) {
  const id = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400);
  const ref = db.collection("analyticsCache").doc(id);
  const [snap, stamp] = await Promise.all([ref.get(), stampOf(sources)]);
  const today = pktDateKey(new Date());
  if (snap.exists) {
    const c = snap.data();
    if (c.stamp === stamp && c.day === today && Date.now() - (c.at?.toMillis?.() ?? 0) < CACHE_MS) return { .../** @type {any} */ (JSON.parse(c.payload)), cached: true };
  }
  const result = await compute();
  const payload = JSON.stringify(result);
  if (payload.length < 900000) await ref.set({ stamp, day: today, at: FieldValue.serverTimestamp(), payload }).catch(() => {});
  return result;
}
