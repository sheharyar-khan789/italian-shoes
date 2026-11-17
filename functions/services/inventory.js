/**
 * Stock. The ONLY code that changes inventory. Used for manual adjustments (below), by the order service
 * for sales, cancellations and returns, and by transfers (services/transfers.js), so every path obeys the
 * same rules.
 *
 * One inventory document per size/colour, with the quantity of every warehouse inside it:
 *
 *   inventory/{productId}__{variantId}
 *     byWarehouse   { [warehouseId]: { onHand, reserved } }     ← the truth, per warehouse
 *     onHand        online-eligible warehouses added together   ← what the shop and checkout use
 *     reserved      same, reserved
 *     available     onHand − reserved (kept so lists can filter on it)
 *     totalOnHand   every warehouse added together
 *
 * A document written before warehouses existed has no `byWarehouse`: all its stock is read as being in the
 * default warehouse ("main"), so existing stock and checkout keep working before and after the migration
 * (functions/migrations/002-warehouse-inventory.js). Every change:
 *   - happens in a Firestore transaction, so two changes at once can't lose an update;
 *   - refuses to take a warehouse below zero or below what is reserved there;
 *   - writes append-only stockMovements records (warehouse, source, who, how much, before → after, why);
 *   - keeps the variant's public `available` and the product's public summary in step (no re-reading);
 *   - raises a notification when a variant crosses the low-stock level or runs out.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import { DEFAULT_WAREHOUSE_ID } from "../shared/schemas/warehouses.js";
import { inventoryId } from "./products.js";
import { markCatalogDirty } from "./catalogSnapshot.js";

export { DEFAULT_WAREHOUSE_ID };

/** Reasons that put stock back (they may return it to a warehouse that has since been switched off). */
const RESTOCK_REASONS = new Set(["cancellation", "return"]);

/* ───────── Warehouses (as stock sees them) ───────── */

/** @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs */
export function warehouseMap(docs) {
  /** @type {Map<string, Record<string, any>>} */
  const map = new Map(docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  // Before the migration creates the default warehouse document, it still exists in effect.
  if (!map.has(DEFAULT_WAREHOUSE_ID)) map.set(DEFAULT_WAREHOUSE_ID, { id: DEFAULT_WAREHOUSE_ID, name: "Main warehouse", code: "MAIN", isActive: true, sellsOnline: true, isDefault: true, virtual: true });
  return map;
}

/** Read every warehouse inside a transaction (there are only a few). @param {FirebaseFirestore.Transaction} tx */
export async function readWarehouses(tx) {
  return warehouseMap((await tx.get(db.collection("warehouses"))).docs);
}

/** Stock in this warehouse counts as available to online customers. */
export const isOnline = (w) => Boolean(w) && w.isActive !== false && w.sellsOnline !== false;

/* ───────── Reading ───────── */

/**
 * Read everything a stock change needs. Call BEFORE any write in the transaction.
 * @param {FirebaseFirestore.Transaction} tx
 */
export async function readStock(tx, productId, variantId) {
  const invRef = db.collection("inventory").doc(inventoryId(productId, variantId));
  const productRef = db.collection("products").doc(productId);
  const variantRef = productRef.collection("variants").doc(variantId);
  const [inv, variant, product] = await Promise.all([tx.get(invRef), tx.get(variantRef), tx.get(productRef)]);
  return { productId, variantId, invRef, variantRef, inv, variant, product };
}

/** Units a customer could buy right now (online-eligible warehouses). */
export const availableOf = (stock) => (stock.inv.exists ? stock.inv.data().onHand - stock.inv.data().reserved : 0);

/**
 * Per-warehouse quantities of an inventory document (a copy). Legacy documents count as all in the default warehouse.
 * @param {FirebaseFirestore.DocumentSnapshot} inv
 * @returns {Record<string, { onHand: number, reserved: number }>}
 */
export function entriesOf(inv) {
  const d = inv.data();
  if (d.byWarehouse) return Object.fromEntries(Object.entries(d.byWarehouse).map(([id, e]) => [id, { onHand: e.onHand ?? 0, reserved: e.reserved ?? 0 }]));
  return { [DEFAULT_WAREHOUSE_ID]: { onHand: d.onHand ?? 0, reserved: d.reserved ?? 0 } };
}

/** @param {Record<string, { onHand: number, reserved: number }>} entries @param {Map<string, any>} warehouses */
export function totalsOf(entries, warehouses) {
  let onHand = 0;
  let reserved = 0;
  let totalOnHand = 0;
  for (const [id, e] of Object.entries(entries)) {
    totalOnHand += e.onHand;
    if (isOnline(warehouses.get(id))) {
      onHand += e.onHand;
      reserved += e.reserved;
    }
  }
  return { onHand, reserved, available: onHand - reserved, totalOnHand };
}

/** Where a sale takes its pairs from: the default warehouse first, then the other online warehouses by code. */
function allocateOnline(entries, warehouses, qty) {
  const order = [...warehouses.values()]
    .filter(isOnline)
    .sort((a, b) => Number(b.id === DEFAULT_WAREHOUSE_ID) - Number(a.id === DEFAULT_WAREHOUSE_ID) || String(a.code).localeCompare(String(b.code)));
  /** @type {{ warehouseId: string, change: number }[]} */
  const out = [];
  let left = qty;
  for (const w of order) {
    const e = entries[w.id];
    const free = e ? e.onHand - e.reserved : 0;
    if (free <= 0) continue;
    const take = Math.min(free, left);
    out.push({ warehouseId: w.id, change: -take });
    left -= take;
    if (!left) break;
  }
  if (left) throw new AppError("failed-precondition", "That isn't in stock any more.");
  return out;
}

/* ───────── Context: warehouses + the product summaries touched by one transaction ───────── */

/**
 * @param {Map<string, any>} warehouses
 * @returns {{ warehouses: Map<string, any>, summaries: Map<string, { ref: FirebaseFirestore.DocumentReference, summary: any }> }}
 */
export const createStockContext = (warehouses) => ({ warehouses, summaries: new Map() });

/** Keep the product's public stock summary in step with one variant, without re-reading anything. */
function patchSummary(ctx, stock, available) {
  const variant = stock.variant.data();
  if (!variant.isActive || !stock.product.exists) return;
  const pid = stock.productId;
  const entry = ctx.summaries.get(pid) ?? { ref: stock.product.ref, summary: structuredClone(stock.product.data().summary ?? {}) };
  const s = entry.summary;
  s.stock ??= {};
  (s.stock[variant.colorId] ??= {})[variant.sizeId] = Math.max(0, available);
  let total = 0;
  const sizes = new Set();
  for (const bySize of Object.values(s.stock)) {
    for (const [sizeId, n] of Object.entries(bySize)) {
      total += n;
      if (n > 0) sizes.add(sizeId);
    }
  }
  s.totalStock = total;
  s.inStock = total > 0;
  s.sizeIds = [...sizes];
  ctx.summaries.set(pid, entry);
}

/** Write the summaries gathered by writeStockChange (once per product) and tell the shop its catalog changed. */
export function flushStockContext(tx, ctx) {
  for (const { ref, summary } of ctx.summaries.values()) tx.update(ref, { summary });
  if (ctx.summaries.size) markCatalogDirty(tx);
}

/* ───────── Writing ───────── */

/**
 * Apply a stock change inside a transaction (writes only; `stock` comes from readStock).
 * Which warehouse(s): `allocations` (put back where an order took them from), else `warehouseId`, else for a
 * sale the online warehouses (default first), else the default warehouse.
 * @param {FirebaseFirestore.Transaction} tx
 * @param {Awaited<ReturnType<typeof readStock>>} stock
 * `allocations` hold positive pair counts per warehouse (what a sale took, or what a return puts back).
 * @param {{
 *   change: number, reason: string, note?: string, orderId?: string | null, actorUid: string, settings?: Record<string, any> | undefined,
 *   ctx: ReturnType<typeof createStockContext>, warehouseId?: string | null, allocations?: { warehouseId: string, qty: number }[] | null,
 *   sourceType?: string, sourceId?: string | null,
 * }} change
 */
export function writeStockChange(tx, stock, { change, reason, note = "", orderId = null, actorUid, settings, ctx, warehouseId = null, allocations = null, sourceType = "adjustment", sourceId = null }) {
  const { inv, variant, product, invRef, variantRef, productId, variantId } = stock;
  if (!inv.exists || !variant.exists) throw new AppError("not-found", "That size/colour no longer exists.");
  const { warehouses } = ctx;

  /** @type {{ warehouseId: string, change: number }[]} */
  let moves;
  if (allocations?.length) moves = allocations.map((a) => ({ warehouseId: a.warehouseId, change: Math.sign(change) * a.qty }));
  else if (warehouseId) moves = [{ warehouseId, change }];
  else if (change < 0) moves = allocateOnline(entriesOf(inv), warehouses, -change);
  else moves = [{ warehouseId: DEFAULT_WAREHOUSE_ID, change }];
  if (moves.reduce((n, m) => n + m.change, 0) !== change) throw new AppError("internal", "Stock allocation doesn't add up.");

  const entries = entriesOf(inv);
  const before = totalsOf(entries, warehouses);
  /** @type {{ warehouseId: string, change: number, before: number, after: number }[]} */
  const applied = [];
  for (const m of moves) {
    const w = warehouses.get(m.warehouseId);
    if (!w) throw new AppError("invalid-argument", "That warehouse doesn't exist.");
    if (w.isActive === false && !RESTOCK_REASONS.has(reason)) throw new AppError("failed-precondition", `${w.name} is switched off, so its stock can't be changed.`);
    const e = (entries[m.warehouseId] ??= { onHand: 0, reserved: 0 });
    const next = e.onHand + m.change;
    if (next < 0) throw new AppError("failed-precondition", `Only ${e.onHand} in stock in ${w.name} — you can't remove ${-m.change}.`);
    if (next < e.reserved) throw new AppError("failed-precondition", `${e.reserved} of these are reserved for pending orders in ${w.name}, so stock can't go below ${e.reserved}.`);
    applied.push({ warehouseId: m.warehouseId, change: m.change, before: e.onHand, after: next });
    e.onHand = next;
  }
  const after = totalsOf(entries, warehouses);

  tx.update(invRef, { byWarehouse: entries, onHand: after.onHand, reserved: after.reserved, available: after.available, totalOnHand: after.totalOnHand, updatedAt: FieldValue.serverTimestamp() });
  tx.update(variantRef, { available: after.available });
  for (const a of applied) {
    tx.create(db.collection("stockMovements").doc(), {
      inventoryId: invRef.id,
      productId,
      variantId,
      warehouseId: a.warehouseId,
      productName: product.data()?.name ?? "",
      variantLabel: `${variant.data().colorName ?? ""} / ${variant.data().sizeLabel ?? ""}`,
      sku: variant.data().sku,
      change: a.change,
      quantity: Math.abs(a.change),
      onHandBefore: a.before,
      onHandAfter: a.after,
      reason,
      sourceType,
      sourceId: sourceId ?? orderId,
      note,
      orderId,
      actorUid,
      at: FieldValue.serverTimestamp(),
    });
  }
  patchSummary(ctx, stock, after.available);

  // Alerts when the online-available count crosses a line (not on every change below it).
  const threshold = inv.data().lowStockThreshold ?? settings?.lowStockThreshold ?? null;
  const wantsAlerts = settings?.notifyLowStock !== false;
  const label = `${product.data()?.name ?? "Product"} — ${variant.data().colorName ?? ""} ${variant.data().sizeLabel ?? ""}`.trim();
  const was = before.available;
  const now = after.available;
  if (wantsAlerts && variant.data().isActive) {
    if (now === 0 && was > 0) {
      notify({ type: "stock.out", audience: "inventory.adjust", title: `Sold out: ${label}`, link: "/admin/inventory", data: { productId, variantId } }, tx);
    } else if (threshold !== null && now > 0 && now <= threshold && was > threshold) {
      notify({ type: "stock.low", audience: "inventory.adjust", title: `Low stock (${now} left): ${label}`, link: "/admin/inventory", data: { productId, variantId, available: now } }, tx);
    }
  }
  return { onHand: after.onHand, available: now, allocations: applied.map((a) => ({ warehouseId: a.warehouseId, qty: Math.abs(a.change) })) };
}

/**
 * Manual stock adjustment by staff.
 * @param {{ productId: string, variantId: string, warehouseId?: string, change: number, reason: string, note?: string }} input validated stockAdjustmentSchema
 * @param {string} actorUid
 */
export async function adjustStock(input, actorUid) {
  const { productId, variantId, change, reason, note = "" } = input;
  const warehouseId = input.warehouseId ?? DEFAULT_WAREHOUSE_ID;
  const settingsRef = db.collection("settings").doc("private");

  return db.runTransaction(async (tx) => {
    const [stock, settings, warehouses] = await Promise.all([readStock(tx, productId, variantId), tx.get(settingsRef), readWarehouses(tx)]);
    const ctx = createStockContext(warehouses);
    const result = writeStockChange(tx, stock, { change, reason, note, actorUid, settings: settings.data(), ctx, warehouseId, sourceType: "adjustment" });
    flushStockContext(tx, ctx);
    return { onHand: result.onHand, available: result.available };
  });
}

/* ───────── Recalculating the online totals ───────── */

/**
 * After a warehouse's "sells online" setting changes, recalculate the online totals of inventory documents.
 * Works through the collection one page at a time (call again with the returned cursor until it is null), each
 * document in its own transaction, so orders can carry on meanwhile. Quantities per warehouse never change.
 * @param {{ cursor?: string | null }} input
 * @returns {Promise<{ processed: number, changed: number, nextCursor: string | null }>}
 */
export async function rebuildOnlineStock({ cursor = null } = {}) {
  const PAGE = 100;
  let q = db.collection("inventory").orderBy("__name__").limit(PAGE);
  if (cursor) q = q.startAfter(db.collection("inventory").doc(cursor));
  const page = await q.get();
  let changed = 0;

  /** @param {FirebaseFirestore.QueryDocumentSnapshot} doc */
  const one = async (doc) => {
    const { productId, variantId } = doc.data();
    if (!productId || !variantId) return;
    await db.runTransaction(async (tx) => {
      const [stock, warehouses] = await Promise.all([readStock(tx, productId, variantId), readWarehouses(tx)]);
      if (!stock.inv.exists) return;
      const entries = entriesOf(stock.inv);
      const t = totalsOf(entries, warehouses);
      const d = stock.inv.data();
      if (d.onHand === t.onHand && d.reserved === t.reserved && d.available === t.available && d.totalOnHand === t.totalOnHand && d.byWarehouse) return;
      const ctx = createStockContext(warehouses);
      tx.update(stock.invRef, { byWarehouse: entries, onHand: t.onHand, reserved: t.reserved, available: t.available, totalOnHand: t.totalOnHand });
      if (stock.variant.exists) {
        tx.update(stock.variantRef, { available: t.available });
        patchSummary(ctx, stock, t.available);
      }
      flushStockContext(tx, ctx);
      changed += 1;
    });
  };
  for (let i = 0; i < page.docs.length; i += 10) await Promise.all(page.docs.slice(i, i + 10).map(one));
  return { processed: page.size, changed, nextCursor: page.size === PAGE ? page.docs[page.size - 1].id : null };
}
