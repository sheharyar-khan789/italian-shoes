/**
 * Stock adjustments and cost revaluation. Stock is never overwritten: an adjustment is a recorded CHANGE (previous
 * quantity, change, new quantity, reason, who and when) applied through the stock service (inventory.js), which writes
 * the stock movement and refuses to go below zero or below what is reserved.
 *
 *   stockAdjustments/{id}   ADJ-000001 … status applied | pending | rejected, previousQty, changeQty, newQty, value at average cost
 *
 * Large adjustments (units or value at/above the limits in settings/inventory) entered by someone who can't approve
 * wait as "pending": nothing moves until another person approves; the quantity is re-checked at that moment.
 * Losses (damaged, lost, missing, internal use, negative corrections) are written off at the average cost:
 * Dr Inventory adjustments & write-offs, Cr Inventory; gains are the opposite. Journals are keyed by the adjustment id
 * (posted once, never edited). A variant with no recorded cost still adjusts; its write-off is flagged "no cost".
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { ADJUST_REASONS } from "../shared/inventory.js";
import { pktDateKey } from "../shared/accounting.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext, entriesOf } from "./inventory.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { stockAdjustmentSpec, costRevaluationSpec } from "./accountingRules.js";
import { inventoryId } from "./products.js";

const adjustments = () => db.collection("stockAdjustments");
const settingsRef = () => db.collection("settings").doc("inventory");

/** @typedef {{ uid: string, name: string }} Actor */

const history = (doc, action, actor, note = "") => [...(doc?.history ?? []), { at: new Date().toISOString(), byUid: actor.uid, byName: actor.name, action, note }].slice(-30);

/** Apply an approved/allowed adjustment inside a transaction that has already read everything. */
function apply(tx, { stock, warehouses, settings, acc, adjRef, adj, actor, cost }) {
  const before = entriesOf(stock.inv)[adj.warehouseId]?.onHand ?? 0;
  const ctx = createStockContext(warehouses);
  writeStockChange(tx, stock, { change: adj.changeQty, reason: adj.reason, note: `${adj.number}: ${adj.description}`, actorUid: actor.uid, settings, ctx, warehouseId: adj.warehouseId, sourceType: "stock_adjustment", sourceId: adjRef.id });
  flushStockContext(tx, ctx);
  const value = cost === null ? 0 : Math.abs(adj.changeQty) * cost;
  let posting = "none";
  if (value > 0) {
    posting = postInTx(tx, acc, stockAdjustmentSpec(adjRef.id, { label: ADJUST_REASONS[adj.reason].label, change: adj.changeQty, qty: Math.abs(adj.changeQty), value, productName: adj.productName, variantLabel: adj.variantLabel, note: adj.description, when: new Date() }), actor.uid).status;
    finishAccounting(tx, acc);
  }
  return { previousQty: before, newQty: before + adj.changeQty, value, unitCost: cost, costMissing: cost === null, posting };
}

/**
 * @param {Record<string, any>} input validated createAdjustmentInput @param {Actor} actor @param {{ canApprove: boolean }} opts
 */
export async function createAdjustment(input, actor, { canApprove }) {
  const { idempotencyKey, productId, variantId, warehouseId, reason, change, description, seenOnHand } = input;
  const rule = ADJUST_REASONS[reason];
  if ((rule.dir === "out" && change > 0) || (rule.dir === "in" && change < 0)) throw new AppError("invalid-argument", `"${rule.label}" ${rule.dir === "out" ? "removes" : "adds"} stock.`, { fields: { change: rule.dir === "out" ? "Enter a negative number" : "Enter a positive number" } });
  const idemRef = db.collection("idempotency").doc(`stockadj__${actor.uid}__${idempotencyKey}`);
  const adjRef = adjustments().doc();
  const counterRef = db.collection("counters").doc("stockAdjustments");
  return db.runTransaction(async (tx) => {
    const [idem, stock, warehouses, settings, inv, costSnap, acc, counter] = await Promise.all([tx.get(idemRef), readStock(tx, productId, variantId), readWarehouses(tx), tx.get(db.doc("settings/private")), tx.get(settingsRef()), tx.get(db.collection("variantCosts").doc(inventoryId(productId, variantId))), readAccounting(tx), tx.get(counterRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!stock.inv.exists || !stock.variant.exists) throw new AppError("not-found", "That size/colour doesn't exist.");
    const wh = warehouses.get(warehouseId);
    if (!wh) throw new AppError("invalid-argument", "Choose a warehouse that exists.", { fields: { warehouseId: "Not found" } });
    const before = entriesOf(stock.inv)[warehouseId]?.onHand ?? 0;
    if (seenOnHand !== undefined && seenOnHand !== before) throw new AppError("aborted", `The stock changed while you were working: ${wh.name} now holds ${before}, not ${seenOnHand}. Reload and check again.`);
    if (before + change < 0) throw new AppError("failed-precondition", `Only ${before} in stock in ${wh.name} — you can't remove ${-change}.`, { fields: { change: "More than is in stock" } });
    const cost = costSnap.exists ? costSnap.data().costPrice ?? null : null;
    const limits = inv.exists ? inv.data() : {};
    const needsApproval = !canApprove && ((limits.adjustApprovalUnits > 0 && Math.abs(change) >= limits.adjustApprovalUnits) || (limits.adjustApprovalValue > 0 && cost !== null && Math.abs(change) * cost >= limits.adjustApprovalValue));
    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `ADJ-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    const adj = {
      number, productId, variantId, warehouseId, warehouseName: wh.name, reason, reasonLabel: rule.label, description, changeQty: change,
      productName: stock.product.data()?.name ?? "", variantLabel: `${stock.variant.data().colorName ?? ""} / ${stock.variant.data().sizeLabel ?? ""}`, sku: stock.variant.data().sku ?? "",
      createdBy: actor.uid, createdByName: actor.name,
    };
    let result;
    if (needsApproval) {
      tx.create(adjRef, { ...adj, status: "pending", previousQty: before, newQty: null, unitCost: cost, history: history(null, "requested", actor, description), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      result = { id: adjRef.id, number, status: "pending", previousQty: before, newQty: null };
    } else {
      const done = apply(tx, { stock, warehouses, settings: settings.data(), acc, adjRef, adj, actor, cost });
      tx.create(adjRef, { ...adj, status: "applied", ...done, history: history(null, "applied", actor, description), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), appliedAt: FieldValue.serverTimestamp() });
      result = { id: adjRef.id, number, status: "applied", previousQty: done.previousQty, newQty: done.newQty, posting: done.posting, costMissing: done.costMissing };
    }
    writeAudit({ actorUid: actor.uid, action: `stock.adjustment_${result.status}`, entityType: "stockAdjustment", entityId: adjRef.id, changes: { number, reason, change, warehouseId, previousQty: before, status: result.status } }, tx);
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/** Approve (applies the change against the stock as it is NOW) or reject a waiting adjustment. Not by the person who asked. @param {{ id: string, decision: "approve" | "reject", note?: string }} input @param {Actor} actor */
export async function decideAdjustment({ id, decision, note = "" }, actor) {
  const adjRef = adjustments().doc(id);
  const first = await adjRef.get();
  if (!first.exists) throw new AppError("not-found", "That adjustment doesn't exist.");
  const { productId, variantId } = first.data();
  return db.runTransaction(async (tx) => {
    const [snap, stock, warehouses, settings, costSnap, acc] = await Promise.all([tx.get(adjRef), readStock(tx, productId, variantId), readWarehouses(tx), tx.get(db.doc("settings/private")), tx.get(db.collection("variantCosts").doc(inventoryId(productId, variantId))), readAccounting(tx)]);
    const adj = snap.data();
    if (adj.status !== "pending") return { id, status: adj.status, existing: true };
    if (adj.createdBy === actor.uid) throw new AppError("permission-denied", "Someone else must approve an adjustment you entered.");
    let update;
    if (decision === "approve") {
      const cost = costSnap.exists ? costSnap.data().costPrice ?? null : null;
      const done = apply(tx, { stock, warehouses, settings: settings.data(), acc, adjRef, adj, actor, cost });
      update = { status: "applied", ...done, appliedAt: FieldValue.serverTimestamp(), decidedBy: actor.uid, history: history(adj, "approved", actor, note) };
    } else update = { status: "rejected", decidedBy: actor.uid, history: history(adj, "rejected", actor, note) };
    tx.update(adjRef, { ...update, decisionNote: note, decidedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: `stock.adjustment_${decision === "approve" ? "approved" : "rejected"}`, entityType: "stockAdjustment", entityId: id, changes: { number: adj.number, change: adj.changeQty, note } }, tx);
    return { id, status: update.status, existing: false };
  });
}

/**
 * Change a variant's average cost by hand (for example to correct a wrong purchase cost). The difference applied to the
 * pairs on hand is posted to the books and the change is kept in the cost history. @param {Record<string, any>} input validated costAdjustInput @param {Actor} actor
 */
export async function adjustCost({ idempotencyKey, productId, variantId, newCost, reason }, actor) {
  const idemRef = db.collection("idempotency").doc(`costadj__${actor.uid}__${idempotencyKey}`);
  const costRef = db.collection("variantCosts").doc(inventoryId(productId, variantId));
  const histRef = db.collection("variantCostHistory").doc();
  return db.runTransaction(async (tx) => {
    const [idem, costSnap, stock, acc] = await Promise.all([tx.get(idemRef), tx.get(costRef), readStock(tx, productId, variantId), readAccounting(tx)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!stock.inv.exists || !stock.variant.exists) throw new AppError("not-found", "That size/colour doesn't exist.");
    const old = costSnap.exists ? costSnap.data().costPrice ?? null : null;
    if (old === newCost) throw new AppError("invalid-argument", "That is already the cost.", { fields: { newCost: "No change" } });
    const onHand = stock.inv.data().totalOnHand ?? stock.inv.data().onHand ?? 0;
    const value = old === null ? 0 : (newCost - old) * onHand;
    const label = `${stock.variant.data().colorName ?? ""} / ${stock.variant.data().sizeLabel ?? ""}`;
    tx.set(costRef, { costPrice: newCost, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(histRef, { productId, variantId, type: "revaluation", costBefore: old, costAfter: newCost, qty: 0, onHandQty: onHand, value, reason, actorUid: actor.uid, at: FieldValue.serverTimestamp() });
    let posting = "none";
    if (value !== 0) {
      posting = postInTx(tx, acc, costRevaluationSpec(histRef.id, { when: new Date(), productName: stock.product.data()?.name ?? "", variantLabel: label, oldCost: old, newCost, onHand, value, reason }), actor.uid).status;
      finishAccounting(tx, acc);
    }
    writeAudit({ actorUid: actor.uid, action: "stock.cost_revalued", entityType: "variantCost", entityId: costRef.id, changes: { old, newCost, onHand, value, reason } }, tx);
    const result = { id: histRef.id, costBefore: old, costAfter: newCost, onHand, value, posting, date: pktDateKey(new Date()) };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}
