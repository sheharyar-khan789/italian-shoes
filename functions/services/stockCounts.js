/**
 * Physical stock counts. One open count per warehouse (stockCountLocks/{warehouseId}), so two sessions can't count the
 * same shelf. Each counted line remembers the system quantity AT THE MOMENT it was counted; applying the count then
 * changes stock by (counted − that quantity), not by overwriting the stock with the counted number. A sale or receipt
 * that happened after the count is therefore kept, never erased.
 *
 *   counting ──submit──▶ submitted ──approve──▶ approved ──apply──▶ applied
 *                              └──reject──▶ rejected          cancel (before anything is applied) ──▶ cancelled
 *
 * Applying works through the lines in small transactions (idempotent: each line is marked as it is applied) through the
 * stock service, with a write-off / gain journal per line at the average cost. A line that can no longer be applied
 * (it would take stock below zero or below what is reserved) is flagged for a person and left alone.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext, entriesOf } from "./inventory.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { stockAdjustmentSpec } from "./accountingRules.js";
import { inventoryId } from "./products.js";

const counts = () => db.collection("stockCounts");
const lockRef = (wid) => db.collection("stockCountLocks").doc(wid);
const BATCH = 25;
const PREFILL_MAX = 300;

/** @typedef {{ uid: string, name: string }} Actor */
const note = (doc, action, actor, text = "") => [...(doc?.history ?? []), { at: new Date().toISOString(), byUid: actor.uid, byName: actor.name, action, note: text }].slice(-30);
const keyOf = (productId, variantId) => `${productId}__${variantId}`;

/** Start a count of one warehouse; optionally list every variant the system says it holds. @param {{ idempotencyKey: string, warehouseId: string, name?: string, prefill?: boolean }} input @param {Actor} actor */
export async function startCount({ idempotencyKey, warehouseId, name = "", prefill = true }, actor) {
  const idemRef = db.collection("idempotency").doc(`count__${actor.uid}__${idempotencyKey}`);
  const ref = counts().doc();
  const counterRef = db.collection("counters").doc("stockCounts");
  /** @type {Record<string, any>} */
  const lines = {};
  if (prefill) {
    const inv = await db.collection("inventory").limit(2000).get();
    const held = inv.docs.map((d) => ({ d, e: entriesOf(/** @type {any} */ ({ exists: true, data: () => d.data() }))[warehouseId] })).filter((x) => (x.e?.onHand ?? 0) > 0).slice(0, PREFILL_MAX);
    if (held.length) {
      const variantRefs = held.map(({ d }) => db.collection("products").doc(d.data().productId ?? d.id.split("__")[0]).collection("variants").doc(d.data().variantId ?? d.id.split("__")[1]));
      const productIds = [...new Set(variantRefs.map((r) => r.parent.parent.id))];
      const [vs, ps] = await Promise.all([db.getAll(...variantRefs), db.getAll(...productIds.map((id) => db.collection("products").doc(id)))]);
      const pname = new Map(ps.map((p) => [p.id, p.data()?.name ?? ""]));
      vs.forEach((v, i) => {
        if (!v.exists) return;
        const productId = variantRefs[i].parent.parent.id;
        lines[keyOf(productId, v.id)] = { productId, variantId: v.id, productName: pname.get(productId), variantLabel: `${v.data().colorName ?? ""} / ${v.data().sizeLabel ?? ""}`, sku: v.data().sku ?? "", systemQty: held[i].e.onHand, countedQty: null, variance: null, unitCost: null };
      });
    }
  }
  return db.runTransaction(async (tx) => {
    const [idem, lock, warehouses, counter] = await Promise.all([tx.get(idemRef), tx.get(lockRef(warehouseId)), readWarehouses(tx), tx.get(counterRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const wh = warehouses.get(warehouseId);
    if (!wh) throw new AppError("invalid-argument", "Choose a warehouse that exists.", { fields: { warehouseId: "Not found" } });
    if (wh.isActive === false) throw new AppError("failed-precondition", `${wh.name} is switched off.`);
    if (lock.exists) throw new AppError("failed-precondition", `A count of ${wh.name} is already open (${lock.data().number}). Finish or cancel it first.`, { fields: { warehouseId: "A count is already open" } });
    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `CNT-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    tx.create(ref, { number, warehouseId, warehouseName: wh.name, name, status: "counting", lines, startedBy: actor.uid, startedByName: actor.name, history: note(null, "started", actor, name), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(lockRef(warehouseId), { sessionId: ref.id, number, at: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "stock.count_started", entityType: "stockCount", entityId: ref.id, changes: { number, warehouseId, lines: Object.keys(lines).length } }, tx);
    const result = { id: ref.id, number, lines: Object.keys(lines).length };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/** Record what was physically counted for one variant. The system quantity is read now and kept with the line. @param {{ sessionId: string, productId: string, variantId: string, countedQty: number }} input @param {Actor} actor */
export async function saveCountLine({ sessionId, productId, variantId, countedQty }, actor) {
  const ref = counts().doc(sessionId);
  return db.runTransaction(async (tx) => {
    const [snap, stock, cost] = await Promise.all([tx.get(ref), readStock(tx, productId, variantId), tx.get(db.collection("variantCosts").doc(inventoryId(productId, variantId)))]);
    if (!snap.exists) throw new AppError("not-found", "That count doesn't exist.");
    const s = snap.data();
    if (s.status !== "counting") throw new AppError("failed-precondition", `This count is ${s.status}; lines can only be changed while counting.`);
    if (!stock.inv.exists || !stock.variant.exists) throw new AppError("not-found", "That size/colour doesn't exist.");
    const systemQty = entriesOf(stock.inv)[s.warehouseId]?.onHand ?? 0;
    const line = { productId, variantId, productName: stock.product.data()?.name ?? "", variantLabel: `${stock.variant.data().colorName ?? ""} / ${stock.variant.data().sizeLabel ?? ""}`, sku: stock.variant.data().sku ?? "", systemQty, countedQty, variance: countedQty - systemQty, unitCost: cost.exists ? cost.data().costPrice ?? null : null, countedBy: actor.uid, countedAt: new Date().toISOString() };
    tx.update(ref, { [`lines.${keyOf(productId, variantId)}`]: line, updatedAt: FieldValue.serverTimestamp() });
    return { systemQty, countedQty, variance: line.variance };
  });
}

const summarise = (lines) => {
  const counted = Object.values(lines).filter((l) => l.countedQty !== null && l.countedQty !== undefined);
  return {
    counted: counted.length,
    withVariance: counted.filter((l) => l.variance !== 0).length,
    shortUnits: counted.filter((l) => l.variance < 0).reduce((n, l) => n - l.variance, 0),
    overUnits: counted.filter((l) => l.variance > 0).reduce((n, l) => n + l.variance, 0),
    varianceValue: counted.reduce((n, l) => n + (l.unitCost === null ? 0 : l.variance * l.unitCost), 0),
    withoutCost: counted.filter((l) => l.variance !== 0 && l.unitCost === null).length,
  };
};

/** @param {string} id @param {Actor} actor @param {{ from: string[], to: string, action: string, extra?: (s: any) => any }} o */
async function transition(id, actor, { from, to, action, extra = () => ({}) }) {
  const ref = counts().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That count doesn't exist.");
    const s = snap.data();
    if (s.status === to) return { id, status: to, existing: true };
    if (!from.includes(s.status)) throw new AppError("failed-precondition", `A count that is ${s.status} can't be ${action}.`);
    const more = extra(s);
    const lock = to === "rejected" || to === "cancelled" ? lockRef(s.warehouseId) : null;
    tx.update(ref, { status: to, history: note(s, action, actor, more.note ?? ""), updatedAt: FieldValue.serverTimestamp(), ...more.fields });
    if (lock) tx.delete(lock);
    writeAudit({ actorUid: actor.uid, action: `stock.count_${action}`, entityType: "stockCount", entityId: id, changes: { number: s.number, ...more.audit } }, tx);
    return { id, status: to, existing: false, ...more.result };
  });
}

/** Send the counted lines for approval. @param {{ id: string }} input @param {Actor} actor */
export function submitCount({ id }, actor) {
  return transition(id, actor, {
    from: ["counting"],
    to: "submitted",
    action: "submitted",
    extra: (s) => {
      const sum = summarise(s.lines ?? {});
      if (!sum.counted) throw new AppError("failed-precondition", "Count at least one item before submitting.");
      return { fields: { summary: sum, submittedBy: actor.uid, submittedAt: FieldValue.serverTimestamp() }, audit: sum, result: { summary: sum } };
    },
  });
}

/** Approve or reject a submitted count. An approver who also ran the count is allowed (it is recorded). @param {{ id: string, decision: "approve" | "reject", note?: string }} input @param {Actor} actor */
export function decideCount({ id, decision, note: text = "" }, actor) {
  return transition(id, actor, {
    from: ["submitted"],
    to: decision === "approve" ? "approved" : "rejected",
    action: decision === "approve" ? "approved" : "rejected",
    extra: (s) => ({ note: text, fields: { decidedBy: actor.uid, decidedAt: FieldValue.serverTimestamp(), decisionNote: text, selfApproved: s.startedBy === actor.uid }, audit: { selfApproved: s.startedBy === actor.uid } }),
  });
}

/** Give up on a count that hasn't been applied. @param {{ id: string }} input @param {Actor} actor */
export function cancelCount({ id }, actor) {
  return transition(id, actor, { from: ["counting", "submitted", "approved"], to: "cancelled", action: "cancelled" });
}

/** One transaction's worth of an approved count. @returns {Promise<{ done: boolean, applied: number, skipped: number }>} */
async function applyBatch(id, actor) {
  const ref = counts().doc(id);
  const first = await ref.get();
  if (!first.exists) throw new AppError("not-found", "That count doesn't exist.");
  const pending = Object.entries(first.data().lines ?? {}).filter(([, l]) => l.countedQty !== null && l.countedQty !== undefined && !l.appliedAt && !l.error).slice(0, BATCH);
  if (!pending.length) return finish(id, actor);
  return db.runTransaction(async (tx) => {
    const [snap, warehouses, settings, acc, ...rest] = await Promise.all([tx.get(ref), readWarehouses(tx), tx.get(db.doc("settings/private")), readAccounting(tx), ...pending.map(([, l]) => readStock(tx, l.productId, l.variantId)), ...pending.map(([, l]) => tx.get(db.collection("variantCosts").doc(inventoryId(l.productId, l.variantId))))]);
    const s = snap.data();
    if (!["approved", "applying"].includes(s.status)) throw new AppError("failed-precondition", `This count is ${s.status}; only an approved count can be applied.`);
    /** @type {any[]} */
    const stocks = rest.slice(0, pending.length);
    /** @type {any[]} */
    const costs = rest.slice(pending.length);
    const ctx = createStockContext(warehouses);
    const updates = {};
    let applied = 0;
    let skipped = 0;
    pending.forEach(([k, l], i) => {
      if (s.lines[k]?.appliedAt || s.lines[k]?.error) return; // another request already did this line
      const stock = stocks[i];
      const delta = l.countedQty - l.systemQty;
      const current = stock.inv.exists ? entriesOf(stock.inv)[s.warehouseId]?.onHand ?? 0 : 0;
      if (delta === 0) {
        updates[`lines.${k}.appliedAt`] = new Date().toISOString();
        return;
      }
      const reserved = entriesOf(stock.inv)[s.warehouseId]?.reserved ?? 0;
      if (!stock.inv.exists || !stock.variant.exists || current + delta < reserved || current + delta < 0) {
        updates[`lines.${k}.error`] = `Can't apply ${delta > 0 ? "+" : ""}${delta}: ${current} on hand now${reserved ? ` (${reserved} reserved)` : ""}. Check this item and adjust it by hand.`;
        skipped += 1;
        return;
      }
      writeStockChange(tx, stock, { change: delta, reason: "count", note: `${s.number}: counted ${l.countedQty}, system said ${l.systemQty}`, actorUid: actor.uid, settings: settings.data(), ctx, warehouseId: s.warehouseId, sourceType: "stock_count", sourceId: id });
      const cost = costs[i].exists ? costs[i].data().costPrice ?? null : null;
      const value = cost === null ? 0 : Math.abs(delta) * cost;
      let posting = "none";
      if (value > 0) posting = postInTx(tx, acc, stockAdjustmentSpec(`${id}_${k}`, { label: "Stock count difference", change: delta, qty: Math.abs(delta), value, productName: l.productName, variantLabel: l.variantLabel, note: s.number, when: new Date() }), actor.uid).status;
      updates[`lines.${k}.appliedAt`] = new Date().toISOString();
      updates[`lines.${k}.applied`] = { delta, onHandBefore: current, onHandAfter: current + delta, value, posting, costMissing: cost === null };
      applied += 1;
    });
    flushStockContext(tx, ctx);
    finishAccounting(tx, acc);
    tx.update(ref, { ...updates, status: "applying", updatedAt: FieldValue.serverTimestamp() });
    return { done: false, applied, skipped };
  });
}

async function finish(id, actor) {
  const ref = counts().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const s = snap.data();
    if (s.status === "applied") return { done: true, applied: 0, skipped: 0 };
    const flagged = Object.values(s.lines).filter((l) => l.error).length;
    tx.update(ref, { status: "applied", history: note(s, "applied", actor, flagged ? `${flagged} line(s) need attention` : ""), flagged, appliedAt: FieldValue.serverTimestamp(), appliedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() });
    tx.delete(lockRef(s.warehouseId));
    writeAudit({ actorUid: actor.uid, action: "stock.count_applied", entityType: "stockCount", entityId: id, changes: { number: s.number, flagged } }, tx);
    return { done: true, applied: 0, skipped: 0 };
  });
}

/** Apply an approved count to the stock. Safe to repeat: lines already applied are never applied again. @param {{ id: string }} input @param {Actor} actor */
export async function applyCount({ id }, actor) {
  let applied = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = await applyBatch(id, actor);
    applied += r.applied;
    if (r.done) break;
  }
  const s = (await counts().doc(id).get()).data();
  return { id, status: s.status, applied, flagged: Object.values(s.lines ?? {}).filter((l) => l.error).length };
}
