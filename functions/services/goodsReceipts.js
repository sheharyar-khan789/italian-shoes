/**
 * Goods received notes (GRN). The ONLY code that puts purchased stock on the shelf.
 *
 *   goodsReceipts/{id}      number, purchase order, supplier, warehouse, lines[], value, who/when, key
 *   variantCostHistory/{id} append-only: every purchase's cost and the average before/after
 *   counters/grn            { next }  (GRN-000001 …)
 *
 * One transaction receives a delivery. In it, and only if every check passes:
 *   - accepted pairs go into the purchase order's warehouse (stock service → movement with the GRN as source);
 *   - the variant's moving-average cost is recalculated (shared/purchase.js) and a history line is written;
 *   - the supplier's ledger is credited with the value of the ACCEPTED pairs (rejected/damaged pairs are not
 *     stocked and not owed);
 *   - the purchase order's received/rejected quantities and status are updated.
 * Quantities can't exceed what is still pending, and a repeated request (same idempotency key) returns the
 * first GRN instead of receiving twice, so stock only ever goes up once per delivery.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { receiptValue, movingAverage, paymentStatusOf } from "../shared/purchase.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext, entriesOf, totalsOf } from "./inventory.js";
import { inventoryId } from "./products.js";
import { ledgerWriter } from "./suppliers.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { grnSpec } from "./accountingRules.js";

/**
 * @param {Record<string, any>} input validated receiveGoodsInput
 * @param {string} actorUid
 */
export async function receiveGoods(input, actorUid) {
  const { idempotencyKey, purchaseOrderId, supplierInvoiceNo, note, lines } = input;
  const receivedDate = input.receivedDate ?? new Date();
  const idemRef = db.collection("idempotency").doc(`grn__${actorUid}__${idempotencyKey}`);
  const poRef = db.collection("purchaseOrders").doc(purchaseOrderId);
  const grnRef = db.collection("goodsReceipts").doc();
  const counterRef = db.collection("counters").doc("grn");

  return db.runTransaction(async (tx) => {
    const [idem, poSnap] = await Promise.all([tx.get(idemRef), tx.get(poRef)]);
    if (idem.exists) return { grnId: idem.data().grnId, number: idem.data().number, existing: true };
    if (!poSnap.exists) throw new AppError("not-found", "That purchase order no longer exists.");
    const po = poSnap.data();
    if (!["ordered", "partially_received"].includes(po.status)) {
      throw new AppError("failed-precondition", po.status === "draft" ? "Approve the purchase order before receiving goods." : `This purchase order is ${po.status.replace("_", " ")}, so goods can't be received against it.`);
    }

    // Check every line against what is still pending BEFORE reading stock (cheap, and clear messages).
    const items = lines
      .filter((l) => l.acceptedQty + l.rejectedQty > 0)
      .map((l) => {
        const line = po.lines[l.lineIndex];
        if (!line) throw new AppError("invalid-argument", "A line on this delivery isn't on the purchase order.");
        const pending = line.qty - line.receivedQty - line.rejectedQty;
        if (l.acceptedQty + l.rejectedQty > pending) {
          throw new AppError("failed-precondition", `${line.productName} (${line.variantLabel}): only ${pending} still to receive, you entered ${l.acceptedQty + l.rejectedQty}.`, { fields: { lines: "More than ordered" } });
        }
        return { ...l, line };
      });

    const accepted = items.filter((i) => i.acceptedQty > 0);
    const [counter, supplierSnap, warehouses, settings, acc, ...rest] = await Promise.all([
      tx.get(counterRef),
      tx.get(db.collection("suppliers").doc(po.supplierId)),
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      readAccounting(tx),
      ...accepted.map((i) => readStock(tx, i.line.productId, i.line.variantId)),
      ...accepted.map((i) => tx.get(db.collection("variantCosts").doc(inventoryId(i.line.productId, i.line.variantId)))),
    ]);
    const stocks = rest.slice(0, accepted.length);
    const costs = rest.slice(accepted.length);
    if (!supplierSnap.exists) throw new AppError("failed-precondition", "The supplier no longer exists.");

    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `GRN-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });

    const stockCtx = createStockContext(warehouses);
    const newLines = po.lines.map((l) => ({ ...l }));
    const grnLines = [];
    let total = 0;

    items.forEach((i) => {
      const poLine = newLines[i.lineIndex];
      const value = i.acceptedQty > 0 ? receiptValue(poLine.effective, poLine.qty, poLine.receivedQty, i.acceptedQty) : 0;
      let costBefore = null;
      let costAfter = null;

      if (i.acceptedQty > 0) {
        const k = accepted.indexOf(i);
        const stock = stocks[k];
        const costDoc = costs[k];
        if (!stock.inv.exists || !stock.variant.exists) throw new AppError("failed-precondition", `${i.line.productName} (${i.line.variantLabel}) no longer exists, so it can't be received.`);
        const onHandQty = totalsOf(entriesOf(stock.inv), warehouses).totalOnHand;
        costBefore = costDoc.exists ? costDoc.data().costPrice ?? null : null;
        costAfter = movingAverage({ onHandQty, currentAvg: costBefore, addQty: i.acceptedQty, addValue: value });
        writeStockChange(tx, stock, {
          change: i.acceptedQty,
          reason: "purchase_receipt",
          note: `${number} · ${po.number}`,
          actorUid,
          settings: settings.data(),
          ctx: stockCtx,
          warehouseId: po.warehouseId,
          sourceType: "grn",
          sourceId: grnRef.id,
        });
        // Current cost = the moving average (this is also what the product page shows); the history keeps every purchase.
        tx.set(
          costDoc.ref,
          { productId: i.line.productId, variantId: i.line.variantId, costPrice: costAfter, costMethod: "moving_average", lastPurchaseCost: Math.round(value / i.acceptedQty), lastPurchaseAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid },
          { merge: true },
        );
        tx.create(db.collection("variantCostHistory").doc(), {
          productId: i.line.productId,
          variantId: i.line.variantId,
          source: "grn",
          sourceId: grnRef.id,
          sourceNumber: number,
          supplierId: po.supplierId,
          qty: i.acceptedQty,
          value,
          unitCost: Math.round(value / i.acceptedQty),
          onHandBefore: onHandQty,
          costBefore,
          costAfter,
          at: FieldValue.serverTimestamp(),
        });
      }

      poLine.receivedQty += i.acceptedQty;
      poLine.rejectedQty += i.rejectedQty;
      poLine.receivedValue += value;
      total += value;
      grnLines.push({
        lineIndex: i.lineIndex,
        productId: poLine.productId,
        variantId: poLine.variantId,
        sku: poLine.sku,
        productName: poLine.productName,
        variantLabel: poLine.variantLabel,
        orderedQty: poLine.qty,
        acceptedQty: i.acceptedQty,
        rejectedQty: i.rejectedQty,
        rejectReason: i.rejectReason ?? "",
        rejectKind: i.rejectedQty > 0 ? i.rejectKind ?? "damaged" : null,
        value,
        unitCost: i.acceptedQty > 0 ? Math.round(value / i.acceptedQty) : 0,
        costBefore,
        costAfter,
        returnedQty: 0,
        returnedValue: 0,
      });
    });
    flushStockContext(tx, stockCtx);

    const pendingLeft = newLines.reduce((n, l) => n + (l.qty - l.receivedQty - l.rejectedQty), 0);
    const status = pendingLeft === 0 ? "received" : "partially_received";
    const receivedValue = po.receivedValue + total;
    tx.update(poRef, { lines: newLines, status, receivedValue, paymentStatus: paymentStatusOf({ receivedValue, returnedValue: po.returnedValue ?? 0, paidTotal: po.paidTotal ?? 0 }), updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });

    if (total > 0) {
      const ledger = ledgerWriter(tx, supplierSnap.ref, supplierSnap.data());
      ledger.append({ type: "purchase", credit: total, refType: "grn", refId: grnRef.id, refNumber: number, note: `${po.number}${supplierInvoiceNo ? ` · invoice ${supplierInvoiceNo}` : ""}`, actorUid });
      ledger.finish();
    }

    tx.create(grnRef, {
      number,
      purchaseOrderId,
      purchaseOrderNumber: po.number,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      warehouseId: po.warehouseId,
      warehouseName: po.warehouseName,
      supplierInvoiceNo,
      note,
      lines: grnLines,
      acceptedUnits: grnLines.reduce((n, l) => n + l.acceptedQty, 0),
      rejectedUnits: grnLines.reduce((n, l) => n + l.rejectedQty, 0),
      value: total,
      returnedValue: 0,
      receivedDate,
      receivedBy: actorUid,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (total > 0) postInTx(tx, acc, grnSpec(grnRef.id, { number, supplierName: po.supplierName, supplierId: po.supplierId, purchaseOrderNumber: po.number, receivedDate, value: total }), actorUid);
    finishAccounting(tx, acc);
    tx.create(idemRef, { grnId: grnRef.id, number, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: "grn.received", entityType: "goods_receipt", entityId: grnRef.id, changes: { number, purchaseOrder: po.number, value: total, accepted: grnLines.reduce((n, l) => n + l.acceptedQty, 0), rejected: grnLines.reduce((n, l) => n + l.rejectedQty, 0) } }, tx);
    return { grnId: grnRef.id, number, status, existing: false };
  });
}
