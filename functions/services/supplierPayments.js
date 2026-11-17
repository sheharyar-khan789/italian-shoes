/**
 * Payments made to suppliers. The ONLY code that records them.
 *
 *   supplierPayments/{id}   number, supplier, optional purchase order, amount, method, reference, paidAt, who
 *   counters/supplierPayments   { next }   (SP-000001 …)
 *
 * These are RECORDS of money the store paid outside this system (cash handed over, a bank transfer, a JazzCash
 * or Easypaisa transfer done in their own app). Nothing here moves money or talks to a payment provider, and
 * the screens say so. Each payment is one transaction that
 *   - refuses more than the supplier is owed (and, when tied to a purchase order, more than that order still
 *     owes after returns and earlier payments), so multiple part-payments can never overpay;
 *   - writes a ledger debit and updates the supplier's balance and the order's paid amount and status;
 *   - is idempotent: the same key returns the first payment instead of recording a second one.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { paymentStatusOf, SUPPLIER_PAY_LABEL } from "../shared/purchase.js";
import { ledgerWriter } from "./suppliers.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { supplierPaymentSpec } from "./accountingRules.js";

const rs = (paisa) => `Rs. ${(paisa / 100).toLocaleString("en-PK")}`;

/**
 * @param {Record<string, any>} input validated supplierPaymentInput
 * @param {string} actorUid
 */
export async function recordSupplierPayment(input, actorUid, { canAdvance = true } = {}) {
  const { idempotencyKey, supplierId, purchaseOrderId = null, amount, method, reference, paidAt, note, advance = false } = input;
  const idemRef = db.collection("idempotency").doc(`pay__${actorUid}__${idempotencyKey}`);
  const supplierRef = db.collection("suppliers").doc(supplierId);
  const poRef = purchaseOrderId ? db.collection("purchaseOrders").doc(purchaseOrderId) : null;
  const payRef = db.collection("supplierPayments").doc();
  const counterRef = db.collection("counters").doc("supplierPayments");

  return db.runTransaction(async (tx) => {
    const [idem, supplier, po, counter, acc] = await Promise.all([tx.get(idemRef), tx.get(supplierRef), poRef ? tx.get(poRef) : null, tx.get(counterRef), readAccounting(tx)]);
    if (idem.exists) return { paymentId: idem.data().paymentId, number: idem.data().number, existing: true };
    if (!supplier.exists) throw new AppError("not-found", "That supplier no longer exists.");
    const owed = supplier.data().balance ?? 0;
    // Paying more than is owed (or paying someone who is owed nothing) is an ADVANCE: only when asked for explicitly, by someone allowed to.
    const isAdvance = amount > Math.max(0, owed);
    if (isAdvance) {
      if (!advance) {
        if (owed <= 0) throw new AppError("failed-precondition", `${supplier.data().name} is not owed anything right now. To pay ahead, record an advance payment.`, { fields: { amount: "Nothing is owed" } });
        throw new AppError("invalid-argument", `${supplier.data().name} is owed ${rs(owed)}. You can't pay more than that unless it is an advance payment.`, { fields: { amount: `At most ${rs(owed)}` } });
      }
      if (!canAdvance) throw new AppError("permission-denied", "You aren't allowed to record advance payments.");
      if (po) throw new AppError("invalid-argument", "An advance payment can't be tied to one purchase order.", { fields: { purchaseOrderId: "Not for advances" } });
    }

    let poUpdate = null;
    if (po) {
      if (!po.exists || po.data().supplierId !== supplierId) throw new AppError("invalid-argument", "That purchase order isn't this supplier's.", { fields: { purchaseOrderId: "Not found" } });
      const d = po.data();
      const outstanding = (d.receivedValue ?? 0) - (d.returnedValue ?? 0) - (d.paidTotal ?? 0);
      if (outstanding <= 0) throw new AppError("failed-precondition", `${d.number} has nothing left to pay (only goods already received count).`, { fields: { purchaseOrderId: "Nothing left to pay" } });
      if (amount > outstanding) throw new AppError("invalid-argument", `${d.number} still owes ${rs(outstanding)}. You can't pay more than that against it.`, { fields: { amount: `At most ${rs(outstanding)}` } });
      const paidTotal = (d.paidTotal ?? 0) + amount;
      poUpdate = { paidTotal, paymentStatus: paymentStatusOf({ receivedValue: d.receivedValue ?? 0, returnedValue: d.returnedValue ?? 0, paidTotal }), updatedAt: FieldValue.serverTimestamp() };
    }

    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `SP-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    tx.create(payRef, {
      number,
      supplierId,
      supplierName: supplier.data().name,
      purchaseOrderId,
      purchaseOrderNumber: po?.data().number ?? null,
      amount,
      method,
      methodLabel: SUPPLIER_PAY_LABEL[method],
      reference,
      paidAt,
      note,
      isAdvance,
      advancePortion: isAdvance ? amount - Math.max(0, owed) : 0,
      recordedOnly: true,
      recordedBy: actorUid,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (poRef && poUpdate) tx.update(poRef, poUpdate);
    const ledger = ledgerWriter(tx, supplierRef, supplier.data());
    ledger.append({ type: "payment", debit: amount, refType: "payment", refId: payRef.id, refNumber: number, note: `${isAdvance ? "Advance payment · " : ""}${SUPPLIER_PAY_LABEL[method]}${reference ? ` · ${reference}` : ""}`, actorUid });
    ledger.finish();
    postInTx(tx, acc, supplierPaymentSpec(payRef.id, { number, supplierName: supplier.data().name, supplierId, amount, method, methodLabel: SUPPLIER_PAY_LABEL[method], reference, paidAt }), actorUid);
    finishAccounting(tx, acc);
    tx.create(idemRef, { paymentId: payRef.id, number, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "supplier.payment", entityType: "supplier_payment", entityId: payRef.id, changes: { number, supplierId, amount, method } }, tx);
    return { paymentId: payRef.id, number, balance: ledger.balance, existing: false };
  });
}
