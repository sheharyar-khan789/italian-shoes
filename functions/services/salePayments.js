/**
 * Payments against a sale: several payments, part-payments, and corrections that never edit history.
 *
 *   payments/{saleId}                       the payment record (online sales: the same id as the order)
 *   payments/{saleId}/transactions/{id}     append-only: collection, refund, reversal
 *
 * Methods: COD, cash, bank transfer, JazzCash, Easypaisa. These are RECORDS of money the store received outside
 * this system (cash in hand, a transfer seen in the bank or wallet app); nothing here talks to a payment
 * provider, and a recorded payment is never described as a verified gateway payment ("recordedOnly").
 *
 * recordSalePayment   adds a collection entry. Up to what is still due, so several payments can add up to the
 *                     total; the status goes pending → partially_paid → collected.
 * reverseSalePayment  corrects a mistaken entry by adding an OPPOSITE entry (type "reversal") that points at the
 *                     original. The original is never edited or deleted, a reversal can only be made once per
 *                     entry (its id is derived from the entry's id), and it is refused once money was refunded.
 * Both run in one transaction with the order, payment record and sale, and are idempotent per key.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { salePaymentFields, SALE_PAYMENT_LABEL, UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { syncSale, paymentPatch } from "./sales.js";
import { readAccounting, postInTx, finishAccounting, reverseInTx } from "./accounting.js";
import { customerPaymentSpec } from "./accountingRules.js";
import { pktDateKey } from "../shared/accounting.js";

const rs = (paisa) => `Rs. ${(paisa / 100).toLocaleString("en-PK")}`;

async function readAll(tx, saleId, extra = []) {
  const payRef = db.collection("payments").doc(saleId);
  const [sale, pay, ...rest] = await Promise.all([tx.get(db.collection("sales").doc(saleId)), tx.get(payRef), ...extra]);
  if (!sale.exists) throw new AppError("not-found", "That sale no longer exists.");
  if (!pay.exists) throw new AppError("failed-precondition", "This sale has no payment record to add to.");
  const orderSnap = sale.data().orderId ? await tx.get(db.collection("orders").doc(sale.data().orderId)) : null;
  return { sale, pay, payRef, order: orderSnap?.exists ? orderSnap : null, rest };
}

/** Apply the new payment totals to the payment record, the order (if any) and the sale. */
function applyTotals(tx, { sale, payRef, pay, order }, paidTotal, actorUid) {
  const p = pay.data();
  const status = paidTotal >= p.amount ? "collected" : paidTotal > 0 ? "partially_paid" : "pending";
  tx.update(payRef, { status, paidTotal, updatedAt: FieldValue.serverTimestamp(), ...(status === "collected" ? { collectedAt: FieldValue.serverTimestamp(), collectedBy: actorUid } : {}) });
  if (order) tx.update(order.ref, { paymentStatus: status, updatedAt: FieldValue.serverTimestamp() });
  syncSale(tx, sale, paymentPatch({ ...p, status, paidTotal }), actorUid);
  return { status, paidTotal, amountDue: Math.max(0, p.amount - paidTotal) };
}

/**
 * @param {{ idempotencyKey: string, saleId: string, amount: number, method: string, reference?: string, note?: string }} input validated recordSalePaymentInput
 * @param {string} actorUid
 */
export async function recordSalePayment({ idempotencyKey, saleId, amount, method, reference = "", note = "" }, actorUid, { sessionId = null } = {}) {
  const idemRef = db.collection("idempotency").doc(`salepay__${actorUid}__${idempotencyKey}`);
  const txnRef = db.collection("payments").doc(saleId).collection("transactions").doc();
  return db.runTransaction(async (tx) => {
    const idem = await tx.get(idemRef);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const ctx = await readAll(tx, saleId);
    const acc = await readAccounting(tx);
    // A counter payment is counted in the cashier's open register in this same transaction.
    const session = sessionId ? await tx.get(db.collection("registerSessions").doc(sessionId)) : null;
    if (session && (!session.exists || session.data().status !== "open")) throw new AppError("failed-precondition", "That register isn't open.");
    if (session && session.data().cashierUid !== actorUid) throw new AppError("permission-denied", "That register belongs to someone else.");
    const s = ctx.sale.data();
    const p = ctx.pay.data();
    if (UNCOUNTED_SALE_STATUSES.includes(s.status)) throw new AppError("failed-precondition", `This sale is ${s.status}, so no payment can be added.`);
    if (!["pending", "partially_paid"].includes(p.status)) throw new AppError("failed-precondition", p.status === "collected" || p.status === "paid" ? "This sale is already fully paid." : `A ${p.status.replace("_", " ")} payment can't take more money.`);
    if (method === "cod" && ctx.order && !["dispatched", "delivered"].includes(ctx.order.data().status)) {
      throw new AppError("failed-precondition", "Cash on delivery can be recorded once the order has been dispatched or delivered.");
    }
    const paid = salePaymentFields(p).paidTotal;
    const due = p.amount - paid;
    if (amount > due) throw new AppError("invalid-argument", `Only ${rs(due)} is still due on this sale.`, { fields: { amount: `At most ${rs(due)}` } });

    tx.create(txnRef, { type: "collection", amount, method, methodLabel: SALE_PAYMENT_LABEL[method], reference, note, recordedOnly: true, actorUid, at: FieldValue.serverTimestamp(), ...(sessionId ? { sessionId } : {}) });
    if (session) tx.update(session.ref, { [`totals.${method}`]: FieldValue.increment(amount), paymentCount: FieldValue.increment(1) });
    const after = applyTotals(tx, ctx, paid + amount, actorUid);
    postInTx(tx, acc, customerPaymentSpec({ sale: s, txnId: txnRef.id, amount, method, reference }), actorUid);
    finishAccounting(tx, acc);
    const result = { transactionId: txnRef.id, ...after };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "sale.payment_recorded", entityType: "sale", entityId: saleId, changes: { amount, method, status: after.status } }, tx);
    notify({ type: "payment.status", audience: "payments.update", title: `Payment recorded for ${s.number} (${rs(amount)})`, link: `/admin/sales/${saleId}`, data: { saleId, amount } }, tx);
    return { ...result, existing: false };
  });
}

/**
 * @param {{ idempotencyKey: string, saleId: string, transactionId: string, reason: string }} input validated reverseSalePaymentInput
 * @param {string} actorUid
 */
export async function reverseSalePayment({ idempotencyKey, saleId, transactionId, reason }, actorUid) {
  const idemRef = db.collection("idempotency").doc(`salerev__${actorUid}__${idempotencyKey}`);
  const origRef = db.collection("payments").doc(saleId).collection("transactions").doc(transactionId);
  const revRef = db.collection("payments").doc(saleId).collection("transactions").doc(`reversal_${transactionId}`);
  return db.runTransaction(async (tx) => {
    const [idem, orig, rev] = await Promise.all([tx.get(idemRef), tx.get(origRef), tx.get(revRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!orig.exists || orig.data().type !== "collection") throw new AppError("not-found", "That payment entry doesn't exist.");
    if (rev.exists) throw new AppError("failed-precondition", "That payment entry was already reversed.");
    const ctx = await readAll(tx, saleId);
    const acc = await readAccounting(tx, { journals: [`payment__${transactionId}`, `reversal__payment__${transactionId}`] });
    // A payment taken at the counter belongs to a register session. While it is open the session's totals follow;
    // once it is closed its reconciliation is history and is not changed (correct it with a cash movement instead).
    const origSession = orig.data().sessionId ? await tx.get(db.collection("registerSessions").doc(orig.data().sessionId)) : null;
    if (origSession && origSession.data()?.status !== "open") throw new AppError("failed-precondition", "That payment was taken in a register that is now closed, so it can't be reversed. Record the correction as a cash movement.");
    const s = ctx.sale.data();
    const p = ctx.pay.data();
    if (UNCOUNTED_SALE_STATUSES.includes(s.status) || (p.refundedTotal ?? 0) > 0) {
      throw new AppError("failed-precondition", "This sale is closed or money was already refunded. Record a refund instead of a reversal.");
    }
    const paid = salePaymentFields(p).paidTotal;
    const amount = orig.data().amount;
    if (paid < amount) throw new AppError("failed-precondition", "The amount recorded is already lower than this entry.");

    // The original entry stays exactly as it was; the reversal is a new line that points at it.
    tx.create(revRef, { type: "reversal", reverses: transactionId, amount, method: orig.data().method, reason, recordedOnly: true, actorUid, at: FieldValue.serverTimestamp() });
    const after = applyTotals(tx, ctx, paid - amount, actorUid);
    if (origSession) tx.update(origSession.ref, { [`totals.${orig.data().method}`]: FieldValue.increment(-amount), paymentCount: FieldValue.increment(-1) });
    reverseInTx(tx, acc, `payment__${transactionId}`, `Payment entry reversed: ${reason}`, pktDateKey(new Date()), actorUid);
    finishAccounting(tx, acc);
    const result = { reversalId: revRef.id, ...after };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "sale.payment_reversed", entityType: "sale", entityId: saleId, changes: { transactionId, amount, reason } }, tx);
    return { ...result, existing: false };
  });
}
