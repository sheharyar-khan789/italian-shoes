/**
 * Loyalty points. A configurable programme (OFF until the owner switches it on in the CRM settings).
 *
 *   loyaltyLots/{id}            points earned (or added by an admin) with what is left and when they expire. Redemption uses the
 *                               points that expire first. Available points = what is left in lots that haven't expired.
 *   loyaltyTransactions/{id}    the history: earn, redeem, adjust, reversal, expire — signed points, balance after, source, who, when.
 *                               Earning is keyed by the sale (earn__{saleId}) so a retried or repeated request never earns twice.
 *   loyaltyAccounts/{customer}  running totals: earned / redeemed / adjusted / reversed / expired.
 *
 * Earn: whole points per Rs 100 of ELIGIBLE spend (net of every discount, including points used; excluded products and categories
 * don't count; delivery and tax don't count) × the member's tier multiplier, once the sale is fully paid.
 * Redeem: on a POS sale, inside the sale's own transaction (so points and sale can't disagree): worth `redeemValuePerPoint` each, limited by
 * the minimum, the per-sale maximum and a percentage of the payable amount; it is booked as a sales discount.
 * Refund: points earned on a sale are taken back in proportion to what was refunded (never below zero; points already spent can't be recovered).
 */
import { db, FieldValue, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pointsForSale } from "../shared/crm.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { getCrmSettings } from "./crm.js";

const lots = () => db.collection("loyaltyLots");
const txns = () => db.collection("loyaltyTransactions");
const accounts = () => db.collection("loyaltyAccounts");

/** @typedef {{ uid: string, name: string }} Actor */
const iso = (t) => t?.toDate?.().toISOString() ?? null;
const expiryOf = (days, from = Date.now()) => (days > 0 ? Timestamp.fromMillis(from + days * 86400000) : null);

/** Points that can be used now from a customer's lots (oldest expiry first). @param {Record<string, any>[]} list @param {number} now */
export function usableLots(list, now = Date.now()) {
  return list.filter((l) => l.remaining > 0 && (!l.expiresAt || l.expiresAt.toMillis() > now)).sort((a, b) => (a.expiresAt?.toMillis() ?? Infinity) - (b.expiresAt?.toMillis() ?? Infinity));
}
export const availablePoints = (list, now = Date.now()) => usableLots(list, now).reduce((n, l) => n + l.remaining, 0);

/** Read a customer's lots inside a transaction (call BEFORE any write). @param {FirebaseFirestore.Transaction} tx @param {string} customerId */
export async function readLots(tx, customerId) {
  const snap = await tx.get(lots().where("customerId", "==", customerId).limit(500));
  return snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
}

/** Take `points` from the lots, soonest-expiring first. Returns the new balance. Throws if there aren't enough. @param {FirebaseFirestore.Transaction} tx */
export function consume(tx, lotList, points, now = Date.now()) {
  let left = points;
  for (const l of usableLots(lotList, now)) {
    if (left <= 0) break;
    const take = Math.min(l.remaining, left);
    tx.update(l.ref, { remaining: l.remaining - take });
    l.remaining -= take;
    left -= take;
  }
  if (left > 0) throw new AppError("failed-precondition", "Not enough loyalty points.");
  return availablePoints(lotList, now);
}

/** Record a redemption inside a sale's transaction. @param {FirebaseFirestore.Transaction} tx @param {{ customerId: string, points: number, value: number, saleId: string, number: string, lots: any[], actorUid: string }} r */
export function redeemInTx(tx, { customerId, points, value, saleId, number, lots: lotList, actorUid }) {
  const balance = consume(tx, lotList, points);
  tx.create(txns().doc(`redeem__${saleId}`), { customerId, type: "redeem", points: -points, value, balanceAfter: balance, sourceType: "sale", sourceId: saleId, note: `Redeemed on ${number}`, actorUid, at: FieldValue.serverTimestamp() });
  tx.set(accounts().doc(customerId), { redeemed: FieldValue.increment(points), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return balance;
}

/**
 * Give points for a sale that has been paid in full. Safe to call any number of times: the points are keyed by the sale.
 * Never throws for a business reason (the sale must not fail because of loyalty); returns what happened.
 * @param {{ saleId: string }} input
 */
export async function awardPointsForSale({ saleId }) {
  try {
    const cfg = await getCrmSettings();
    if (!cfg.loyalty.enabled) return { status: "off" };
    const saleSnap = await db.collection("sales").doc(saleId).get();
    if (!saleSnap.exists) return { status: "no-sale" };
    const sale = saleSnap.data();
    if (!sale.customerId) return { status: "walk-in" };
    if (UNCOUNTED_SALE_STATUSES.includes(sale.status) || (sale.amountDue ?? 0) > 0 || (sale.paidTotal ?? 0) <= 0) return { status: "not-paid" };
    const customer = await db.collection("crmCustomers").doc(sale.customerId).get();
    if (!customer.exists) return { status: "no-profile" };
    const productIds = [...new Set((sale.lines ?? []).map((l) => l.productId))];
    const prods = productIds.length ? await db.getAll(...productIds.map((id) => db.collection("products").doc(id))) : [];
    const category = new Map(prods.map((p) => [p.id, p.data()?.categoryId ?? null]));
    const eligible = (sale.lines ?? []).filter((l) => !cfg.loyalty.excludedProductIds.includes(l.productId) && !(category.get(l.productId) && cfg.loyalty.excludedCategoryIds.includes(category.get(l.productId)))).reduce((n, l) => n + Math.max(0, (l.lineTotal ?? 0) - (l.couponShare ?? 0)), 0);
    const tier = cfg.tiers.find((t) => t.key === customer.data().tier);
    const points = pointsForSale({ eligibleAmount: eligible, pointsPer100: cfg.loyalty.pointsPer100, multiplier: tier?.pointsMultiplier ?? 1 });
    const earnRef = txns().doc(`earn__${saleId}`);
    return await db.runTransaction(async (tx) => {
      const [existing, lotList] = await Promise.all([tx.get(earnRef), readLots(tx, sale.customerId)]);
      if (existing.exists) return { status: "already", points: existing.data().points };
      if (points <= 0) return { status: "no-points" };
      const lotRef = lots().doc(`earn__${saleId}`);
      tx.create(lotRef, { customerId: sale.customerId, points, remaining: points, expiresAt: expiryOf(cfg.loyalty.expiryDays), sourceType: "sale", sourceId: saleId, createdAt: FieldValue.serverTimestamp() });
      tx.create(earnRef, { customerId: sale.customerId, type: "earn", points, balanceAfter: availablePoints(lotList) + points, sourceType: "sale", sourceId: saleId, note: `Earned on ${sale.number}`, eligibleAmount: eligible, multiplier: tier?.pointsMultiplier ?? 1, reversedPoints: 0, at: FieldValue.serverTimestamp() });
      tx.set(accounts().doc(sale.customerId), { earned: FieldValue.increment(points), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { status: "earned", points };
    });
  } catch (error) {
    return { status: "error", message: /** @type {Error} */ (error).message };
  }
}

/** After a refund, take back the points the refunded part of the sale earned. Idempotent: it works out what should be kept and adjusts only the difference. @param {{ saleId: string }} input */
export async function reversePointsForRefund({ saleId }) {
  try {
    const saleSnap = await db.collection("sales").doc(saleId).get();
    if (!saleSnap.exists) return { status: "no-sale" };
    const sale = saleSnap.data();
    const total = sale.total ?? 0;
    const refunded = UNCOUNTED_SALE_STATUSES.includes(sale.status) ? total : Math.min(total, Math.max(sale.refundedTotal ?? 0, sale.returnedTotal ?? 0));
    const earnRef = txns().doc(`earn__${saleId}`);
    return await db.runTransaction(async (tx) => {
      const earn = await tx.get(earnRef);
      if (!earn.exists || total <= 0) return { status: "nothing" };
      const e = earn.data();
      const lotSnap = await tx.get(lots().doc(`earn__${saleId}`));
      const keep = Math.floor((e.points * (total - refunded)) / total);
      const delta = e.points - keep - (e.reversedPoints ?? 0);
      if (delta <= 0) return { status: "already" };
      const lot = lotSnap.data();
      const take = Math.min(delta, lot?.remaining ?? 0);
      const rev = txns().doc(`reversal__${saleId}__${refunded}`);
      tx.update(earnRef, { reversedPoints: (e.reversedPoints ?? 0) + delta });
      if (lotSnap.exists && take > 0) tx.update(lotSnap.ref, { remaining: lot.remaining - take });
      tx.set(rev, { customerId: e.customerId, type: "reversal", points: -take, unrecovered: delta - take, balanceAfter: null, sourceType: "sale", sourceId: saleId, note: `Refund on ${sale.number}: ${delta} point(s) due back${delta > take ? `, ${delta - take} already used` : ""}`, at: FieldValue.serverTimestamp() });
      tx.set(accounts().doc(e.customerId), { reversed: FieldValue.increment(take), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { status: "reversed", points: take, unrecovered: delta - take };
    });
  } catch (error) {
    return { status: "error", message: /** @type {Error} */ (error).message };
  }
}

/** An admin adds or removes points, with a reason, in the audit log and the history. @param {{ idempotencyKey: string, customerId: string, points: number, reason: string }} input @param {Actor} actor */
export async function adjustPoints({ idempotencyKey, customerId, points, reason }, actor) {
  const cfg = await getCrmSettings();
  const ref = txns().doc(`adjust__${customerId}__${idempotencyKey}`);
  return db.runTransaction(async (tx) => {
    const [existing, customer, lotList] = await Promise.all([tx.get(ref), tx.get(db.collection("crmCustomers").doc(customerId)), readLots(tx, customerId)]);
    if (existing.exists) return { ...existing.data(), at: undefined, existing: true };
    if (!customer.exists) throw new AppError("not-found", "That customer doesn't exist.");
    let balance;
    if (points > 0) {
      tx.create(lots().doc(`adjust__${customerId}__${idempotencyKey}`), { customerId, points, remaining: points, expiresAt: expiryOf(cfg.loyalty.expiryDays), sourceType: "adjustment", sourceId: ref.id, createdAt: FieldValue.serverTimestamp() });
      balance = availablePoints(lotList) + points;
    } else {
      if (availablePoints(lotList) < -points) throw new AppError("failed-precondition", `Only ${availablePoints(lotList)} points are available, so ${-points} can't be taken off.`, { fields: { points: "More than the balance" } });
      balance = consume(tx, lotList, -points);
    }
    tx.create(ref, { customerId, type: "adjust", points, balanceAfter: balance, sourceType: "adjustment", sourceId: ref.id, note: reason, actorUid: actor.uid, actorName: actor.name, at: FieldValue.serverTimestamp() });
    tx.set(db.collection("loyaltyAccounts").doc(customerId), { adjusted: FieldValue.increment(points), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    writeAudit({ actorUid: actor.uid, action: "loyalty.adjusted", entityType: "crmCustomer", entityId: customerId, changes: { points, reason, balanceAfter: balance } }, tx);
    return { customerId, points, balanceAfter: balance, existing: false };
  });
}

/** Expire points whose time is up. Run by an admin (nothing runs in the background). Each lot expires once. */
export async function expirePoints() {
  const now = Timestamp.now();
  const due = await lots().where("expiresAt", "<=", now).limit(200).get();
  let expired = 0;
  let points = 0;
  for (const d of due.docs) {
    if (!(d.data().remaining > 0)) continue;
    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(d.ref);
      const rem = snap.data().remaining;
      if (!(rem > 0)) return 0;
      tx.update(d.ref, { remaining: 0 });
      tx.set(txns().doc(`expire__${d.id}`), { customerId: snap.data().customerId, type: "expire", points: -rem, balanceAfter: null, sourceType: "lot", sourceId: d.id, note: "Points expired", at: FieldValue.serverTimestamp() });
      tx.set(accounts().doc(snap.data().customerId), { expired: FieldValue.increment(rem), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return rem;
    });
    if (r > 0) {
      expired += 1;
      points += r;
    }
  }
  if (expired) await writeAudit({ actorUid: null, action: "loyalty.expired", entityType: "loyalty", entityId: "run", changes: { lots: expired, points } });
  return { lots: expired, points };
}

/** A customer's balance, totals and history. @param {{ customerId: string, limit?: number }} input */
export async function loyaltySummary({ customerId, limit = 50 }) {
  const [lotSnap, acct, hist] = await Promise.all([lots().where("customerId", "==", customerId).limit(500).get(), accounts().doc(customerId).get(), txns().where("customerId", "==", customerId).orderBy("at", "desc").limit(limit).get()]);
  const list = lotSnap.docs.map((d) => d.data());
  const now = Date.now();
  const soon = list.filter((l) => l.remaining > 0 && l.expiresAt && l.expiresAt.toMillis() > now).sort((a, b) => a.expiresAt.toMillis() - b.expiresAt.toMillis())[0];
  return {
    balance: availablePoints(list.map((l) => ({ id: "", ...l }))),
    earned: acct.data()?.earned ?? 0,
    redeemed: acct.data()?.redeemed ?? 0,
    adjusted: acct.data()?.adjusted ?? 0,
    reversed: acct.data()?.reversed ?? 0,
    expired: acct.data()?.expired ?? 0,
    nextExpiry: soon ? { points: soon.remaining, at: iso(soon.expiresAt) } : null,
    history: hist.docs.map((d) => ({ id: d.id, ...d.data(), at: iso(d.data().at) })),
  };
}
