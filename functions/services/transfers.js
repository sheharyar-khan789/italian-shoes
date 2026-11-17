/**
 * Stock transfers between warehouses. The ONLY code that moves stock from one warehouse to another.
 *
 *   stockTransfers/{id}   number, fromWarehouseId, toWarehouseId, status, lines[], note, who/when
 *   counters/transfers    { next }   (TR-000001, TR-000002 …)
 *
 * Lifecycle (each step is ONE Firestore transaction that re-reads the transfer, so a double click or two
 * people acting at once can never apply a step twice):
 *
 *   draft ──request──▶ requested ──send──▶ in_transit ──receive──▶ partially_received ──receive──▶ received
 *     └──cancel──▶ cancelled   (a draft may also be sent directly; "requested" is the confirmation step)
 *
 *   send      takes the pairs out of the source warehouse (refused if it doesn't hold them). From now on the
 *             pairs live on this transfer ("in transit"): they are in no warehouse and can't be sold.
 *   receive   puts the pairs that arrived into the destination warehouse. receiveTransfer() takes everything still on the
 *             transfer; receiveTransferLines() takes what actually arrived, in one or several deliveries, and records
 *             pairs that arrived damaged or never arrived (written off at cost: the pairs already left the source).
 *   cancel    only for drafts and requests (no stock has moved yet).
 * A transfer can't be cancelled once sent, so stock is never lost or duplicated half-way.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext } from "./inventory.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { stockAdjustmentSpec } from "./accountingRules.js";
import { inventoryId } from "./products.js";

const transfers = () => db.collection("stockTransfers");

/** Names and SKUs are copied onto the transfer, so it stays readable if a product is renamed later. */
async function describeLines(lines) {
  const variantSnaps = await db.getAll(...lines.map((l) => db.collection("products").doc(l.productId).collection("variants").doc(l.variantId)));
  const productSnaps = await db.getAll(...[...new Set(lines.map((l) => l.productId))].map((id) => db.collection("products").doc(id)));
  const names = new Map(productSnaps.map((p) => [p.id, p.exists ? p.data().name : null]));
  return lines.map((l, i) => {
    const v = variantSnaps[i];
    if (!v.exists || !names.get(l.productId)) throw new AppError("invalid-argument", "One of the items doesn't exist any more. Remove it and try again.", { fields: { lines: "Item not found" } });
    return { productId: l.productId, variantId: l.variantId, sku: v.data().sku, productName: names.get(l.productId), variantLabel: `${v.data().colorName ?? ""} / ${v.data().sizeLabel ?? ""}`.trim(), qty: l.qty };
  });
}

/**
 * Create or edit a DRAFT transfer. Nothing moves yet.
 * @param {Record<string, any> & { id?: string }} input validated saveTransferInput
 * @param {string} actorUid
 */
export async function saveTransfer(input, actorUid) {
  const { id, fromWarehouseId, toWarehouseId, note, lines } = input;
  const described = await describeLines(lines);
  const ref = id ? transfers().doc(id) : transfers().doc();
  const counterRef = db.collection("counters").doc("transfers");

  await db.runTransaction(async (tx) => {
    const [current, counter, warehouses] = await Promise.all([id ? tx.get(ref) : null, id ? null : tx.get(counterRef), readWarehouses(tx)]);
    if (id && !current.exists) throw new AppError("not-found", "That transfer no longer exists.");
    if (current && current.data().status !== "draft") throw new AppError("failed-precondition", "Only a draft transfer can be edited.");
    for (const [field, wid] of [["fromWarehouseId", fromWarehouseId], ["toWarehouseId", toWarehouseId]]) {
      const w = warehouses.get(wid);
      if (!w) throw new AppError("invalid-argument", "Choose a warehouse that exists.", { fields: { [field]: "Not found" } });
      if (w.isActive === false) throw new AppError("failed-precondition", `${w.name} is switched off.`, { fields: { [field]: "Switched off" } });
    }
    const body = {
      fromWarehouseId,
      toWarehouseId,
      fromName: warehouses.get(fromWarehouseId).name,
      toName: warehouses.get(toWarehouseId).name,
      note,
      lines: described,
      itemCount: described.reduce((n, l) => n + l.qty, 0),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    };
    if (current) tx.update(ref, body);
    else {
      const seq = (counter.exists ? counter.data().next : 1) ?? 1;
      tx.set(counterRef, { next: seq + 1 });
      tx.create(ref, { ...body, number: `TR-${String(seq).padStart(6, "0")}`, status: "draft", createdAt: FieldValue.serverTimestamp(), createdBy: actorUid });
    }
    writeAudit({ actorUid, action: current ? "transfer.updated" : "transfer.created", entityType: "transfer", entityId: ref.id, changes: { from: fromWarehouseId, to: toWarehouseId, lines: described.length } }, tx);
  });
  return { id: ref.id };
}

/**
 * Run one step of the lifecycle in a transaction.
 * @param {string} id @param {string} actorUid
 * @param {{ from: string | string[], to: string, action: string, apply?: (ctx: { tx: FirebaseFirestore.Transaction, transfer: any, stocks: any[], warehouses: Map<string, any>, settings: any, actorUid: string }) => void }} step
 */
async function step(id, actorUid, { from, to, action, apply }) {
  const ref = transfers().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That transfer no longer exists.");
    const transfer = snap.data();
    if (![].concat(from).includes(transfer.status)) {
      const said = { in_transit: "was already sent", partially_received: "was partly received", received: "was already received", cancelled: "was cancelled", draft: "hasn't been sent yet", requested: "has only been requested" }[transfer.status];
      throw new AppError("failed-precondition", `This transfer ${said ?? "can't be changed"}.`);
    }
    const [warehouses, settings, ...stocks] = await Promise.all([
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      ...(apply ? transfer.lines.map((l) => readStock(tx, l.productId, l.variantId)) : []),
    ]);
    apply?.({ tx, transfer, stocks, warehouses, settings: settings.data(), actorUid });
    tx.update(ref, { status: to, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid, ...stamps(to, actorUid) });
    writeAudit({ actorUid, action: `transfer.${action}`, entityType: "transfer", entityId: id, changes: { number: transfer.number, items: transfer.itemCount } }, tx);
    return { id, status: to };
  });
}

const stamps = (to, uid) =>
  to === "requested" ? { requestedAt: FieldValue.serverTimestamp(), requestedBy: uid } : to === "in_transit" ? { sentAt: FieldValue.serverTimestamp(), sentBy: uid } : to === "received" ? { receivedAt: FieldValue.serverTimestamp(), receivedBy: uid } : { cancelledAt: FieldValue.serverTimestamp(), cancelledBy: uid };

/** Take the pairs out of the source warehouse and mark the transfer as on its way. @param {{ id: string }} input @param {string} actorUid */
export function sendTransfer({ id }, actorUid) {
  return step(id, actorUid, {
    from: ["draft", "requested"],
    to: "in_transit",
    action: "sent",
    apply({ tx, transfer, stocks, warehouses, settings, actorUid: by }) {
      for (const wid of [transfer.fromWarehouseId, transfer.toWarehouseId]) {
        if (warehouses.get(wid)?.isActive === false) throw new AppError("failed-precondition", `${warehouses.get(wid).name} is switched off.`);
      }
      const ctx = createStockContext(warehouses);
      stocks.forEach((stock, i) => {
        const l = transfer.lines[i];
        writeStockChange(tx, stock, { change: -l.qty, reason: "transfer_out", note: `${transfer.number} → ${transfer.toName}`, actorUid: by, settings, ctx, warehouseId: transfer.fromWarehouseId, sourceType: "transfer", sourceId: id });
      });
      flushStockContext(tx, ctx);
    },
  });
}

/** Put the pairs into the destination warehouse. Receiving twice is refused. @param {{ id: string }} input @param {string} actorUid */
export async function receiveTransfer({ id }, actorUid) {
  const snap = await transfers().doc(id).get();
  if (snap.exists && snap.data().status === "received") throw new AppError("failed-precondition", "This transfer was already received.");
  if (snap.exists && snap.data().status === "partially_received") {
    const t = snap.data();
    return receiveTransferLines({ idempotencyKey: `rest${id}${Date.now()}`.slice(0, 80), id, lines: t.lines.map((l, i) => ({ lineIndex: i, receivedQty: l.qty - (l.receivedQty ?? 0) - (l.damagedQty ?? 0) - (l.missingQty ?? 0), damagedQty: 0, missingQty: 0 })).filter((l) => l.receivedQty > 0), note: "Rest received" }, { uid: actorUid, name: actorUid });
  }
  return step(id, actorUid, {
    from: "in_transit",
    to: "received",
    action: "received",
    apply({ tx, transfer, stocks, warehouses, settings, actorUid: by }) {
      const ctx = createStockContext(warehouses);
      tx.update(transfers().doc(id), { lines: transfer.lines.map((l) => ({ ...l, receivedQty: l.qty, damagedQty: 0, missingQty: 0 })) });
      stocks.forEach((stock, i) => {
        const l = transfer.lines[i];
        writeStockChange(tx, stock, { change: l.qty, reason: "transfer_in", note: `${transfer.number} ← ${transfer.fromName}`, actorUid: by, settings, ctx, warehouseId: transfer.toWarehouseId, sourceType: "transfer", sourceId: id });
      });
      flushStockContext(tx, ctx);
    },
  });
}

/** Cancel a draft. Nothing has moved, so nothing needs undoing. @param {{ id: string }} input @param {string} actorUid */
export function cancelTransfer({ id }, actorUid) {
  return step(id, actorUid, { from: ["draft", "requested"], to: "cancelled", action: "cancelled" });
}

/** Ask for the stock (the confirmation step before dispatch). Nothing moves. @param {{ id: string }} input @param {string} actorUid */
export function requestTransfer({ id }, actorUid) {
  return step(id, actorUid, { from: "draft", to: "requested", action: "requested" });
}

/**
 * Receive a dispatched transfer in whole or in part. For each line: pairs that arrived go into the destination
 * warehouse; pairs that arrived damaged or never arrived are written off at the average cost (they had already left the
 * source). A line can't take more than is still outstanding. Repeating the same request (same key) does nothing more.
 * @param {Record<string, any>} input validated receiveTransferLinesInput @param {{ uid: string, name: string }} actor
 */
export async function receiveTransferLines({ idempotencyKey, id, lines, note = "" }, actor) {
  const ref = transfers().doc(id);
  const idemRef = db.collection("idempotency").doc(`xfer__${actor.uid}__${idempotencyKey}`);
  const first = await ref.get();
  if (!first.exists) throw new AppError("not-found", "That transfer no longer exists.");
  const touched = lines.filter((l) => l.receivedQty > 0);
  return db.runTransaction(async (tx) => {
    const [idem, snap, warehouses, settings, acc, ...rest] = await Promise.all([
      tx.get(idemRef),
      tx.get(ref),
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      readAccounting(tx),
      ...touched.map((l) => readStock(tx, first.data().lines[l.lineIndex]?.productId ?? "x", first.data().lines[l.lineIndex]?.variantId ?? "x")),
      ...lines.filter((l) => l.damagedQty + l.missingQty > 0).map((l) => tx.get(db.collection("variantCosts").doc(inventoryId(first.data().lines[l.lineIndex]?.productId ?? "x", first.data().lines[l.lineIndex]?.variantId ?? "x")))),
    ]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const transfer = snap.data();
    if (!["in_transit", "partially_received"].includes(transfer.status)) throw new AppError("failed-precondition", transfer.status === "received" ? "This transfer was already received." : "This transfer hasn't been dispatched yet.");
    const stocks = rest.slice(0, touched.length);
    const costs = rest.slice(touched.length);
    const ctx = createStockContext(warehouses);
    const newLines = transfer.lines.map((l) => ({ ...l, receivedQty: l.receivedQty ?? 0, damagedQty: l.damagedQty ?? 0, missingQty: l.missingQty ?? 0 }));
    let lossValue = 0;
    let lossUnits = 0;
    lines.forEach((r) => {
      const line = newLines[r.lineIndex];
      if (!line) throw new AppError("invalid-argument", "A line on this delivery isn't on the transfer.");
      const outstanding = line.qty - line.receivedQty - line.damagedQty - line.missingQty;
      const total = r.receivedQty + r.damagedQty + r.missingQty;
      if (total > outstanding) throw new AppError("failed-precondition", `${line.productName} (${line.variantLabel}): only ${outstanding} still to account for, you entered ${total}.`, { fields: { lines: "More than is outstanding" } });
      if (r.receivedQty > 0) {
        const stock = stocks[touched.indexOf(touched.find((t) => t.lineIndex === r.lineIndex))];
        writeStockChange(tx, stock, { change: r.receivedQty, reason: "transfer_in", note: `${transfer.number} ← ${transfer.fromName}`, actorUid: actor.uid, settings: settings.data(), ctx, warehouseId: transfer.toWarehouseId, sourceType: "transfer", sourceId: id });
      }
      const lost = r.damagedQty + r.missingQty;
      if (lost > 0) {
        const costSnap = costs[lines.filter((l) => l.damagedQty + l.missingQty > 0).findIndex((l) => l.lineIndex === r.lineIndex)];
        const cost = costSnap?.exists ? costSnap.data().costPrice ?? null : null;
        const value = cost === null ? 0 : lost * cost;
        lossUnits += lost;
        if (value > 0) {
          lossValue += value;
          postInTx(tx, acc, stockAdjustmentSpec(`${id}_${idempotencyKey}_${r.lineIndex}`, { label: "Transfer shortfall", change: -lost, qty: lost, value, productName: line.productName, variantLabel: line.variantLabel, note: `${transfer.number}: ${r.damagedQty} damaged, ${r.missingQty} missing`, when: new Date() }), actor.uid);
        }
      }
      line.receivedQty += r.receivedQty;
      line.damagedQty += r.damagedQty;
      line.missingQty += r.missingQty;
    });
    flushStockContext(tx, ctx);
    finishAccounting(tx, acc);
    const complete = newLines.every((l) => l.qty - l.receivedQty - l.damagedQty - l.missingQty === 0);
    const status = complete ? "received" : "partially_received";
    const receipts = [...(transfer.receipts ?? []), { at: new Date().toISOString(), byUid: actor.uid, byName: actor.name, note, lines: lines.map((l) => ({ lineIndex: l.lineIndex, receivedQty: l.receivedQty, damagedQty: l.damagedQty, missingQty: l.missingQty })) }].slice(-30);
    tx.update(ref, { lines: newLines, status, receipts, ...(complete ? { receivedAt: FieldValue.serverTimestamp(), receivedBy: actor.uid } : {}), lossUnits: (transfer.lossUnits ?? 0) + lossUnits, lossValue: (transfer.lossValue ?? 0) + lossValue, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    writeAudit({ actorUid: actor.uid, action: "transfer.received_lines", entityType: "transfer", entityId: id, changes: { number: transfer.number, status, received: lines.reduce((n, l) => n + l.receivedQty, 0), damaged: lines.reduce((n, l) => n + l.damagedQty, 0), missing: lines.reduce((n, l) => n + l.missingQty, 0) } }, tx);
    const result = { id, status, lossUnits, lossValue };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

