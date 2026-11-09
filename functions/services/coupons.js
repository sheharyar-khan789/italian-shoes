/**
 * Coupons. The owner creates them; the server alone decides whether one applies to an order.
 *
 *   coupons/{CODE}                     the rules + usedCount
 *   coupons/{CODE}/uses/{uid}          { count } how many times this customer redeemed it
 *
 * Redemption is counted inside the order transaction, so a "first 50 customers" coupon can't be
 * used 51 times by simultaneous orders. Cancelling an order before dispatch gives the use back.
 */
import { db, FieldValue, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { evaluateCoupon } from "../shared/coupon.js";

const coupons = () => db.collection("coupons");
const ms = (t) => (t ? t.toMillis() : null);

/** Document fields → the pure rule shape. */
export function toRule(code, d) {
  return {
    code,
    type: d.type,
    value: d.value,
    minOrder: d.minOrder ?? 0,
    maxDiscount: d.maxDiscount ?? null,
    startsAtMs: ms(d.startsAt),
    endsAtMs: ms(d.endsAt),
    usageLimit: d.usageLimit ?? null,
    perCustomerLimit: d.perCustomerLimit ?? null,
    usedCount: d.usedCount ?? 0,
    productIds: d.productIds ?? [],
    categoryIds: d.categoryIds ?? [],
    isActive: d.isActive === true,
  };
}

/**
 * Read a coupon inside a transaction and price it against the lines.
 * Must be called BEFORE any write in the transaction. Returns what to write afterwards.
 * @param {FirebaseFirestore.Transaction | null} tx  null for a read-only quote
 */
export async function applyCoupon(tx, code, uid, lines) {
  const ref = coupons().doc(code);
  const useRef = ref.collection("uses").doc(uid);
  const [snap, use] = tx ? await Promise.all([tx.get(ref), tx.get(useRef)]) : await Promise.all([ref.get(), useRef.get()]);
  // Same wording for "unknown code" and "not allowed", so codes can't be guessed from the replies.
  if (!snap.exists) throw new AppError("failed-precondition", "That coupon code isn't valid.", { fields: { couponCode: "Not valid" } });
  const verdict = evaluateCoupon(toRule(code, snap.data()), lines, { nowMs: Date.now(), customerUses: use.exists ? use.data().count : 0 });
  if (!verdict.ok) {
    const message = /** @type {{ message: string }} */ (verdict).message;
    throw new AppError("failed-precondition", message, { fields: { couponCode: message } });
  }
  return { discount: verdict.discount, commit: (t) => {
    t.update(ref, { usedCount: FieldValue.increment(1) });
    t.set(useRef, { count: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
  } };
}

/** Give a use back (order cancelled before it shipped). Call inside a transaction, after reads. */
export function releaseCoupon(tx, code, uid) {
  const ref = coupons().doc(code);
  tx.update(ref, { usedCount: FieldValue.increment(-1) });
  tx.set(ref.collection("uses").doc(uid), { count: FieldValue.increment(-1) }, { merge: true });
}

/* ───────── Admin ───────── */

/** @param {Record<string, any>} input validated saveCouponInput @param {string} actorUid */
export async function saveCoupon(input, actorUid) {
  const ref = coupons().doc(input.code);
  const data = {
    type: input.type,
    value: input.value,
    minOrder: input.minOrder,
    maxDiscount: input.maxDiscount,
    startsAt: input.startsAt ? Timestamp.fromDate(input.startsAt) : null,
    endsAt: input.endsAt ? Timestamp.fromDate(input.endsAt) : null,
    usageLimit: input.usageLimit,
    perCustomerLimit: input.perCustomerLimit,
    productIds: input.productIds,
    categoryIds: input.categoryIds,
    isActive: input.isActive,
  };
  const created = await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (cur.exists) {
      if (data.usageLimit != null && data.usageLimit < (cur.data().usedCount ?? 0)) {
        throw new AppError("invalid-argument", `This coupon was already used ${cur.data().usedCount} times, so the limit can't be lower than that.`, { fields: { usageLimit: "Lower than uses so far" } });
      }
      tx.update(ref, { ...data, ...stamp });
    } else {
      tx.create(ref, { ...data, ...stamp, usedCount: 0, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid });
    }
    writeAudit({ actorUid, action: cur.exists ? "coupon.updated" : "coupon.created", entityType: "coupon", entityId: input.code, changes: { type: data.type, value: data.value, isActive: data.isActive } }, tx);
    return !cur.exists;
  });
  return { code: input.code, created };
}

/** Orders keep the code and amount they were placed with, so deleting changes no history. */
export async function deleteCoupon(code, actorUid) {
  const ref = coupons().doc(code);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That coupon no longer exists.");
  await db.recursiveDelete(ref);
  await writeAudit({ actorUid, action: "coupon.deleted", entityType: "coupon", entityId: code });
  return { code };
}
