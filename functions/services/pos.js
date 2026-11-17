/**
 * Physical-store point of sale. Everything the counter does goes through here, on the server:
 *
 *   registerSessions/{id}   one open register: warehouse, cashier, opening float, running totals (updated in the
 *                           same transaction as every payment and cash movement), and, once closed, the count
 *   registerMovements/{id}  append-only: opening float, cash in/out (with reason and staff), closing count
 *   registerLocks/{uid}     exists while a cashier has a register open (so there can only be one)
 *
 * A POS checkout reuses the existing services instead of duplicating them:
 *   - stock leaves the chosen warehouse through the stock service (inventory.js), once, in the sale's transaction;
 *   - the sale is a normal central sale (sales.js, channel "pos") with its cost snapshot, and its accounting journal
 *     is posted in that same transaction (accounting.js), exactly like an online sale;
 *   - each payment is recorded by salePayments.recordSalePayment (idempotent, journals the receipt, counts the money
 *     in the cashier's register in the same transaction).
 * Prices, discounts, tax, stock and totals are all worked out here; the browser only says which pairs and how many.
 * A retried checkout (same key) returns the first sale and completes any payment that hadn't been recorded yet.
 *
 * Bank and wallet entries are RECORDS of what the cashier saw; nothing verifies a payment. Wallet money lands in the
 * clearing account, not the bank. A register's cash float is a move within Cash in Hand, so it has no journal; cash
 * in/out and the closing difference do, through the existing account roles. If an account problem prevents a journal,
 * the action still happens and the failed posting is kept (accountingExceptions) for a person to fix.
 */
import { FieldPath } from "firebase-admin/firestore";
import { db, FieldValue, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { percentOf } from "../shared/money.js";
import { normalizePkMobile } from "../shared/phone.js";
import { POS_ROLES } from "../shared/permissions.js";
import { expectedCash, cashVariance } from "../shared/pos.js";
import { pktDateKey } from "../shared/accounting.js";
import { effectivePrice, inventoryId } from "./products.js";
import { readStock, readWarehouses, createStockContext, writeStockChange, flushStockContext, warehouseMap, entriesOf } from "./inventory.js";
import { saleForPos, createSale, nextSaleNumber, salesCounter } from "./sales.js";
import { readAccounting, postInTx, finishAccounting } from "./accounting.js";
import { saleSpec, registerMoveSpec, registerVarianceSpec } from "./accountingRules.js";
import { recordSalePayment } from "./salePayments.js";
import { CRM_DEFAULTS, redeemCheck } from "../shared/crm.js";
import { readLots, availablePoints, redeemInTx } from "./loyalty.js";
import { readDiscounts, pickDiscount, recordUse } from "./crmDiscounts.js";
import { afterSale, crmLookup } from "./crmInsights.js";

const sessions = () => db.collection("registerSessions");
const lockRef = (uid) => db.collection("registerLocks").doc(uid);

/** @typedef {{ uid: string, name: string }} Actor */

/* ───────── Registers ───────── */

/** @param {{ idempotencyKey: string, warehouseId: string, openingFloat: number, note?: string }} input @param {Actor} actor */
export async function openRegister({ idempotencyKey, warehouseId, openingFloat, note = "" }, actor) {
  const idemRef = db.collection("idempotency").doc(`reg__${actor.uid}__${idempotencyKey}`);
  const ref = sessions().doc();
  const counterRef = db.collection("counters").doc("registers");
  return db.runTransaction(async (tx) => {
    const [idem, lock, warehouses, counter] = await Promise.all([tx.get(idemRef), tx.get(lockRef(actor.uid)), readWarehouses(tx), tx.get(counterRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (lock.exists) throw new AppError("failed-precondition", "You already have a register open. Close it before opening another.");
    const w = warehouses.get(warehouseId);
    if (!w || w.isActive === false) throw new AppError("invalid-argument", "Choose a warehouse that exists and is switched on.", { fields: { warehouseId: "Not available" } });
    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `RS-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });
    tx.create(ref, {
      number,
      status: "open",
      warehouseId,
      warehouseName: w.name,
      cashierUid: actor.uid,
      cashierName: actor.name,
      openedAt: FieldValue.serverTimestamp(),
      openingFloat,
      openingNote: note,
      totals: { cash: 0, bank_transfer: 0, jazzcash: 0, easypaisa: 0 },
      paymentCount: 0,
      saleCount: 0,
      salesTotal: 0,
      discountTotal: 0,
      cashIn: 0,
      cashOut: 0,
    });
    tx.create(lockRef(actor.uid), { sessionId: ref.id, at: FieldValue.serverTimestamp() });
    tx.create(db.collection("registerMovements").doc(), { sessionId: ref.id, type: "opening", amount: openingFloat, reason: "Opening float", note, staffUid: actor.uid, staffName: actor.name, at: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "register.opened", entityType: "register", entityId: ref.id, changes: { number, warehouseId, openingFloat } }, tx);
    const result = { sessionId: ref.id, number };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/** Cash in or out of a register, with a reason and who did it. @param {Record<string, any>} input validated registerCashInput @param {Actor} actor */
export async function registerCash({ idempotencyKey, sessionId, type, reason, amount, note }, actor) {
  const idemRef = db.collection("idempotency").doc(`regcash__${actor.uid}__${idempotencyKey}`);
  const moveRef = db.collection("registerMovements").doc();
  return db.runTransaction(async (tx) => {
    const [idem, session, acc] = await Promise.all([tx.get(idemRef), tx.get(sessions().doc(sessionId)), readAccounting(tx)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!session.exists || session.data().status !== "open") throw new AppError("failed-precondition", "That register isn't open.");
    const s = session.data();
    const expected = expectedCash(s);
    if (type === "cash_out" && amount > expected) throw new AppError("failed-precondition", `Only Rs. ${(expected / 100).toLocaleString("en-PK")} should be in this register. You can't take out more.`, { fields: { amount: "More than is in the register" } });
    tx.create(moveRef, { sessionId, type, reason, amount, note, staffUid: actor.uid, staffName: actor.name, at: FieldValue.serverTimestamp() });
    tx.update(session.ref, type === "cash_in" ? { cashIn: FieldValue.increment(amount) } : { cashOut: FieldValue.increment(amount) });
    const posting = postInTx(tx, acc, registerMoveSpec({ movementId: moveRef.id, type, reason, amount, session: s.number }), actor.uid);
    finishAccounting(tx, acc);
    writeAudit({ actorUid: actor.uid, action: `register.${type}`, entityType: "register", entityId: sessionId, changes: { amount, reason, note, posting: posting.status } }, tx);
    const result = { movementId: moveRef.id, expectedCash: expected + (type === "cash_in" ? amount : -amount), posting: posting.status };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/**
 * Close a register: record the counted cash, work out expected cash from the recorded transactions, and keep the
 * difference. The difference is posted as its own journal; nothing already posted is ever altered to make cash match.
 * @param {{ sessionId: string, countedCash: number, note?: string }} input @param {Actor} actor @param {{ canCloseOthers: boolean }} opts
 */
export async function closeRegister({ sessionId, countedCash, note = "" }, actor, { canCloseOthers }) {
  return db.runTransaction(async (tx) => {
    const [session, acc] = await Promise.all([tx.get(sessions().doc(sessionId)), readAccounting(tx)]);
    if (!session.exists) throw new AppError("not-found", "That register doesn't exist.");
    const s = session.data();
    if (s.status !== "open") throw new AppError("failed-precondition", "This register is already closed.");
    if (s.cashierUid !== actor.uid && !canCloseOthers) throw new AppError("permission-denied", "Only the cashier or a manager can close this register.");
    const expected = expectedCash(s);
    const variance = cashVariance(countedCash, expected);
    tx.update(session.ref, { status: "closed", closedAt: FieldValue.serverTimestamp(), closedBy: actor.uid, closedByName: actor.name, countedCash, expectedCash: expected, variance, closeNote: note });
    tx.delete(lockRef(s.cashierUid));
    tx.create(db.collection("registerMovements").doc(), { sessionId, type: "closing", amount: countedCash, expected, variance, reason: variance === 0 ? "Counted: exact" : variance < 0 ? "Counted: shortage" : "Counted: excess", note, staffUid: actor.uid, staffName: actor.name, at: FieldValue.serverTimestamp() });
    let posting = { status: "none" };
    if (variance !== 0) {
      posting = postInTx(tx, acc, registerVarianceSpec({ sessionId, session: s.number, variance }), actor.uid);
      finishAccounting(tx, acc);
    }
    writeAudit({ actorUid: actor.uid, action: "register.closed", entityType: "register", entityId: sessionId, changes: { expected, countedCash, variance, posting: posting.status } }, tx);
    return { sessionId, number: s.number, expectedCash: expected, countedCash, variance, outcome: variance === 0 ? "exact" : variance < 0 ? "shortage" : "excess", posting: posting.status };
  });
}

/* ───────── Checkout ───────── */

/**
 * Make a POS sale. See the file header. Throws a plain, specific message for anything the cashier can fix.
 * @param {Record<string, any>} input validated posCheckoutInput @param {Actor} actor @param {{ canOverride: boolean, offline?: { offlineId: string, recordedAt: string, expectedTotal: number, acceptServerPrice?: boolean } | null }} opts
 */
export async function posCheckout(input, actor, { canOverride, offline = null }) {
  const { idempotencyKey, sessionId, items, customerId = null, discount, tenders, note } = input;
  if (!canOverride && (discount || items.some((l) => l.unitPrice !== undefined))) throw new AppError("permission-denied", "You aren't allowed to give discounts or change prices. Ask a manager.");
  const tenderTotal = tenders.reduce((n, t) => n + t.amount, 0);
  const idemRef = db.collection("idempotency").doc(`pos__${actor.uid}__${idempotencyKey}`);
  const saleId = db.collection("sales").doc().id;

  const made = await db.runTransaction(async (tx) => {
    const [idem, session, warehouses, priv, saleCounter, acc, user, crmProfile, crmSettingsSnap, lotList, discList, ...rest] = await Promise.all([
      tx.get(idemRef),
      tx.get(sessions().doc(sessionId)),
      readWarehouses(tx),
      tx.get(db.doc("settings/private")),
      tx.get(salesCounter()),
      readAccounting(tx),
      customerId ? tx.get(db.collection("users").doc(customerId)) : null,
      customerId ? tx.get(db.collection("crmCustomers").doc(customerId)) : null,
      tx.get(db.collection("crmSettings").doc("main")),
      customerId && input.redeemPoints > 0 ? readLots(tx, customerId) : [],
      input.applyCustomerDiscount ? readDiscounts(tx, customerId ?? null) : [],
      ...items.map((i) => readStock(tx, i.productId, i.variantId)),
      ...items.map((i) => tx.get(db.collection("variantCosts").doc(inventoryId(i.productId, i.variantId)))),
    ]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const stocks = rest.slice(0, items.length);
    const costDocs = rest.slice(items.length);

    if (!session.exists || session.data().status !== "open") throw new AppError("failed-precondition", "Open a register before selling.", { conflict: "register" });
    const s = session.data();
    if (s.cashierUid !== actor.uid) throw new AppError("permission-denied", "That register belongs to someone else.");
    const warehouse = warehouses.get(s.warehouseId);
    if (!warehouse || warehouse.isActive === false) throw new AppError("failed-precondition", "This register's warehouse is switched off. Close the register and open one on an active warehouse.");

    // Price every line from the database; the browser's numbers are never used.
    /** @type {any[]} */
    const overrides = [];
    const lines = items.map((it, i) => {
      const stock = stocks[i];
      const product = stock.product.exists ? stock.product.data() : null;
      const variant = stock.variant.exists ? stock.variant.data() : null;
      if (!product || product.status === "archived" || !variant || variant.isActive !== true || !stock.inv.exists) throw new AppError("failed-precondition", `${product?.name ?? "An item"} can't be sold.`, { conflict: "unavailable", fields: { items: "Not for sale" } });
      const label = `${variant.colorName} / ${variant.sizeLabel}`;
      const here = entriesOf(stock.inv)[s.warehouseId] ?? { onHand: 0, reserved: 0 };
      const available = here.onHand - here.reserved;
      if (available < it.qty) throw new AppError("failed-precondition", available > 0 ? `Only ${available} of ${product.name} (${label}) in ${warehouse.name}.` : `${product.name} (${label}) is not in stock in ${warehouse.name}.`, { conflict: "stock", available, fields: { items: `${product.name}: ${available} available` } });
      const listPrice = effectivePrice(variant);
      const unitPrice = it.unitPrice ?? listPrice;
      if (unitPrice > listPrice) throw new AppError("invalid-argument", "A price can be lowered at the counter, never raised.", { fields: { items: "Price too high" } });
      if (it.unitPrice !== undefined && it.unitPrice !== listPrice) {
        if (!it.overrideReason || it.overrideReason.length < 3) throw new AppError("invalid-argument", "Say why the price was changed.", { fields: { items: "Reason needed" } });
        overrides.push({ productId: it.productId, variantId: it.variantId, listPrice, unitPrice, reason: it.overrideReason });
      }
      const image = product.images?.find((im) => im.isPrimary) ?? product.images?.[0];
      return { productId: it.productId, variantId: it.variantId, sku: variant.sku, productName: product.name, variantLabel: label, colorName: variant.colorName, sizeLabel: variant.sizeLabel, qty: it.qty, regularPrice: variant.price, unitPrice, lineTotal: unitPrice * it.qty, imagePath: image?.paths?.[400] ?? null };
    });
    const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
    let discountTotal = 0;
    if (discount) {
      discountTotal = discount.type === "percent" ? percentOf(subtotal, discount.value) : discount.value;
      if (discountTotal > subtotal) throw new AppError("invalid-argument", "The discount is more than the sale.", { fields: { discount: "Too large" } });
    }
    // Customer discount and loyalty points: decided HERE from the saved rules (never from the browser), inside this transaction.
    const crmCfg = crmSettingsSnap.data() ?? {};
    const loyaltyCfg = { ...CRM_DEFAULTS.loyalty, ...(crmCfg.loyalty ?? {}) };
    const cd = crmProfile?.exists ? crmProfile.data() : null;
    /** @type {{ id: string, name: string, amount: number } | null} */
    let crmDiscount = null;
    let crmDiscountRule = null;
    /** @type {{ points: number, value: number } | null} */
    let loyalty = null;
    if (input.applyCustomerDiscount) {
      if (discount) throw new AppError("invalid-argument", "A customer discount can't be combined with a manual discount. Use one or the other.", { fields: { discount: "Not with a customer discount" } });
      const tiers = crmCfg.tiers ?? CRM_DEFAULTS.tiers;
      const tier = cd?.tier ? tiers.find((t) => t.key === cd.tier) : null;
      const candidates = [...discList, ...(tier?.discountPercent > 0 ? [{ id: `tier__${tier.key}`, name: `${tier.name} member discount`, scope: "all", type: "percent", value: tier.discountPercent, isActive: true, used: 0, usedByCustomer: 0 }] : [])];
      const best = pickDiscount(candidates, { customerId: cd ? customerId : null, tier: cd?.tier ?? null, segments: cd?.segments ?? [], lines: lines.map((l, i) => ({ productId: l.productId, categoryId: stocks[i].product.data()?.categoryId ?? null, amount: l.lineTotal })) });
      if (best) {
        crmDiscount = { id: best.discount.id, name: best.discount.name, amount: best.amount };
        crmDiscountRule = best.discount.ref ? best.discount : null;
        discountTotal += best.amount;
      }
    }
    if (input.redeemPoints > 0) {
      if (!cd) throw new AppError("invalid-argument", "Points can only be redeemed by a customer with a profile.", { fields: { redeemPoints: "Choose a customer" } });
      const chk = redeemCheck({ requested: input.redeemPoints, balance: availablePoints(lotList), payable: subtotal - discountTotal }, loyaltyCfg);
      if ("error" in chk) throw new AppError("invalid-argument", chk.error, { fields: { redeemPoints: chk.error } });
      loyalty = { points: chk.points, value: chk.value * 1 };
      discountTotal += chk.value;
    }
    const taxable = subtotal - discountTotal;
    const taxTotal = priv.data()?.taxEnabled ? percentOf(taxable, priv.data().taxRatePercent ?? 0) : 0;
    const total = taxable + taxTotal;
    if (total <= 0) throw new AppError("invalid-argument", "The total must be more than zero.");
    // An offline sale was rung up at the prices the till had cached. The server's prices win: if they differ, the sale
    // is held for a manager unless they accept the server price (which only works when the cash taken covers it).
    let used = tenders;
    let usedTotal = tenderTotal;
    if (offline && total !== offline.expectedTotal) {
      const money = (n) => `Rs. ${(n / 100).toLocaleString("en-PK")}`;
      if (!offline.acceptServerPrice) throw new AppError("failed-precondition", `Prices changed since this sale was made offline: it was rung up at ${money(offline.expectedTotal)} but is now ${money(total)}.`, { conflict: "price_changed", offlineTotal: offline.expectedTotal, serverTotal: total });
      if (tenderTotal < total) throw new AppError("failed-precondition", `The current total (${money(total)}) is more than the cash taken offline (${money(tenderTotal)}), so it can't be accepted automatically.`, { conflict: "price_changed", offlineTotal: offline.expectedTotal, serverTotal: total });
      used = [{ ...tenders[0], amount: total }];
      usedTotal = total;
    }
    if (usedTotal > total) throw new AppError("invalid-argument", `The payments (Rs. ${(tenderTotal / 100).toLocaleString("en-PK")}) are more than the total (Rs. ${(total / 100).toLocaleString("en-PK")}). Enter only what is owed; change is calculated for cash.`, { fields: { tenders: "More than the total" } });
    if (usedTotal < total && !customerId) throw new AppError("invalid-argument", "A part-paid sale needs a registered customer, so the balance can be followed up.", { fields: { customerId: "Choose a customer or take full payment" } });

    let customer = null;
    if (customerId) {
      const who = crmProfile?.exists ? crmProfile : user;
      if (!who?.exists) throw new AppError("invalid-argument", "That customer doesn't exist.", { fields: { customerId: "Not found" } });
      customer = { name: who.data().name || who.data().email || "Customer", phone: who.data().phone ?? "", email: who.data().email ?? null };
    } else if (input.customerName || input.customerPhone) customer = { name: input.customerName || "Walk-in", phone: normalizePkMobile(input.customerPhone ?? "") || input.customerPhone || "", email: null };

    // Stock: out of THIS warehouse only, through the stock service, once.
    const saleNo = nextSaleNumber(saleCounter);
    const stockCtx = createStockContext(warehouses);
    const allocations = stocks.map((stock, i) => writeStockChange(tx, stock, { change: -lines[i].qty, reason: "sale", note: saleNo.number, orderId: null, actorUid: actor.uid, settings: priv.data(), ctx: stockCtx, warehouseId: s.warehouseId, sourceType: "pos_sale", sourceId: saleId }).allocations);
    flushStockContext(tx, stockCtx);

    const primary = [...used].sort((a, b) => b.amount - a.amount)[0]?.method ?? "cash";
    const built = saleForPos({
      number: saleNo.number,
      items: lines,
      discountTotal,
      taxTotal,
      total,
      unitCosts: costDocs.map((d) => (d.exists ? d.data().costPrice ?? null : null)),
      allocations,
      customerId,
      customer,
      sessionId,
      cashier: actor,
      idempotencyKey,
      paymentMethod: primary,
      tenders: used.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference, ...(t.cashReceived !== undefined ? { cashReceived: t.cashReceived } : {}) })),
      note,
      offline: offline ? { offlineId: offline.offlineId, recordedAt: offline.recordedAt } : null,
      loyalty: loyalty ? { redeemedPoints: loyalty.points, redeemedValue: loyalty.value } : null,
      crmDiscount,
    });
    tx.set(salesCounter(), { next: saleNo.nextValue });
    createSale(tx, saleId, built);
    tx.create(db.collection("payments").doc(saleId), { orderId: null, saleId, orderNumber: null, method: primary, amount: total, status: "pending", source: "pos", createdAt: FieldValue.serverTimestamp() });
    tx.update(session.ref, { saleCount: FieldValue.increment(1), salesTotal: FieldValue.increment(total), discountTotal: FieldValue.increment(discountTotal) });
    if (loyalty) redeemInTx(tx, { customerId: /** @type {string} */ (customerId), points: loyalty.points, value: loyalty.value, saleId, number: saleNo.number, lots: lotList, actorUid: actor.uid });
    if (crmDiscount && crmDiscountRule) recordUse(tx, { discount: crmDiscountRule, customerId: customerId ?? null, saleId, amount: crmDiscount.amount });
    if (crmDiscount) writeAudit({ actorUid: actor.uid, action: "pos.customer_discount", entityType: "sale", entityId: saleId, changes: crmDiscount }, tx);
    if (loyalty) writeAudit({ actorUid: actor.uid, action: "pos.points_redeemed", entityType: "sale", entityId: saleId, changes: loyalty }, tx);
    const posting = postInTx(tx, acc, saleSpec(saleId, built.sale, built.saleCost, new Date()), actor.uid);
    finishAccounting(tx, acc);
    for (const o of overrides) writeAudit({ actorUid: actor.uid, action: "pos.price_override", entityType: "sale", entityId: saleId, changes: o }, tx);
    if (discount) writeAudit({ actorUid: actor.uid, action: "pos.discount", entityType: "sale", entityId: saleId, changes: { type: discount.type, value: discount.value, amount: discountTotal, reason: discount.reason } }, tx);
    if (offline) writeAudit({ actorUid: actor.uid, action: "pos.offline_sale", entityType: "sale", entityId: saleId, changes: { offlineId: offline.offlineId, recordedAt: offline.recordedAt, offlineTotal: offline.expectedTotal, serverTotal: total, acceptedServerPrice: Boolean(offline.acceptServerPrice && total !== offline.expectedTotal) } }, tx);
    const result = { saleId, number: saleNo.number, total, subtotal, discountTotal, taxTotal, posting: posting.status, tenders: used, loyaltyRedeemed: loyalty?.points ?? 0, crmDiscount };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });

  // Payments: each is its own idempotent, journalled, register-counted record. A retry completes any that are missing.
  /** @type {{ method: string, amount: number }[]} */
  const taken = [];
  let failed = null;
  const finalTenders = made.tenders ?? tenders;
  for (const [i, t] of finalTenders.entries()) {
    try {
      await recordSalePayment({ idempotencyKey: `${idempotencyKey}-t${i}`, saleId: made.saleId, amount: t.amount, method: t.method, reference: t.reference ?? "", note: "POS" }, actor.uid, { sessionId });
      taken.push({ method: t.method, amount: t.amount });
    } catch (error) {
      failed = { index: i, method: t.method, message: /** @type {Error} */ (error).message };
      break;
    }
  }
  const sale = (await db.collection("sales").doc(made.saleId).get()).data();
  if (customerId) await afterSale(made.saleId); // loyalty points (once the sale is fully paid) and customer statistics; never fails the sale
  return {
    saleId: made.saleId,
    number: made.number,
    existing: made.existing,
    total: sale.total,
    paidTotal: sale.paidTotal,
    amountDue: sale.amountDue,
    paymentStatus: sale.paymentStatus,
    change: finalTenders.filter((t) => t.cashReceived !== undefined).reduce((n, t) => n + (t.cashReceived - t.amount), 0),
    failedPayment: failed,
    posting: made.posting ?? null,
    crmDiscount: sale.crmDiscount ?? null,
    loyaltyRedeemed: sale.loyalty?.redeemedPoints ?? 0,
  };
}

/** Take a payment against a POS sale later (a balance, or a payment that failed at checkout). @param {Record<string, any>} input validated posPaymentInput @param {Actor} actor */
export async function posRecordPayment({ idempotencyKey, saleId, sessionId, tender }, actor) {
  const sale = await db.collection("sales").doc(saleId).get();
  if (!sale.exists || sale.data().channel !== "pos") throw new AppError("not-found", "That isn't a POS sale.");
  const r = await recordSalePayment({ idempotencyKey, saleId, amount: tender.amount, method: tender.method, reference: tender.reference ?? "", note: "POS" }, actor.uid, { sessionId });
  if (sale.data().customerId) await afterSale(saleId); // points once the balance is paid
  return { ...r, change: tender.cashReceived !== undefined ? tender.cashReceived - tender.amount : 0 };
}

/* ───────── Looking things up ───────── */

const words = (text) => [...new Set(String(text).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1))];

/** Variants of the given products with their price and the stock in ONE warehouse. */
async function describeProducts(productIds, warehouseId, onlyVariantId = null) {
  if (!productIds.length) return [];
  const prods = await db.getAll(...productIds.map((id) => db.collection("products").doc(id)));
  const variantSnaps = await Promise.all(prods.filter((p) => p.exists).map((p) => p.ref.collection("variants").limit(60).get()));
  const flat = variantSnaps.flatMap((s, i) => s.docs.filter((v) => !onlyVariantId || v.id === onlyVariantId).map((v) => ({ product: prods.filter((p) => p.exists)[i], v })));
  const inv = flat.length ? await db.getAll(...flat.map((x) => db.collection("inventory").doc(inventoryId(x.product.id, x.v.id)))) : [];
  const stock = new Map(inv.map((d) => [d.id, d]));
  return prods
    .filter((p) => p.exists && p.data().status !== "archived")
    .map((p) => ({
      id: p.id,
      name: p.data().name,
      status: p.data().status,
      variants: flat
        .filter((x) => x.product.id === p.id && x.v.data().isActive)
        .map((x) => {
          const d = stock.get(inventoryId(p.id, x.v.id))?.data();
          const e = d ? d.byWarehouse?.[warehouseId] ?? (!d.byWarehouse && warehouseId === "main" ? { onHand: d.onHand ?? 0, reserved: d.reserved ?? 0 } : { onHand: 0, reserved: 0 }) : { onHand: 0, reserved: 0 };
          return { id: x.v.id, sku: x.v.data().sku, barcode: x.v.data().barcode ?? "", colorName: x.v.data().colorName, sizeLabel: x.v.data().sizeLabel, sizeSort: x.v.data().sizeSort ?? 0, price: effectivePrice(x.v.data()), listPrice: x.v.data().price, available: Math.max(0, e.onHand - e.reserved) };
        })
        .sort((a, b) => String(a.colorName).localeCompare(String(b.colorName)) || a.sizeSort - b.sizeSort),
    }));
}

/**
 * Find products by SKU (exact — what a scanner types) or by name words. Returns at most 12 products.
 * @param {{ q: string, warehouseId: string, exact?: boolean }} input
 */
export async function posSearch({ q, warehouseId, exact = false }) {
  const upper = q.trim().toUpperCase();
  const hit = await db.collection("skus").doc(upper).get().catch(() => null);
  if (hit?.exists) {
    const owner = String(hit.data().owner);
    if (owner.startsWith("variant:")) {
      const [productId, variantId] = owner.slice(8).split("/");
      return { match: "sku", products: await describeProducts([productId], warehouseId, variantId) };
    }
    if (owner.startsWith("product:")) return { match: "sku", products: await describeProducts([owner.slice(8)], warehouseId) };
  }
  // A scanned barcode (assigned in Inventory → Barcodes) finds exactly one variant.
  const bar = await db.collection("barcodes").doc(q.trim()).get().catch(() => null);
  if (bar?.exists) return { match: "sku", products: await describeProducts([bar.data().productId], warehouseId, bar.data().variantId) };
  if (exact) return { match: "none", products: [] };
  const ws = words(q);
  if (!ws.length) return { match: "none", products: [] };
  const snap = await db.collection("products").where("summary.keywords", "array-contains", ws[0]).limit(30).get();
  const ids = snap.docs.filter((d) => d.data().status !== "archived" && ws.every((w) => (d.data().summary?.keywords ?? []).includes(w))).slice(0, 12).map((d) => d.id);
  return { match: "name", products: await describeProducts(ids, warehouseId) };
}

/** Find a registered customer by phone or email, with their last few purchases. @param {{ q: string }} input */
/** Find a customer at the counter: CRM profiles by phone, name, reference or email (account holders get a profile), with their loyalty balance and recent purchases. @param {{ q: string }} input @param {Actor} actor */
export async function posCustomerLookup({ q }, actor) {
  return crmLookup({ q }, actor);
}

/** Everything the counter screen needs to start: active warehouses, my open register, store details for receipts. */
export async function posContext(actor) {
  const [wh, lock, pub, priv] = await Promise.all([db.collection("warehouses").get(), lockRef(actor.uid).get(), db.doc("settings/public").get(), db.doc("settings/private").get()]);
  const warehouses = [...warehouseMap(wh.docs).values()].filter((w) => w.isActive !== false).map((w) => ({ id: w.id, name: w.name, code: w.code }));
  let session = null;
  if (lock.exists) {
    const s = await sessions().doc(lock.data().sessionId).get();
    if (s.exists && s.data().status === "open") session = { id: s.id, ...serialiseSession(s.data()) };
  }
  const p = pub.data() ?? {};
  return {
    warehouses,
    session,
    store: { storeName: p.storeName ?? "", phone: p.phone ?? "", email: p.email ?? "", address: p.address ?? "", openingHours: p.openingHours ?? "", logoUrl: p.logoUrl ?? "" },
    tax: { enabled: Boolean(priv.data()?.taxEnabled), ratePercent: priv.data()?.taxRatePercent ?? 0 },
  };
}

function serialiseSession(s) {
  const { openedAt, closedAt, ...rest } = s;
  return { ...rest, openedAt: openedAt?.toDate?.().toISOString() ?? null, closedAt: closedAt?.toDate?.().toISOString() ?? null, expectedCash: s.status === "open" ? expectedCash(s) : s.expectedCash };
}

/** Data for a receipt (or reprint). Allowed for the cashier who made the sale, or staff who may view register sessions. @param {{ saleId: string }} input @param {Actor} actor @param {{ canViewAll: boolean }} opts */
export async function posReceipt({ saleId }, actor, { canViewAll }) {
  const snap = await db.collection("sales").doc(saleId).get();
  if (!snap.exists || snap.data().channel !== "pos") throw new AppError("not-found", "That sale doesn't exist.");
  const s = snap.data();
  if (s.cashierUid !== actor.uid && !canViewAll) throw new AppError("not-found", "That sale doesn't exist.");
  const txs = await db.collection(`payments/${saleId}/transactions`).orderBy("at").get();
  const { createdAt } = s;
  const rest = { ...s };
  delete rest.createdAt;
  delete rest.updatedAt;
  return {
    sale: { id: snap.id, ...rest, createdAt: createdAt?.toDate?.().toISOString() ?? null },
    payments: txs.docs.map((t) => ({ id: t.id, type: t.data().type, method: t.data().method, amount: t.data().amount, reference: t.data().reference ?? "", at: t.data().at?.toDate?.().toISOString() ?? null })),
  };
}

/* ───────── Roles ───────── */

/** Create the Cashier and POS Manager roles if they don't exist. An explicit owner action; existing roles are left alone. @param {string} actorUid */
export async function createPosRoles(actorUid) {
  return db.runTransaction(async (tx) => {
    const refs = Object.keys(POS_ROLES).map((k) => db.collection("roles").doc(k));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const created = [];
    snaps.forEach((s, i) => {
      if (s.exists) return;
      const key = Object.keys(POS_ROLES)[i];
      tx.create(refs[i], { name: POS_ROLES[key].name, permissions: POS_ROLES[key].permissions, system: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      created.push(key);
    });
    if (created.length) writeAudit({ actorUid, action: "pos.roles_created", entityType: "roles", entityId: created.join(","), changes: { created } }, tx);
    return { created };
  });
}

/* ───────── Reports ───────── */

const MAX_SALES = 5000;

/** @param {{ from: Date, to: Date }} range */
export async function posReport({ from, to }) {
  const start = Timestamp.fromMillis(from.getTime());
  const end = Timestamp.fromMillis(to.getTime());
  const [salesSnap, sessionSnap, wh] = await Promise.all([
    db.collection("sales").where("channel", "==", "pos").where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt").limit(MAX_SALES + 1).get(),
    sessions().where("openedAt", ">=", start).where("openedAt", "<=", end).orderBy("openedAt", "desc").limit(500).get(),
    db.collection("warehouses").get(),
  ]);
  if (salesSnap.size > MAX_SALES) throw new AppError("failed-precondition", `That range has more than ${MAX_SALES} POS sales. Please choose a shorter range.`);
  const names = new Map([...warehouseMap(wh.docs).values()].map((w) => [w.id, w.name]));
  const blank = () => ({ sales: 0, units: 0, grossSales: 0, discounts: 0, netSales: 0, total: 0 });
  const add = (t, s) => {
    t.sales += 1;
    t.units += s.itemCount;
    t.grossSales += s.grossSales;
    t.discounts += s.itemDiscountTotal + s.discountTotal;
    t.netSales += s.netSales;
    t.total += s.total;
  };
  const totals = blank();
  const byDay = {};
  const byCashier = {};
  const byWarehouse = {};
  const byMethod = {};
  let paid = 0;
  let due = 0;
  for (const d of salesSnap.docs) {
    const s = d.data();
    add(totals, s);
    add((byDay[pktDateKey(s.createdAt.toDate())] ??= blank()), s);
    add((byCashier[s.cashierUid] ??= { name: s.cashierName, ...blank() }), s);
    add((byWarehouse[s.warehouseId] ??= { name: names.get(s.warehouseId) ?? s.warehouseId, ...blank() }), s);
    for (const t of s.pos?.tenders ?? []) byMethod[t.method] = (byMethod[t.method] ?? 0) + t.amount;
    paid += Math.max(0, s.paidTotal - s.refundedTotal);
    due += s.amountDue;
  }
  const regs = sessionSnap.docs.map((d) => {
    const s = d.data();
    return { id: d.id, number: s.number, cashierName: s.cashierName, warehouseName: s.warehouseName, status: s.status, openedAt: s.openedAt?.toDate?.().toISOString() ?? null, closedAt: s.closedAt?.toDate?.().toISOString() ?? null, openingFloat: s.openingFloat, saleCount: s.saleCount, salesTotal: s.salesTotal, expectedCash: s.status === "open" ? expectedCash(s) : s.expectedCash, countedCash: s.countedCash ?? null, variance: s.variance ?? null };
  });
  const closed = regs.filter((r) => r.status === "closed");
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totals,
    collected: paid,
    stillDue: due,
    byDay: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, t]) => ({ day, ...t })),
    byCashier: Object.entries(byCashier).map(([uid, t]) => ({ uid, ...t })),
    byWarehouse: Object.entries(byWarehouse).map(([id, t]) => ({ id, ...t })),
    byMethod,
    sessions: regs,
    cash: { shortages: closed.filter((r) => r.variance < 0).reduce((n, r) => n + r.variance, 0), excesses: closed.filter((r) => r.variance > 0).reduce((n, r) => n + r.variance, 0), sessionsWithShortage: closed.filter((r) => r.variance < 0).length, sessionsWithExcess: closed.filter((r) => r.variance > 0).length },
  };
}

/* ───────── Offline sales ───────── */

const syncRef = (uid, id) => db.collection("posOfflineSyncs").doc(`${uid}__${id}`);
const iso = (t) => t?.toDate?.().toISOString() ?? null;

/**
 * Accept a sale that was made offline. It goes through the very same checkout as an online sale (same validation,
 * stock, journals, idempotency): the offline id IS the checkout's idempotency key, so any number of retries, tabs or
 * devices produce exactly one sale. The outcome is kept in posOfflineSyncs so managers can see what needs attention.
 * Prices come from the server; if they differ from what the till showed, or stock is no longer there, nothing is
 * created and the sale is held as a "conflict" for a person to resolve. Nothing is ever forced through.
 * @param {{ sale: Record<string, any>, offlineId: string, recordedAt: string, expectedTotal: number, resolution?: "accept_server_price" }} input
 * @param {Actor} actor @param {{ canOverride: boolean }} opts
 */
export async function syncOfflineSale({ sale, offlineId, recordedAt, expectedTotal, resolution }, actor, { canOverride }) {
  if (sale.idempotencyKey !== offlineId) throw new AppError("invalid-argument", "The sale and its offline id don't match.");
  if (resolution && !canOverride) throw new AppError("permission-denied", "Only a manager can accept a changed price.");
  if (sale.tenders.length === 0 || sale.tenders.some((t) => t.method !== "cash")) throw new AppError("invalid-argument", "Only fully cash-paid sales can be made offline.");
  const recorded = new Date(recordedAt);
  if (recorded.getTime() > Date.now() + 10 * 60 * 1000) throw new AppError("invalid-argument", "This till's clock is ahead of the server's. Fix the date and time on this computer.");
  const ref = syncRef(actor.uid, offlineId);
  const prior = await ref.get();
  if (prior.exists && prior.data().status === "synced") return { ...prior.data().result, status: "synced", existing: true };
  if (prior.exists && prior.data().status === "discarded") throw new AppError("failed-precondition", "This offline sale was discarded by a manager.");
  const base = { offlineId, cashierUid: actor.uid, cashierName: actor.name, sessionId: sale.sessionId, recordedAt: Timestamp.fromDate(recorded), expectedTotal, itemCount: sale.items.reduce((n, l) => n + l.qty, 0), updatedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) };
  try {
    const r = await posCheckout(sale, actor, { canOverride, offline: { offlineId, recordedAt, expectedTotal, acceptServerPrice: resolution === "accept_server_price" } });
    await ref.set({ ...base, status: "synced", saleId: r.saleId, number: r.number, result: r, syncedAt: FieldValue.serverTimestamp(), error: null, conflict: null, details: null }, { merge: true });
    return { ...r, status: "synced" };
  } catch (e) {
    // A refusal the cashier can't fix by resending (stock, prices, register, validation) is kept, not retried blindly.
    if (e instanceof AppError && !["unavailable", "aborted", "internal", "resource-exhausted", "permission-denied", "unauthenticated"].includes(e.code)) {
      const conflict = typeof e.details?.conflict === "string" ? e.details.conflict : null;
      const status = conflict ? "conflict" : "failed";
      await ref.set({ ...base, status, error: e.message, conflict, details: e.details ?? null }, { merge: true });
      return { status, offlineId, message: e.message, conflict, details: e.details ?? null };
    }
    throw e;
  }
}

/** A manager gives up on an offline sale that can't be accepted (it will never be created). Refused if the sale already exists. @param {{ offlineId: string, reason: string }} input @param {Actor} actor */
export async function posSyncDiscard({ offlineId, reason }, actor) {
  const ref = syncRef(actor.uid, offlineId);
  const [prior, idem] = await Promise.all([ref.get(), db.collection("idempotency").doc(`pos__${actor.uid}__${offlineId}`).get()]);
  if (idem.exists || prior.data()?.status === "synced") throw new AppError("failed-precondition", "This sale was already recorded, so it can't be discarded.");
  await ref.set({ offlineId, cashierUid: actor.uid, cashierName: actor.name, status: "discarded", discardReason: reason, discardedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  writeAudit({ actorUid: actor.uid, action: "pos.offline_discard", entityType: "offlineSale", entityId: offlineId, changes: { reason, previousStatus: prior.data()?.status ?? "not_received" } });
  return { offlineId, status: "discarded" };
}

/** Recent offline-sale outcomes (newest first) for managers. @param {{ status?: string, limit?: number }} input */
export async function posSyncList({ status, limit = 50 }) {
  let q = db.collection("posOfflineSyncs").orderBy("updatedAt", "desc");
  if (status) q = db.collection("posOfflineSyncs").where("status", "==", status).orderBy("updatedAt", "desc");
  const snap = await q.limit(limit).get();
  return { entries: snap.docs.map((d) => { const x = d.data(); return { id: d.id, offlineId: x.offlineId, status: x.status, cashierName: x.cashierName, number: x.number ?? null, saleId: x.saleId ?? null, expectedTotal: x.expectedTotal ?? null, itemCount: x.itemCount ?? null, attempts: x.attempts ?? 0, error: x.error ?? null, conflict: x.conflict ?? null, discardReason: x.discardReason ?? null, recordedAt: iso(x.recordedAt), syncedAt: iso(x.syncedAt), updatedAt: iso(x.updatedAt) }; }) };
}

/**
 * A page of the catalogue for the offline cache: products with variants, prices and the stock of ONE warehouse. The
 * cache is a convenience for ringing sales up; the server re-checks every price and quantity when the sale arrives.
 * @param {{ warehouseId: string, after?: string | null }} input
 */
export async function posCatalog({ warehouseId, after = null }) {
  const PAGE = 40;
  let q = db.collection("products").orderBy(FieldPath.documentId());
  if (after) q = q.startAfter(after);
  const snap = await q.limit(PAGE + 1).get();
  const docs = snap.docs.slice(0, PAGE);
  const products = await describeProducts(docs.map((d) => d.id), warehouseId);
  return { warehouseId, products, next: snap.docs.length > PAGE ? docs[docs.length - 1].id : null, fetchedAt: new Date().toISOString() };
}
