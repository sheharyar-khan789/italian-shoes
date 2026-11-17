/**
 * Customer discounts (for a customer, a membership tier, a customer group or everyone), with minimum purchase, validity
 * dates, usage limits and product / category restrictions. They are applied by the POS checkout on the server (the browser
 * only says "apply my customer discount"), the single best eligible one is used (customer discounts never stack with each
 * other), and they can't be combined with a manual discount. Usage is counted in the sale's own transaction.
 *
 *   crmDiscounts/{id}                          the rule + `used` (how many sales used it)
 *   crmDiscountUses/{discountId}__{customerId} how many times that customer used it
 *   The saving is booked as a sales discount by the sale's normal journal.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { evaluateDiscount, bestDiscount } from "../shared/crm.js";

const discounts = () => db.collection("crmDiscounts");
/** @typedef {{ uid: string, name: string }} Actor */

/** @param {Record<string, any>} input validated saveCrmDiscountInput @param {Actor} actor */
export async function saveDiscount(input, actor) {
  const { id, ...body } = input;
  if (body.scope === "customer") {
    const c = await db.collection("crmCustomers").doc(body.customerId).get();
    if (!c.exists) throw new AppError("invalid-argument", "That customer doesn't exist.", { fields: { customerId: "Not found" } });
    body.customerName = c.data().name;
  }
  const ref = id ? discounts().doc(id) : discounts().doc();
  if (id) {
    if (!(await ref.get()).exists) throw new AppError("not-found", "That discount doesn't exist.");
    await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
  } else await ref.create({ ...body, used: 0, createdAt: FieldValue.serverTimestamp(), createdBy: actor.uid, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: id ? "crm.discount_updated" : "crm.discount_created", entityType: "crmDiscount", entityId: ref.id, changes: { name: body.name, scope: body.scope, type: body.type, value: body.value } });
  return { id: ref.id };
}

/** @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setDiscountActive({ id, isActive }, actor) {
  const ref = discounts().doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That discount doesn't exist.");
  await ref.update({ isActive, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "crm.discount_active", entityType: "crmDiscount", entityId: id, changes: { isActive } });
  return { id, isActive };
}

export async function listDiscounts() {
  const snap = await discounts().limit(300).get();
  return { discounts: /** @type {Record<string, any>[]} */ (snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: undefined, updatedAt: undefined }))).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

/** Read the active discounts and this customer's usage inside a transaction (BEFORE any write). @param {FirebaseFirestore.Transaction} tx @param {string | null} customerId */
export async function readDiscounts(tx, customerId) {
  const snap = await tx.get(discounts().where("isActive", "==", true).limit(100));
  /** @type {Record<string, any>[]} */
  const list = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const limited = list.filter((d) => d.perCustomerLimit > 0 && customerId);
  const uses = limited.length ? await Promise.all(limited.map((d) => tx.get(db.collection("crmDiscountUses").doc(`${d.id}__${customerId}`)))) : [];
  const usedBy = new Map(limited.map((d, i) => [d.id, uses[i].exists ? uses[i].data().count : 0]));
  return list.map((d) => ({ ...d, usedByCustomer: usedBy.get(d.id) ?? 0 }));
}

/** The best eligible discount for this sale (or null). @param {any[]} list @param {{ customerId: string | null, tier: string | null, segments: string[], lines: { productId: string, categoryId?: string | null, amount: number }[] }} ctx */
export function pickDiscount(list, ctx) {
  return bestDiscount(list, (d) => evaluateDiscount(d, { ...ctx, now: Date.now(), used: d.used ?? 0, usedByCustomer: d.usedByCustomer ?? 0 }));
}

/** Count one use, inside the sale's transaction. @param {FirebaseFirestore.Transaction} tx */
export function recordUse(tx, { discount, customerId, saleId, amount }) {
  tx.update(discount.ref, { used: FieldValue.increment(1) });
  if (customerId) tx.set(db.collection("crmDiscountUses").doc(`${discount.id}__${customerId}`), { discountId: discount.id, customerId, count: FieldValue.increment(1) }, { merge: true });
  tx.create(db.collection("crmDiscountUses").doc(`${discount.id}__sale__${saleId}`), { discountId: discount.id, customerId, saleId, amount, at: FieldValue.serverTimestamp() });
}
