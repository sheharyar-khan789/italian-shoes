/**
 * Supplier refunds and manual balance adjustments. Both go through the supplier ledger writer (so the ledger line and
 * the supplier's balance change in the same transaction) and the accounting engine (so the books follow).
 *
 *   Refund      the supplier gives money back (only up to the credit they hold with us, e.g. after an advance):
 *               ledger credit, Dr cash / bank / wallet clearing, Cr accounts payable.
 *   Adjustment  a manual change to what is owed, for a reason, posted against an account the person chooses:
 *               decrease: Dr accounts payable, Cr chosen account;  increase: Dr chosen account, Cr accounts payable.
 *
 * Each is keyed by an idempotency key, so a double click or a retry records it once.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { SUPPLIER_PAY_LABEL } from "../shared/purchase.js";
import { ledgerWriter } from "./suppliers.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { supplierRefundSpec, supplierAdjustmentSpec } from "./accountingRules.js";

const rs = (paisa) => `Rs. ${(paisa / 100).toLocaleString("en-PK")}`;

/** @param {Record<string, any>} input validated supplierRefundInput @param {string} actorUid */
export async function recordSupplierRefund(input, actorUid) {
  const { idempotencyKey, supplierId, amount, method, reference, receivedAt, note } = input;
  const idemRef = db.collection("idempotency").doc(`supref__${actorUid}__${idempotencyKey}`);
  const supplierRef = db.collection("suppliers").doc(supplierId);
  const refundRef = db.collection("supplierRefunds").doc();
  const counterRef = db.collection("counters").doc("supplierRefunds");
  return db.runTransaction(async (tx) => {
    const [idem, supplier, counter, acc] = await Promise.all([tx.get(idemRef), tx.get(supplierRef), tx.get(counterRef), readAccounting(tx)]);
    if (idem.exists) return { refundId: idem.data().refundId, number: idem.data().number, existing: true };
    if (!supplier.exists) throw new AppError("not-found", "That supplier no longer exists.");
    const credit = -(supplier.data().balance ?? 0);
    if (credit <= 0) throw new AppError("failed-precondition", `${supplier.data().name} doesn't hold any credit with you, so there is nothing to refund.`, { fields: { amount: "No credit" } });
    if (amount > credit) throw new AppError("invalid-argument", `${supplier.data().name} holds ${rs(credit)} with you. A refund can't be more than that.`, { fields: { amount: `At most ${rs(credit)}` } });
    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `SR-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    const doc = { number, supplierId, supplierName: supplier.data().name, amount, method, methodLabel: SUPPLIER_PAY_LABEL[method], reference, receivedAt, note, recordedOnly: true, recordedBy: actorUid, createdAt: FieldValue.serverTimestamp() };
    tx.create(refundRef, doc);
    const ledger = ledgerWriter(tx, supplierRef, supplier.data());
    ledger.append({ type: "refund", credit: amount, refType: "refund", refId: refundRef.id, refNumber: number, note: `${SUPPLIER_PAY_LABEL[method]}${reference ? ` · ${reference}` : ""}`, actorUid });
    ledger.finish();
    postInTx(tx, acc, supplierRefundSpec(refundRef.id, { ...doc, receivedAt }), actorUid);
    finishAccounting(tx, acc);
    tx.create(idemRef, { refundId: refundRef.id, number, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "supplier.refund", entityType: "supplier_refund", entityId: refundRef.id, changes: { number, supplierId, amount, method } }, tx);
    return { refundId: refundRef.id, number, balance: ledger.balance, existing: false };
  });
}

/** @param {Record<string, any>} input validated supplierAdjustmentInput @param {string} actorUid */
export async function recordSupplierAdjustment(input, actorUid) {
  const { idempotencyKey, supplierId, direction, amount, accountCode, reason, date } = input;
  const idemRef = db.collection("idempotency").doc(`supadj__${actorUid}__${idempotencyKey}`);
  const supplierRef = db.collection("suppliers").doc(supplierId);
  const adjRef = db.collection("supplierAdjustments").doc();
  const counterRef = db.collection("counters").doc("supplierAdjustments");
  return db.runTransaction(async (tx) => {
    const [idem, supplier, counter, acc] = await Promise.all([tx.get(idemRef), tx.get(supplierRef), tx.get(counterRef), readAccounting(tx)]);
    if (idem.exists) return { adjustmentId: idem.data().adjustmentId, number: idem.data().number, existing: true };
    if (!supplier.exists) throw new AppError("not-found", "That supplier no longer exists.");
    if (!acc.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet. An adjustment has to be posted to an account, so create the chart of accounts first.");
    const account = acc.config.accounts[accountCode];
    if (!account || account.isGroup || account.active === false) throw new AppError("invalid-argument", "Choose an active account to post the other side to.", { fields: { accountCode: "Not usable" } });
    if (accountCode === acc.config.roles.accounts_payable || account.control) throw new AppError("invalid-argument", "Choose an account other than the payables or receivables accounts.", { fields: { accountCode: "Not allowed" } });
    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `SA-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    const doc = { number, supplierId, supplierName: supplier.data().name, direction, amount, accountCode, accountName: account.name, reason, date, recordedBy: actorUid, createdAt: FieldValue.serverTimestamp() };
    tx.create(adjRef, doc);
    const ledger = ledgerWriter(tx, supplierRef, supplier.data());
    ledger.append({ type: "adjustment", ...(direction === "increase" ? { credit: amount } : { debit: amount }), refType: "adjustment", refId: adjRef.id, refNumber: number, note: reason, actorUid });
    ledger.finish();
    const posted = postInTx(tx, acc, supplierAdjustmentSpec(adjRef.id, doc), actorUid);
    if (posted.status !== "posted") throw new AppError("failed-precondition", "That adjustment couldn't be posted to the books, so nothing was saved.");
    finishAccounting(tx, acc);
    tx.create(idemRef, { adjustmentId: adjRef.id, number, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "supplier.adjustment", entityType: "supplier_adjustment", entityId: adjRef.id, changes: { number, supplierId, direction, amount, accountCode, reason } }, tx);
    return { adjustmentId: adjRef.id, number, balance: ledger.balance, existing: false };
  });
}
