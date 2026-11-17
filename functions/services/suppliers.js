/**
 * Suppliers and their ledger. The ONLY code that creates suppliers or writes ledger entries.
 *
 *   suppliers/{id}        name, contact details, openingBalance (fixed), balance (what the store owes now),
 *                         totalPurchased / totalReturned / totalPaid, isActive
 *   supplierLedger/{id}   one line per money event: type, debit, credit, balanceAfter, reference (append-only)
 *
 * Ledger convention (a payable account, "what we owe the supplier"):
 *   credit  increases the debt   — opening balance, goods received
 *   debit   decreases the debt   — payments made, goods returned
 *   balanceAfter = previous balance + credit − debit      (positive = we owe the supplier)
 * Every ledger line is written in the same transaction as the event that causes it, and the supplier's own
 * `balance` is updated by the same writer, so the two can never disagree.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Write ledger lines for one supplier inside a transaction. Call finish() once, after all append() calls.
 * @param {FirebaseFirestore.Transaction} tx
 * @param {FirebaseFirestore.DocumentReference} supplierRef
 * @param {Record<string, any>} supplier the supplier document as read in this transaction
 */
export function ledgerWriter(tx, supplierRef, supplier) {
  let balance = supplier.balance ?? 0;
  const inc = { totalPurchased: 0, totalReturned: 0, totalPaid: 0, totalRefunded: 0 };
  return {
    get balance() {
      return balance;
    },
    /** @param {{ type: "opening" | "purchase" | "payment" | "return" | "refund" | "adjustment", debit?: number, credit?: number, refType: string, refId: string, refNumber: string, note?: string, actorUid: string }} e */
    append({ type, debit = 0, credit = 0, refType, refId, refNumber, note = "", actorUid }) {
      balance += credit - debit;
      if (type === "purchase") inc.totalPurchased += credit;
      if (type === "return") inc.totalReturned += debit;
      if (type === "payment") inc.totalPaid += debit;
      if (type === "refund") inc.totalRefunded += credit;
      tx.create(db.collection("supplierLedger").doc(), { supplierId: supplierRef.id, type, debit, credit, balanceAfter: balance, refType, refId, refNumber, note, actorUid, at: FieldValue.serverTimestamp() });
    },
    finish() {
      tx.update(supplierRef, {
        balance,
        totalPurchased: FieldValue.increment(inc.totalPurchased),
        totalReturned: FieldValue.increment(inc.totalReturned),
        totalPaid: FieldValue.increment(inc.totalPaid),
        totalRefunded: FieldValue.increment(inc.totalRefunded),
        updatedAt: FieldValue.serverTimestamp(),
      });
    },
  };
}

/**
 * Create or edit a supplier. The opening balance can only be set when the supplier is created.
 * @param {Record<string, any> & { id?: string }} input validated saveSupplierInput
 * @param {string} actorUid
 */
export async function saveSupplier(input, actorUid) {
  const { id, openingBalance, ...data } = input;
  const ref = id ? db.collection("suppliers").doc(id) : db.collection("suppliers").doc();
  const nameLower = data.name.toLowerCase();

  await db.runTransaction(async (tx) => {
    const [current, clash] = await Promise.all([id ? tx.get(ref) : null, tx.get(db.collection("suppliers").where("nameLower", "==", nameLower).limit(2))]);
    if (id && !current.exists) throw new AppError("not-found", "That supplier no longer exists.");
    if (clash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `A supplier called "${data.name}" already exists.`, { fields: { name: "Already exists" } });
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };

    if (current) {
      tx.update(ref, { ...data, nameLower, ...stamp });
    } else {
      tx.create(ref, { ...data, nameLower, openingBalance, balance: 0, totalPurchased: 0, totalReturned: 0, totalPaid: 0, isActive: true, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid, ...stamp });
      if (openingBalance > 0) {
        const ledger = ledgerWriter(tx, ref, { balance: 0 });
        ledger.append({ type: "opening", credit: openingBalance, refType: "supplier", refId: ref.id, refNumber: "Opening balance", note: "Amount owed when the supplier was added", actorUid });
        ledger.finish();
      }
    }
    writeAudit({ actorUid, action: current ? "supplier.updated" : "supplier.created", entityType: "supplier", entityId: ref.id, changes: current ? { name: data.name } : { name: data.name, openingBalance } }, tx);
  });
  return { id: ref.id };
}

/**
 * Switch a supplier on or off. A switched-off supplier gets no new purchase orders, but its history, ledger and
 * any outstanding balance stay, and payments can still be recorded.
 * @param {{ id: string, isActive: boolean }} input @param {string} actorUid
 */
export async function setSupplierActive({ id, isActive }, actorUid) {
  const ref = db.collection("suppliers").doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That supplier no longer exists.");
    tx.update(ref, { isActive, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    writeAudit({ actorUid, action: isActive ? "supplier.activated" : "supplier.deactivated", entityType: "supplier", entityId: id, changes: { isActive } }, tx);
  });
  return { id, isActive };
}
