/**
 * Orders. The ONLY code that creates orders or changes their status.
 *
 * placeOrder() is the heart of the shop. In ONE Firestore transaction it:
 *   re-reads every product, price and stock level from the database (nothing price-related is
 *   trusted from the browser), refuses the whole order if any line can't be fulfilled, calculates
 *   totals, writes the order with permanent snapshots of names/variants/prices, takes the stock,
 *   records the payment as pending (Cash on Delivery is never marked paid), and tells staff.
 * Firestore retries the transaction if another customer changed the same stock at the same moment,
 * so the last pair can only be sold once.
 */
import { db, FieldValue, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { toCsv } from "../lib/csv.js";
import { lineTotal, sumPaisa, percentOf } from "../shared/money.js";
import { canTransition, customerCanCancel, RESTOCK_ON_ENTER } from "../shared/orderStatus.js";
import { effectivePrice, recomputeSummary } from "./products.js";
import { readStock, writeStockChange, availableOf } from "./inventory.js";
import { applyCoupon, releaseCoupon } from "./coupons.js";
import { computeShipping, listAvailableMethods } from "./shipping.js";

const orders = () => db.collection("orders");

/* ───────── Pricing (used by both the quote and the real order) ───────── */

/**
 * Price the lines from the database snapshots read inside the caller's transaction.
 * @param {Awaited<ReturnType<typeof readStock>>[]} stocks
 * @param {{ productId: string, variantId: string, qty: number }[]} items
 */
function priceLines(stocks, items) {
  return stocks.map((stock, i) => {
    const { qty } = items[i];
    const product = stock.product.exists ? stock.product.data() : null;
    const variant = stock.variant.exists ? stock.variant.data() : null;
    if (!product || product.status !== "published" || !variant || variant.isActive !== true) {
      throw new AppError("failed-precondition", `${product?.name ?? "An item"} isn't available any more. Please remove it from your bag.`, { productId: items[i].productId, variantId: items[i].variantId });
    }
    const label = `${variant.colorName} / ${variant.sizeLabel}`;
    const available = availableOf(stock);
    if (available < qty) {
      throw new AppError(
        "failed-precondition",
        available > 0 ? `Only ${available} left of ${product.name} (${label}).` : `${product.name} (${label}) is sold out.`,
        { productId: items[i].productId, variantId: items[i].variantId, available },
      );
    }
    const unitPrice = effectivePrice(variant);
    const image = product.images?.find((im) => im.isPrimary) ?? product.images?.[0];
    return {
      productId: items[i].productId,
      variantId: items[i].variantId,
      categoryId: product.categoryId ?? null,
      productName: product.name,
      variantLabel: label,
      sku: variant.sku,
      unitPrice,
      regularPrice: variant.price,
      qty,
      lineTotal: lineTotal(unitPrice, qty),
      imagePath: image?.paths?.[400] ?? null,
    };
  });
}

function totals(lines, shippingCharge, privateSettings, discount = 0) {
  const subtotal = sumPaisa(0, ...lines.map((l) => l.lineTotal));
  const taxable = Math.max(0, subtotal - discount);
  const tax = privateSettings?.taxEnabled ? percentOf(taxable, privateSettings.taxRatePercent ?? 0) : 0;
  return { subtotal, discountTotal: discount, taxTotal: tax, shippingTotal: shippingCharge, grandTotal: sumPaisa(taxable, tax, shippingCharge) };
}

function assertStoreOpen(pub, priv) {
  if (pub?.isOpen === false) throw new AppError("failed-precondition", "The store isn't taking orders right now. Please try again later.");
  if (!priv?.orderPrefix) throw new AppError("failed-precondition", "Ordering isn't set up yet. Please contact the store.");
}

/* ───────── Quote (preview totals before ordering) ───────── */

/** @param {{ items: any[], city: string, shippingMethodId?: string, couponCode?: string }} input */
export async function quote(input, uid = null) {
  const methods = await listAvailableMethods();
  if (!methods.length) throw new AppError("failed-precondition", "Delivery hasn't been set up yet, so orders can't be placed. Please contact the store.");

  const [stocks, settings] = await Promise.all([
    Promise.all(input.items.map((i) => readStockOutsideTx(i.productId, i.variantId))),
    Promise.all([db.doc("settings/public").get(), db.doc("settings/private").get()]),
  ]);
  assertStoreOpen(settings[0].data(), settings[1].data());
  const lines = priceLines(stocks, input.items);
  const subtotal = sumPaisa(0, ...lines.map((l) => l.lineTotal));
  const options = [];
  for (const m of methods) {
    try {
      const s = await computeShipping(m.id, input.city, subtotal);
      options.push({ id: m.id, name: s.name, estimateText: s.estimateText, charge: s.charge });
    } catch {
      /* not available for this city */
    }
  }
  if (!options.length) throw new AppError("failed-precondition", `We can't deliver to ${input.city} yet.`, { fields: { city: "Not available for delivery" } });
  const chosen = options.find((o) => o.id === input.shippingMethodId) ?? options[0];
  let discount = 0;
  if (input.couponCode) {
    if (!uid) throw new AppError("unauthenticated", "Please sign in to use a coupon.");
    discount = (await applyCoupon(null, input.couponCode.trim().toUpperCase(), uid, lines)).discount;
  }
  return { lines, shippingOptions: options, selectedShippingMethodId: chosen.id, couponCode: discount ? input.couponCode.trim().toUpperCase() : null, ...totals(lines, chosen.charge, settings[1].data(), discount) };
}

/** Read-only snapshot version of readStock for quotes (no transaction). */
async function readStockOutsideTx(productId, variantId) {
  return db.runTransaction((tx) => readStock(tx, productId, variantId));
}

/* ───────── Place order ───────── */

/** A suspended customer's already-issued sign-in token must not keep working for up to an hour. */
export async function assertNotSuspended(uid) {
  const profile = await db.doc(`users/${uid}`).get();
  if (profile.exists && profile.data().disabled === true) throw new AppError("permission-denied", "This account has been suspended. Please contact the store.");
}

/**
 * @param {Record<string, any>} data validated placeOrderSchema
 * @param {{ uid: string, email?: string }} who
 */
export async function placeOrder(data, { uid, email }) {
  await assertNotSuspended(uid);
  const idemRef = db.collection("idempotency").doc(`${uid}__${data.idempotencyKey}`);
  const counterRef = db.collection("counters").doc("orders");
  const orderRef = orders().doc();

  const created = await db.runTransaction(async (tx) => {
    const [idem, counter, pub, priv, cod, ...stocks] = await Promise.all([
      tx.get(idemRef),
      tx.get(counterRef),
      tx.get(db.doc("settings/public")),
      tx.get(db.doc("settings/private")),
      tx.get(db.doc("paymentMethods/cod")),
      ...data.items.map((i) => readStock(tx, i.productId, i.variantId)),
    ]);
    if (idem.exists) return { ...idem.data(), existing: true };
    assertStoreOpen(pub.data(), priv.data());
    if (cod.exists && cod.data().isEnabled === false) throw new AppError("failed-precondition", "Cash on Delivery isn't available right now.");

    const lines = priceLines(stocks, data.items);
    const subtotal = sumPaisa(0, ...lines.map((l) => l.lineTotal));
    const shipping = await computeShipping(data.shippingMethodId, data.address.city, subtotal);
    // Coupon is read before the first write below (Firestore transactions: reads first).
    const coupon = data.couponCode ? await applyCoupon(tx, data.couponCode, uid, lines) : null;
    const t = totals(lines, shipping.charge, priv.data(), coupon?.discount ?? 0);

    const seq = (counter.exists ? counter.data().next : 1) ?? 1;
    const number = `${priv.data().orderPrefix}-${new Date().getUTCFullYear()}-${String(seq).padStart(6, "0")}`;
    tx.set(counterRef, { next: seq + 1 });

    tx.create(orderRef, {
      number,
      userId: uid,
      status: "pending",
      paymentStatus: "pending",
      paymentMethod: data.paymentMethod,
      customer: { name: data.customer.name, phone: data.customer.phone, email: data.customer.email ?? email ?? null },
      address: data.address,
      deliveryInstructions: data.deliveryInstructions ?? "",
      notes: data.notes ?? "",
      items: lines,
      itemCount: lines.reduce((n, l) => n + l.qty, 0),
      ...t,
      shippingMethod: { id: shipping.methodId, name: shipping.name, estimateText: shipping.estimateText },
      couponCode: coupon ? data.couponCode : null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    coupon?.commit(tx);
    tx.create(orderRef.collection("history").doc(), { from: null, to: "pending", note: "Order placed", actorUid: uid, at: FieldValue.serverTimestamp() });
    tx.create(db.collection("payments").doc(orderRef.id), { orderId: orderRef.id, orderNumber: number, method: data.paymentMethod, amount: t.grandTotal, status: "pending", createdAt: FieldValue.serverTimestamp() });
    tx.create(idemRef, { orderId: orderRef.id, number, createdAt: FieldValue.serverTimestamp() });

    stocks.forEach((stock, i) => writeStockChange(tx, stock, { change: -lines[i].qty, reason: "sale", note: number, orderId: orderRef.id, actorUid: uid, settings: priv.data() }));

    if (priv.data().notifyNewOrders !== false) {
      notify({ type: "order.new", audience: "orders.read", title: `New order ${number}`, body: `${data.customer.name} · ${lines.reduce((n, l) => n + l.qty, 0)} item(s)`, link: `/admin/orders/${orderRef.id}`, data: { orderId: orderRef.id } }, tx);
    }
    return { orderId: orderRef.id, number, existing: false };
  });

  if (!created.existing) await Promise.all([...new Set(data.items.map((i) => i.productId))].map((id) => recomputeSummary(id)));
  return { orderId: created.orderId, number: created.number, existing: created.existing };
}

/* ───────── Status changes ───────── */

/**
 * @param {{ orderId: string, status: string, note?: string }} input
 * @param {{ actorUid: string, ownerUid?: string | null }} ctx  ownerUid: when set, the order must belong to that customer and be cancellable by them
 */
export async function updateOrderStatus({ orderId, status: to, note = "" }, { actorUid, ownerUid = null }) {
  const ref = orders().doc(orderId);
  const touched = new Set();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // Same message for "doesn't exist" and "isn't yours", so order ids can't be probed.
    if (!snap.exists || (ownerUid && snap.data().userId !== ownerUid)) throw new AppError("not-found", "Order not found.");
    const order = snap.data();
    if (ownerUid && !(to === "cancelled" && customerCanCancel(order.status))) throw new AppError("failed-precondition", "This order can't be cancelled any more. Please contact the store.");
    if (!canTransition(order.status, to)) throw new AppError("failed-precondition", `An order that is ${order.status} can't be changed to ${to}.`);

    const restock = /** @type {string[]} */ (RESTOCK_ON_ENTER).includes(to);
    const payRef = db.collection("payments").doc(ref.id);
    const giveBackCoupon = to === "cancelled" && Boolean(order.couponCode);
    const [priv, pay, couponSnap, ...stocks] = await Promise.all([tx.get(db.doc("settings/private")), tx.get(payRef), giveBackCoupon ? tx.get(db.collection("coupons").doc(order.couponCode)) : null, ...(restock ? order.items.map((l) => readStock(tx, l.productId, l.variantId)) : [])]);
    // Nothing was collected, so nothing is owed any more: close the payment instead of leaving "cash due" hanging.
    const voidPayment = restock && pay.exists && pay.data().status === "pending";

    if (restock) {
      stocks.forEach((stock, i) => {
        writeStockChange(tx, stock, { change: order.items[i].qty, reason: to === "cancelled" ? "cancellation" : "return", note: order.number, orderId: ref.id, actorUid, settings: priv.data() });
        touched.add(order.items[i].productId);
      });
    }
    if (couponSnap?.exists) releaseCoupon(tx, order.couponCode, order.userId);
    tx.update(ref, { status: to, updatedAt: FieldValue.serverTimestamp(), ...(voidPayment ? { paymentStatus: "void" } : {}) });
    if (voidPayment) tx.update(payRef, { status: "void", updatedAt: FieldValue.serverTimestamp() });
    tx.create(ref.collection("history").doc(), { from: order.status, to, note, actorUid, at: FieldValue.serverTimestamp() });
    notify({ type: to === "cancelled" ? "order.cancelled" : "order.status", audience: "orders.read", title: `Order ${order.number} is now ${to}`, link: `/admin/orders/${ref.id}`, data: { orderId: ref.id, from: order.status, to } }, tx);
    writeAudit({ actorUid, action: ownerUid ? "order.cancelled_by_customer" : "order.status", entityType: "order", entityId: ref.id, changes: { from: order.status, to, note } }, tx);
  });

  await Promise.all([...touched].map((id) => recomputeSummary(id)));
  return { orderId, status: to };
}

/* ───────── Notes, shipments, export ───────── */

export async function addOrderNote({ orderId, text }, actorUid) {
  const ref = orders().doc(orderId);
  if (!(await ref.get()).exists) throw new AppError("not-found", "Order not found.");
  await ref.collection("internalNotes").add({ text, authorUid: actorUid, createdAt: FieldValue.serverTimestamp() });
  return { ok: true };
}

export async function addShipment({ orderId, courier, trackingNumber, trackingUrl }, actorUid) {
  const ref = orders().doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "Order not found.");
  if (["cancelled", "refunded", "returned"].includes(snap.data().status)) throw new AppError("failed-precondition", "This order is closed, so tracking can't be added.");
  await ref.collection("shipments").add({ courier, trackingNumber, trackingUrl, dispatchedAt: FieldValue.serverTimestamp(), addedBy: actorUid });
  await ref.update({ updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid, action: "order.shipment_added", entityType: "order", entityId: orderId, changes: { courier, trackingNumber } });
  return { ok: true };
}

const rupees = (paisa) => (paisa / 100).toFixed(2);

/** CSV of orders, newest first, capped at 5,000 rows. */
export async function exportOrders({ from, to, status }, actorUid) {
  let q = orders().orderBy("createdAt", "desc");
  if (status) q = q.where("status", "==", status);
  if (from) q = q.where("createdAt", ">=", Timestamp.fromDate(from));
  if (to) q = q.where("createdAt", "<=", Timestamp.fromDate(new Date(to.getTime() + 864e5 - 1)));
  const snap = await q.limit(5000).get();
  const rows = [["Order", "Date", "Status", "Payment", "Customer", "Phone", "City", "Area", "Address", "Items", "Subtotal (PKR)", "Delivery (PKR)", "Total (PKR)"]];
  for (const d of snap.docs) {
    const o = d.data();
    rows.push([
      o.number,
      o.createdAt?.toDate().toISOString() ?? "",
      o.status,
      o.paymentStatus,
      o.customer?.name,
      o.customer?.phone,
      o.address?.city,
      o.address?.area,
      o.address?.line1,
      o.items.map((l) => `${l.productName} (${l.variantLabel}) x${l.qty}`).join("; "),
      rupees(o.subtotal),
      rupees(o.shippingTotal),
      rupees(o.grandTotal),
    ]);
  }
  await writeAudit({ actorUid, action: "orders.exported", entityType: "order", entityId: "export", changes: { count: snap.size, status: status ?? null } });
  return { csv: toCsv(rows), count: snap.size };
}
