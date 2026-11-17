/**
 * Purchase orders. The ONLY code that creates or changes them (goods receipts update the received
 * quantities from services/goodsReceipts.js).
 *
 *   purchaseOrders/{id}   number, supplier, destination warehouse, status, lines[], money totals
 *   counters/purchaseOrders   { next }   (PO-000001 …)
 *
 * Status:  draft ──approve──▶ ordered ──receive──▶ partially_received ──▶ received
 *            │                  │                          └──close──▶ closed (stop waiting for the rest)
 *            └──cancel──▶ cancelled ◀──cancel (only while nothing has been received)
 *
 * All money is recalculated here from the unit costs and discounts (shared/purchase.js); totals sent by
 * the browser are never trusted. A draft is editable; once ordered, the lines are fixed.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { priceOrder } from "../shared/purchase.js";
import { readWarehouses } from "./inventory.js";

const orders = () => db.collection("purchaseOrders");

/** Names and SKUs are copied onto the order, so it stays readable if a product is renamed later. */
async function describeLines(lines) {
  const variantSnaps = await db.getAll(...lines.map((l) => db.collection("products").doc(l.productId).collection("variants").doc(l.variantId)));
  const productSnaps = await db.getAll(...[...new Set(lines.map((l) => l.productId))].map((id) => db.collection("products").doc(id)));
  const names = new Map(productSnaps.map((p) => [p.id, p.exists ? p.data().name : null]));
  return lines.map((l, i) => {
    const v = variantSnaps[i];
    if (!v.exists || !names.get(l.productId)) throw new AppError("invalid-argument", "One of the items doesn't exist any more. Remove it and try again.", { fields: { lines: "Item not found" } });
    return { productName: names.get(l.productId), variantLabel: `${v.data().colorName ?? ""} / ${v.data().sizeLabel ?? ""}`.trim(), sku: v.data().sku };
  });
}

/**
 * Create or edit a DRAFT purchase order.
 * @param {Record<string, any> & { id?: string }} input validated savePurchaseOrderInput
 * @param {string} actorUid
 */
export async function savePurchaseOrder(input, actorUid) {
  const { id, supplierId, warehouseId, supplierReference, expectedDate, purchaseDate = "", note, discount, lines, taxPercent = 0, charges = [], attachments = [] } = input;
  const chargesTotal = charges.reduce((n, c) => n + c.amount, 0);
  let priced;
  try {
    priced = priceOrder(lines, discount, { taxPercent, charges: chargesTotal });
  } catch (error) {
    throw new AppError("invalid-argument", /** @type {Error} */ (error).message, { fields: { discount: /** @type {Error} */ (error).message } });
  }
  const described = await describeLines(lines);
  const ref = id ? orders().doc(id) : orders().doc();
  const counterRef = db.collection("counters").doc("purchaseOrders");

  await db.runTransaction(async (tx) => {
    const [current, counter, supplier, warehouses] = await Promise.all([id ? tx.get(ref) : null, id ? null : tx.get(counterRef), tx.get(db.collection("suppliers").doc(supplierId)), readWarehouses(tx)]);
    if (id && !current.exists) throw new AppError("not-found", "That purchase order no longer exists.");
    if (current && current.data().status !== "draft") throw new AppError("failed-precondition", "Only a draft can be edited.");
    if (!supplier.exists) throw new AppError("invalid-argument", "Choose a supplier that exists.", { fields: { supplierId: "Not found" } });
    if (supplier.data().isActive === false) throw new AppError("failed-precondition", `${supplier.data().name} is switched off.`, { fields: { supplierId: "Switched off" } });
    const w = warehouses.get(warehouseId);
    if (!w) throw new AppError("invalid-argument", "Choose a warehouse that exists.", { fields: { warehouseId: "Not found" } });
    if (w.isActive === false) throw new AppError("failed-precondition", `${w.name} is switched off.`, { fields: { warehouseId: "Switched off" } });

    const body = {
      supplierId,
      supplierName: supplier.data().name,
      warehouseId,
      warehouseName: w.name,
      supplierReference,
      expectedDate,
      purchaseDate,
      note,
      taxPercent,
      taxTotal: priced.taxTotal,
      charges,
      chargesTotal: priced.chargesTotal,
      attachments,
      lines: lines.map((l, i) => ({
        productId: l.productId,
        variantId: l.variantId,
        ...described[i],
        qty: l.qty,
        unitCost: l.unitCost,
        discount: priced.lines[i].discount,
        gross: priced.lines[i].gross,
        net: priced.lines[i].net,
        allocatedDiscount: priced.lines[i].allocatedDiscount,
        allocatedExtra: priced.lines[i].allocatedExtra,
        effective: priced.lines[i].effective,
        receivedQty: 0,
        rejectedQty: 0,
        receivedValue: 0,
      })),
      itemCount: lines.reduce((n, l) => n + l.qty, 0),
      subtotal: priced.subtotal,
      orderDiscount: priced.orderDiscount,
      total: priced.total,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    };
    if (current) tx.update(ref, body);
    else {
      const seq = (counter.exists ? counter.data().next : 1) ?? 1;
      tx.set(counterRef, { next: seq + 1 });
      tx.create(ref, { ...body, number: `PO-${String(seq).padStart(6, "0")}`, status: "draft", receivedValue: 0, returnedValue: 0, paidTotal: 0, paymentStatus: "unpaid", createdAt: FieldValue.serverTimestamp(), createdBy: actorUid });
    }
    writeAudit({ actorUid, action: current ? "purchase_order.updated" : "purchase_order.created", entityType: "purchase_order", entityId: ref.id, changes: { supplierId, total: priced.total, lines: lines.length } }, tx);
  });
  return { id: ref.id, total: priced.total };
}

/** One status step in a transaction that re-reads the order (double clicks and parallel requests can't repeat a step). */
async function step(id, actorUid, { from, to, action, check }) {
  const ref = orders().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That purchase order no longer exists.");
    const po = snap.data();
    if (!from.includes(po.status)) throw new AppError("failed-precondition", `A purchase order that is ${po.status.replace("_", " ")} can't be ${action}.`);
    const extra = check ? await check(tx, po) : {};
    tx.update(ref, { status: to, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid, ...extra });
    writeAudit({ actorUid, action: `purchase_order.${action}`, entityType: "purchase_order", entityId: id, changes: { number: po.number, from: po.status, to } }, tx);
    return { id, status: to };
  });
}

/** Approve a draft: it is now an order placed with the supplier and goods can be received against it. */
export function approvePurchaseOrder({ id }, actorUid) {
  return step(id, actorUid, {
    from: ["draft"],
    to: "ordered",
    action: "approved",
    async check(tx, po) {
      const [supplier, warehouses] = await Promise.all([tx.get(db.collection("suppliers").doc(po.supplierId)), readWarehouses(tx)]);
      if (!supplier.exists || supplier.data().isActive === false) throw new AppError("failed-precondition", "The supplier is switched off. Switch it on, or choose another supplier.");
      if (warehouses.get(po.warehouseId)?.isActive === false) throw new AppError("failed-precondition", "The destination warehouse is switched off.");
      return { orderedAt: FieldValue.serverTimestamp(), orderedBy: actorUid };
    },
  });
}

/** Cancel a draft, or an ordered purchase order that nothing has been received against. */
export function cancelPurchaseOrder({ id }, actorUid) {
  return step(id, actorUid, { from: ["draft", "ordered"], to: "cancelled", action: "cancelled", check: async () => ({ cancelledAt: FieldValue.serverTimestamp(), cancelledBy: actorUid }) });
}

/** Close a part-received order: the rest is not coming. Received stock and money are unchanged. */
export function closePurchaseOrder({ id }, actorUid) {
  return step(id, actorUid, { from: ["partially_received"], to: "closed", action: "closed", check: async () => ({ closedAt: FieldValue.serverTimestamp(), closedBy: actorUid }) });
}
