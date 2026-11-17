/**
 * Walk-in (POS) returns, refunds and exchanges. The ONLY code that takes goods back from a POS sale.
 *
 *   salesReturns/{id}      one return: the sale, each line and its condition, the amounts, who and when
 *   counters/salesReturns  { next }   (SR-000001 …)
 *
 * One transaction, idempotent per key, does everything or nothing:
 *   - checks each line against the pairs sold minus pairs already returned (no double returns, even from two screens);
 *   - works out every amount on the server from the sale's own saved prices, discounts, tax and cost snapshot;
 *   - puts RESELLABLE pairs back where the sale took them from (damaged pairs are written off, not restocked);
 *   - settles the money: refunds only what the customer has actually paid beyond what they still owe, and shrinks
 *     the unpaid balance for the rest; a cash refund leaves the open register and is counted in it;
 *   - posts one balanced journal (revenue, discounts, tax, cost of goods, inventory, cash/bank/wallet, receivable);
 *   - records the audit entry and updates the sale, its payment record and its loyalty points.
 * Nothing already posted is edited. An exchange is this return plus a normal new sale: both are real records and
 * the register ends up with the net difference. The online-order return flow in orders.js is separate and unchanged.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { salePaymentFields } from "../shared/sales.js";
import { expectedCash } from "../shared/pos.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext } from "./inventory.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { saleReturnSpec } from "./accountingRules.js";
import { syncSale } from "./sales.js";
import * as crmInsights from "./crmInsights.js";

const rs = (paisa) => `Rs. ${(paisa / 100).toLocaleString("en-PK")}`;
/** The share of `amount` that belongs to units (from, to] of `qty`, so partial returns always add up to exactly the whole. */
const part = (amount, qty, from, to) => Math.round((amount * to) / qty) - Math.round((amount * from) / qty);

/**
 * Put `qty` returned pairs back across the warehouses the sale took them from, oldest allocation first.
 * @param {{ warehouseId: string, qty: number, returned?: number }[]} allocations @param {number} qty
 */
export function restockAllocations(allocations, qty) {
  let left = qty;
  const next = allocations.map((a) => ({ ...a }));
  /** @type {{ warehouseId: string, qty: number }[]} */
  const put = [];
  for (const a of next) {
    if (left <= 0) break;
    const take = Math.min(left, a.qty - (a.returned ?? 0));
    if (take > 0) {
      put.push({ warehouseId: a.warehouseId, qty: take });
      a.returned = (a.returned ?? 0) + take;
      left -= take;
    }
  }
  if (left > 0) throw new AppError("failed-precondition", "These pairs can't be matched to where the sale took them from.");
  return { put, next };
}

/**
 * @param {Record<string, any>} input validated posReturnInput
 * @param {{ uid: string, name: string }} actor
 */
export async function createPosReturn(input, actor) {
  const { idempotencyKey, saleId, sessionId = null, lines: asked, reason, refundMethod, exchange, reference = "" } = input;
  const idemRef = db.collection("idempotency").doc(`posret__${actor.uid}__${idempotencyKey}`);
  const saleRef = db.collection("sales").doc(saleId);
  const payRef = db.collection("payments").doc(saleId);
  const costRef = db.collection("saleCosts").doc(saleId);
  const retRef = db.collection("salesReturns").doc();
  const counterRef = db.collection("counters").doc("salesReturns");

  const result = await db.runTransaction(async (tx) => {
    const [idem, saleSnap, paySnap, costSnap, counter, sessionSnap, warehouses, priv, acc] = await Promise.all([
      tx.get(idemRef),
      tx.get(saleRef),
      tx.get(payRef),
      tx.get(costRef),
      tx.get(counterRef),
      sessionId ? tx.get(db.collection("registerSessions").doc(sessionId)) : null,
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      readAccounting(tx, { journals: [`sale__${saleId}`] }),
    ]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!saleSnap.exists) throw new AppError("not-found", "That sale doesn't exist.");
    const sale = saleSnap.data();
    if (sale.channel !== "pos") throw new AppError("failed-precondition", "This is an online order. Online returns are handled from the order screen.");
    if (sale.status !== "completed") throw new AppError("failed-precondition", `This sale is ${sale.status}, so nothing more can be taken back.`);
    if (!paySnap.exists) throw new AppError("failed-precondition", "This sale has no payment record, so it can't be refunded.");
    if (acc.enabled && !acc.journals.get(`sale__${saleId}`)?.exists) throw new AppError("failed-precondition", "This sale's accounting entry is missing. Resolve it under Accounting → Exceptions before taking goods back.");
    const pay = paySnap.data();
    const saleCost = costSnap.exists ? costSnap.data() : null;
    const costBooked = Boolean(saleCost?.costComplete) && (saleCost?.costTotal ?? 0) > 0;

    // What is coming back, line by line, from the sale's own saved figures.
    const items = asked.map((a) => {
      const line = sale.lines[a.lineIndex];
      if (!line) throw new AppError("invalid-argument", "That line isn't on this sale.");
      const before = line.returnedQty ?? 0;
      const returnable = line.qty - before;
      if (a.qty > returnable) throw new AppError("failed-precondition", `${line.productName} (${line.variantLabel}): only ${returnable} can still be taken back (sold ${line.qty}, already returned ${before}).`);
      const after = before + a.qty;
      const gross = line.regularPrice * a.qty;
      const itemDiscount = part(line.itemDiscount, line.qty, before, after);
      const coupon = part(line.couponShare, line.qty, before, after);
      const cost = costBooked && saleCost.costLines?.[a.lineIndex]?.costKnown ? saleCost.costLines[a.lineIndex].unitCost * a.qty : 0;
      return { ...a, line, before, after, gross, discounts: itemDiscount + coupon, net: gross - itemDiscount - coupon, cost };
    });
    const gross = items.reduce((n, i) => n + i.gross, 0);
    const discounts = items.reduce((n, i) => n + i.discounts, 0);
    const net = gross - discounts;
    const netBefore = sale.returnedNet ?? 0;
    const tax = sale.netSales > 0 ? part(sale.taxTotal, sale.netSales, netBefore, netBefore + net) : 0;
    const value = net + tax;
    if (value <= 0) throw new AppError("invalid-argument", "Nothing to refund for those pairs.");

    // Money: what the customer paid beyond what they still owe comes back; the rest just reduces what they owe.
    const returnedBefore = sale.returnedTotal ?? 0;
    const owedAfter = sale.total - returnedBefore - value;
    const netPaid = salePaymentFields(pay).paidTotal - (pay.refundedTotal ?? 0);
    const refund = Math.max(0, Math.min(value, netPaid - owedAfter));
    const receivableCredit = value - refund;
    if (refund > 0 && refundMethod === "cash") {
      if (!sessionSnap?.exists || sessionSnap.data().status !== "open") throw new AppError("failed-precondition", "A cash refund is paid from an open register. Open one first.", { fields: { sessionId: "Open register needed" } });
      if (sessionSnap.data().cashierUid !== actor.uid) throw new AppError("permission-denied", "That register belongs to someone else.");
      const inDrawer = expectedCash(sessionSnap.data());
      if (refund > inDrawer) throw new AppError("failed-precondition", `Only ${rs(inDrawer)} should be in this register, so a ${rs(refund)} cash refund can't be paid from it. Refund by bank or wallet, or add cash first.`);
    }
    if (sessionSnap && (!sessionSnap.exists || sessionSnap.data().status !== "open")) throw new AppError("failed-precondition", "That register isn't open.");

    // Stock: resellable pairs go back where they came from; damaged pairs are only written off.
    const restockItems = items.filter((i) => i.condition === "resellable");
    const stocks = await Promise.all(restockItems.map((i) => readStock(tx, i.line.productId, i.line.variantId)));
    const stockCtx = createStockContext(warehouses);
    const newLines = sale.lines.map((l) => ({ ...l }));

    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `SR-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });

    for (const i of items) {
      const target = newLines[i.lineIndex];
      target.returnedQty = i.after;
      if (i.condition === "resellable") {
        const { put, next } = restockAllocations(target.allocations ?? [], i.qty);
        target.allocations = next;
        writeStockChange(tx, stocks[restockItems.indexOf(i)], { change: i.qty, reason: "return", note: `${number} · ${sale.number}`, actorUid: actor.uid, settings: priv.data(), ctx: stockCtx, allocations: put, sourceType: "salereturn", sourceId: retRef.id });
      } else {
        target.damagedReturned = (target.damagedReturned ?? 0) + i.qty;
      }
    }
    flushStockContext(tx, stockCtx);

    const restockCost = items.filter((i) => i.condition === "resellable").reduce((n, i) => n + i.cost, 0);
    const writeOffCost = items.filter((i) => i.condition === "damaged").reduce((n, i) => n + i.cost, 0);
    const fully = newLines.every((l) => (l.returnedQty ?? 0) >= l.qty);
    const returnedTotal = returnedBefore + value;
    const refundedTotal = (pay.refundedTotal ?? 0) + refund;
    const netPaidAfter = netPaid - refund;
    const open = ["pending", "partially_paid"].includes(pay.status);

    // The payment record, the register and the refund entry.
    let payStatus = pay.status;
    if (fully && refundedTotal > 0) payStatus = "refunded";
    else if (refund > 0) payStatus = open && netPaidAfter < owedAfter ? "partially_paid" : "partially_refunded";
    else if (open && owedAfter > 0 && netPaidAfter >= owedAfter) payStatus = "collected";
    tx.update(payRef, { status: payStatus, refundedTotal, returnedValue: returnedTotal, ...(open && owedAfter > 0 ? { amount: owedAfter } : {}), updatedAt: FieldValue.serverTimestamp() });
    if (refund > 0) {
      tx.create(payRef.collection("transactions").doc(`salereturn_${retRef.id}`), { type: "refund", amount: refund, method: refundMethod, reference, reason, saleReturnId: retRef.id, recordedOnly: true, actorUid: actor.uid, at: FieldValue.serverTimestamp(), ...(sessionId ? { sessionId } : {}) });
    }
    if (sessionSnap?.exists) tx.update(sessionSnap.ref, { ...(refund > 0 ? { [`totals.${refundMethod}`]: FieldValue.increment(-refund), refundTotal: FieldValue.increment(refund), refundCount: FieldValue.increment(1) } : {}), returnCount: FieldValue.increment(1), returnValue: FieldValue.increment(value) });

    const amountDue = Math.max(0, owedAfter - netPaidAfter);
    syncSale(tx, saleSnap, { lines: newLines, returnedTotal, returnedNet: netBefore + net, refundedTotal, paymentStatus: payStatus, amountDue, ...(fully ? { status: "returned", returnedAt: FieldValue.serverTimestamp() } : {}) }, actor.uid);

    tx.create(retRef, {
      number,
      saleId,
      saleNumber: sale.number,
      customerId: sale.customerId ?? null,
      customer: sale.customer ?? null,
      sessionId,
      warehouseIds: [...new Set(items.flatMap((i) => (i.allocations ?? i.line.allocations ?? []).map((a) => a.warehouseId)))],
      lines: items.map((i) => ({ lineIndex: i.lineIndex, productId: i.line.productId, variantId: i.line.variantId, sku: i.line.sku, productName: i.line.productName, variantLabel: i.line.variantLabel, qty: i.qty, condition: i.condition, unitPrice: i.line.unitPrice, gross: i.gross, discounts: i.discounts, net: i.net, cost: i.cost })),
      units: items.reduce((n, i) => n + i.qty, 0),
      gross,
      discounts,
      net,
      tax,
      value,
      refund,
      refundMethod: refund > 0 ? refundMethod : null,
      receivableCredit,
      restockCost,
      writeOffCost,
      reason,
      exchange,
      fullReturn: fully,
      returnedBy: actor.uid,
      returnedByName: actor.name,
      createdAt: FieldValue.serverTimestamp(),
    });
    const posting = postInTx(tx, acc, saleReturnSpec({ returnId: retRef.id, number, sale, gross, discounts, tax, receivableCredit, refund, refundMethod, restockCost, writeOffCost, reason }), actor.uid);
    finishAccounting(tx, acc);
    writeAudit({ actorUid: actor.uid, action: exchange ? "pos.exchange" : "pos.return", entityType: "sale", entityId: saleId, changes: { number, value, refund, units: items.reduce((n, i) => n + i.qty, 0), reason, posting: posting.status } }, tx);
    const out = { returnId: retRef.id, number, saleNumber: sale.number, value, refund, receivableCredit, fullReturn: fully, posting: posting.status };
    tx.create(idemRef, { result: out, createdAt: FieldValue.serverTimestamp() });
    return { ...out, existing: false };
  });

  // Loyalty points follow the value returned (proportional, once); never fails the return.
  if (!result.existing) await crmInsights.afterRefund(saleId);
  return result;
}

/** Recent returns, or the returns of one sale. @param {{ saleId?: string, limit?: number }} input */
export async function listPosReturns({ saleId, limit = 30 }) {
  const q = saleId ? db.collection("salesReturns").where("saleId", "==", saleId) : db.collection("salesReturns").orderBy("createdAt", "desc");
  const snap = await q.limit(limit).get();
  const rows = snap.docs.map((d) => /** @type {Record<string, any>} */ ({ id: d.id, ...d.data() }));
  return { returns: rows.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)) };
}
