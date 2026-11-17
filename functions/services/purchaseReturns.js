/**
 * Purchase returns: goods sent back to a supplier. The ONLY code that records them.
 *
 *   purchaseReturns/{id}   number, GRN, supplier, warehouse, lines[], value, reason, supplier reference, who/when
 *   counters/purchaseReturns   { next }   (PR-000001 …)
 *
 * A return is made against one goods receipt, so it takes the pairs out of the SAME warehouse they went into
 * and is valued at what that receipt valued them. In one transaction it:
 *   - checks each line against what the receipt accepted minus what was already returned (no double returns);
 *   - takes the stock out through the stock service (refused if the warehouse no longer holds the pairs);
 *   - writes a ledger debit (the store owes the supplier less) and updates the order's returned value;
 *   - is idempotent: the same key returns the first return.
 * The moving-average cost is left unchanged by a return: the pairs leave at the current average, so the
 * remaining stock's average cost stays the same.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { cumulativeValue, paymentStatusOf } from "../shared/purchase.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext } from "./inventory.js";
import { ledgerWriter } from "./suppliers.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { purchaseReturnSpec } from "./accountingRules.js";

/**
 * @param {Record<string, any>} input validated purchaseReturnInput
 * @param {string} actorUid
 */
export async function createPurchaseReturn(input, actorUid) {
  const { idempotencyKey, grnId, reason, supplierReference, lines } = input;
  const idemRef = db.collection("idempotency").doc(`ret__${actorUid}__${idempotencyKey}`);
  const grnRef = db.collection("goodsReceipts").doc(grnId);
  const retRef = db.collection("purchaseReturns").doc();
  const counterRef = db.collection("counters").doc("purchaseReturns");

  return db.runTransaction(async (tx) => {
    const [idem, grnSnap] = await Promise.all([tx.get(idemRef), tx.get(grnRef)]);
    if (idem.exists) return { returnId: idem.data().returnId, number: idem.data().number, existing: true };
    if (!grnSnap.exists) throw new AppError("not-found", "That goods receipt no longer exists.");
    const grn = grnSnap.data();

    const items = lines.map((l) => {
      const line = grn.lines[l.lineIndex];
      if (!line) throw new AppError("invalid-argument", "A line isn't on that goods receipt.");
      const returnable = line.acceptedQty - line.returnedQty;
      if (l.qty > returnable) {
        throw new AppError("failed-precondition", `${line.productName} (${line.variantLabel}): only ${returnable} can still be returned (received ${line.acceptedQty}, already returned ${line.returnedQty}).`, { fields: { lines: "More than can be returned" } });
      }
      const value = cumulativeValue(line.value, line.acceptedQty, line.returnedQty + l.qty) - cumulativeValue(line.value, line.acceptedQty, line.returnedQty);
      return { ...l, line, value };
    });

    const [counter, supplierSnap, poSnap, warehouses, settings, acc, ...stocks] = await Promise.all([
      tx.get(counterRef),
      tx.get(db.collection("suppliers").doc(grn.supplierId)),
      tx.get(db.collection("purchaseOrders").doc(grn.purchaseOrderId)),
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      readAccounting(tx),
      ...items.map((i) => readStock(tx, i.line.productId, i.line.variantId)),
    ]);
    if (!supplierSnap.exists) throw new AppError("failed-precondition", "The supplier no longer exists.");

    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `PR-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });

    const stockCtx = createStockContext(warehouses);
    items.forEach((i, k) =>
      writeStockChange(tx, stocks[k], { change: -i.qty, reason: "purchase_return", note: `${number} · ${grn.number}`, actorUid, settings: settings.data(), ctx: stockCtx, warehouseId: grn.warehouseId, sourceType: "purchase_return", sourceId: retRef.id }),
    );
    flushStockContext(tx, stockCtx);

    const total = items.reduce((n, i) => n + i.value, 0);
    const newLines = grn.lines.map((l) => ({ ...l }));
    for (const i of items) {
      newLines[i.lineIndex].returnedQty += i.qty;
      newLines[i.lineIndex].returnedValue += i.value;
    }
    tx.update(grnRef, { lines: newLines, returnedValue: (grn.returnedValue ?? 0) + total });
    if (poSnap.exists) {
      const po = poSnap.data();
      const returnedValue = (po.returnedValue ?? 0) + total;
      tx.update(poSnap.ref, { returnedValue, paymentStatus: paymentStatusOf({ receivedValue: po.receivedValue ?? 0, returnedValue, paidTotal: po.paidTotal ?? 0 }), updatedAt: FieldValue.serverTimestamp() });
    }
    if (total > 0) {
      const ledger = ledgerWriter(tx, supplierSnap.ref, supplierSnap.data());
      ledger.append({ type: "return", debit: total, refType: "purchase_return", refId: retRef.id, refNumber: number, note: `${grn.number}${supplierReference ? ` · ${supplierReference}` : ""}`, actorUid });
      ledger.finish();
    }
    tx.create(retRef, {
      number,
      grnId,
      grnNumber: grn.number,
      purchaseOrderId: grn.purchaseOrderId,
      purchaseOrderNumber: grn.purchaseOrderNumber,
      supplierId: grn.supplierId,
      supplierName: grn.supplierName,
      warehouseId: grn.warehouseId,
      warehouseName: grn.warehouseName,
      lines: items.map((i) => ({ lineIndex: i.lineIndex, productId: i.line.productId, variantId: i.line.variantId, sku: i.line.sku, productName: i.line.productName, variantLabel: i.line.variantLabel, qty: i.qty, value: i.value })),
      units: items.reduce((n, i) => n + i.qty, 0),
      value: total,
      reason,
      supplierReference,
      returnedBy: actorUid,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (total > 0) postInTx(tx, acc, purchaseReturnSpec(retRef.id, { number, supplierName: grn.supplierName, supplierId: grn.supplierId, grnNumber: grn.number, value: total, createdAt: new Date() }), actorUid);
    finishAccounting(tx, acc);
    tx.create(idemRef, { returnId: retRef.id, number, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "purchase_return.created", entityType: "purchase_return", entityId: retRef.id, changes: { number, grn: grn.number, value: total } }, tx);
    return { returnId: retRef.id, number, value: total, existing: false };
  });
}
