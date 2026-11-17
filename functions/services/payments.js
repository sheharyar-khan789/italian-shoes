/**
 * Payments. The ONLY code that changes payment status, records cash collected or records a refund.
 *
 *   payments/{orderId}                  amount, method, status, refundedTotal
 *   payments/{orderId}/transactions/*   append-only: collection and refund records (who, how much, when)
 *
 * Cash on Delivery starts as "pending" (nothing collected). Staff record the cash only after the
 * parcel is dispatched or delivered, once, for the full amount. Refunds can never exceed what was
 * collected. Online gateways are not connected (no credentials), so no online payment can exist.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { sumPaisa } from "../shared/money.js";
import { canTransition, canTransitionPayment } from "../shared/orderStatus.js";
import { salePaymentFields } from "../shared/sales.js";
import { syncSale, statusPatch, paymentPatch } from "./sales.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { customerPaymentSpec, refundSpec } from "./accountingRules.js";

/** @param {string} orderId */
async function readOrderAndPayment(tx, orderId) {
  const orderRef = db.collection("orders").doc(orderId);
  const payRef = db.collection("payments").doc(orderId);
  const [order, pay, sale] = await Promise.all([tx.get(orderRef), tx.get(payRef), tx.get(db.collection("sales").doc(orderId))]);
  if (!order.exists || !pay.exists) throw new AppError("not-found", "Order not found.");
  return { orderRef, payRef, order: order.data(), pay: pay.data(), sale };
}

/**
 * Record that the cash for a COD order was received.
 * @param {{ orderId: string, note?: string }} input
 * @param {string} actorUid
 */
export async function recordCollection({ orderId, note = "" }, actorUid) {
  await db.runTransaction(async (tx) => {
    const { orderRef, payRef, order, pay, sale } = await readOrderAndPayment(tx, orderId);
    const acc = await readAccounting(tx);
    if (pay.method !== "cod") throw new AppError("failed-precondition", "Only Cash on Delivery payments are recorded by hand.");
    if (!["dispatched", "delivered"].includes(order.status)) {
      throw new AppError("failed-precondition", "Cash can be recorded once the order has been dispatched or delivered.");
    }
    if (!canTransitionPayment(pay.status, "collected")) {
      throw new AppError("failed-precondition", pay.status === "collected" ? "The cash for this order was already recorded." : `A ${pay.status} payment can't be marked as collected.`);
    }
    // Money already recorded as part-payments isn't collected twice: only what is still due is recorded now.
    const remaining = pay.amount - salePaymentFields(pay).paidTotal;
    if (remaining <= 0) throw new AppError("failed-precondition", "The cash for this order was already recorded.");
    tx.update(payRef, { status: "collected", paidTotal: pay.amount, collectedAt: FieldValue.serverTimestamp(), collectedBy: actorUid });
    tx.update(orderRef, { paymentStatus: "collected", updatedAt: FieldValue.serverTimestamp() });
    const txnRef = payRef.collection("transactions").doc();
    tx.create(txnRef, { type: "collection", amount: remaining, method: "cod", note, actorUid, at: FieldValue.serverTimestamp() });
    if (sale.exists) postInTx(tx, acc, customerPaymentSpec({ sale: sale.data(), txnId: txnRef.id, amount: remaining, method: "cod" }), actorUid);
    finishAccounting(tx, acc);
    syncSale(tx, sale, paymentPatch({ ...pay, status: "collected", paidTotal: pay.amount }), actorUid);
    writeAudit({ actorUid, action: "payment.collected", entityType: "payment", entityId: orderId, changes: { amount: pay.amount, note } }, tx);
    notify({ type: "payment.status", audience: "payments.update", title: `Cash collected for ${order.number}`, link: `/admin/orders/${orderId}`, data: { orderId, amount: pay.amount } }, tx);
  });
  return { ok: true };
}

/**
 * Record a refund (money given back to the customer). Cash handover itself happens outside the
 * system; this records that it happened. Full refunds close returned/cancelled orders.
 * @param {{ orderId: string, amount: number, reason: string }} input
 * @param {string} actorUid
 */
export async function recordRefund({ orderId, amount, reason }, actorUid) {
  return db.runTransaction(async (tx) => {
    const { orderRef, payRef, order, pay, sale } = await readOrderAndPayment(tx, orderId);
    const acc = await readAccounting(tx);
    if (!["collected", "paid", "partially_refunded"].includes(pay.status)) {
      throw new AppError("failed-precondition", pay.status === "refunded" ? "This order was already fully refunded." : "Nothing has been collected for this order yet, so there is nothing to refund.");
    }
    const refundedSoFar = pay.refundedTotal ?? 0;
    const refundable = pay.amount - refundedSoFar;
    if (amount > refundable) throw new AppError("invalid-argument", `At most Rs. ${(refundable / 100).toLocaleString("en-PK")} can still be refunded.`, { fields: { amount: "More than was collected" } });

    const refundedTotal = sumPaisa(refundedSoFar, amount);
    const status = refundedTotal === pay.amount ? "refunded" : "partially_refunded";
    if (!canTransitionPayment(pay.status, status)) throw new AppError("failed-precondition", "This payment can't be refunded.");

    tx.update(payRef, { status, refundedTotal, updatedAt: FieldValue.serverTimestamp() });
    const refundRef = payRef.collection("transactions").doc();
    tx.create(refundRef, { type: "refund", amount, reason, actorUid, at: FieldValue.serverTimestamp() });
    if (sale.exists) postInTx(tx, acc, refundSpec({ sale: sale.data(), txnId: refundRef.id, amount, reason }), actorUid);
    finishAccounting(tx, acc);
    const orderUpdate = { paymentStatus: status, updatedAt: FieldValue.serverTimestamp() };
    // A full refund of a cancelled or returned order closes it.
    if (status === "refunded" && canTransition(order.status, "refunded")) {
      orderUpdate.status = "refunded";
      tx.create(orderRef.collection("history").doc(), { from: order.status, to: "refunded", note: `Refunded: ${reason}`, actorUid, at: FieldValue.serverTimestamp() });
    }
    tx.update(orderRef, orderUpdate);
    syncSale(tx, sale, { ...paymentPatch({ ...pay, status, refundedTotal }), ...(orderUpdate.status ? statusPatch("refunded") : {}) }, actorUid);
    writeAudit({ actorUid, action: "payment.refund", entityType: "payment", entityId: orderId, changes: { amount, reason, status } }, tx);
    notify({ type: "refund", audience: "payments.update", title: `Refund recorded for ${order.number}`, body: reason, link: `/admin/orders/${orderId}`, data: { orderId, amount } }, tx);
    return { status, refundedTotal, remaining: pay.amount - refundedTotal };
  });
}

/**
 * Turn a payment method on or off (Cash on Delivery today).
 * @param {{ key: "cod", isEnabled: boolean }} input
 * @param {string} actorUid
 */
export async function setPaymentMethod({ key, isEnabled }, actorUid) {
  await db.collection("paymentMethods").doc(key).set({ name: "Cash on Delivery", isEnabled, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid }, { merge: true });
  await writeAudit({ actorUid, action: "payment_method.updated", entityType: "payment_method", entityId: key, changes: { isEnabled } });
  return { key, isEnabled };
}
