/**
 * Payments and delivery against the emulators (`npm run test:emulator`). Throwaway "demo-" data only.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db } = await import("../../functions/lib/admin.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const orders = await import("../../functions/services/orders.js");
const payments = await import("../../functions/services/payments.js");
const shipping = await import("../../functions/services/shipping.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;

async function newProduct(stock = 20) {
  seq += 1;
  const p = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Item ${seq}`, slug: `item-${seq}`, categoryId: ids.cat, sku: `PAY-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId: p, colorIds: [ids.black], sizeIds: [ids.s42], price: 1000000 }), { actorUid: STAFF, canEditCost: false });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId: p, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${p}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId: p, variantId };
}

/** An order for one pair: Rs 10,000 + Rs 200 delivery (Lahore) = Rs 10,200 = 1,020,000 paisa. */
async function newOrder(over = {}) {
  const p = await newProduct();
  const data = schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items: [{ productId: p.productId, variantId: p.variantId, qty: 1 }],
    customer: { name: "Test Customer", phone: "0300 1234567" },
    address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: ids.method,
    paymentMethod: "cod",
    termsAccepted: true,
    ...over,
  });
  return (await orders.placeOrder(data, { uid: "cust-p" })).orderId;
}
const advance = async (orderId, ...path) => {
  for (const status of path) await orders.updateOrderStatus({ orderId, status }, { actorUid: STAFF });
};
const pay = async (orderId) => (await db.doc(`payments/${orderId}`).get()).data();
const order = async (orderId) => (await db.doc(`orders/${orderId}`).get()).data();
const txs = async (orderId) => (await db.collection(`payments/${orderId}/transactions`).orderBy("at").get()).docs.map((d) => d.data());

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Italian Shoes", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true });
});

/* ───────── Delivery ───────── */

test("delivery setup: one rate per city, free-over threshold, '*' for other cities, deleting a method removes its rates", async () => {
  ids.method = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Standard", estimateText: "" }), STAFF)).id;
  await assert.rejects(orders.quote({ items: [{ productId: "x", variantId: "y", qty: 1 }], city: "Lahore" }), (e) => /Delivery hasn't been set up/.test(e.message), "a method with no rate is not usable");

  const lahore = await shipping.saveRate({ methodId: ids.method, city: "Lahore", charge: 20000, freeOver: null }, STAFF);
  assert.equal(lahore.updated, false);
  const again = await shipping.saveRate({ methodId: ids.method, city: " lahore ", charge: 25000, freeOver: null }, STAFF);
  assert.equal(again.updated, true, "same city, different spelling → same rate");
  assert.equal(again.id, lahore.id);
  await shipping.saveRate({ methodId: ids.method, city: "Lahore", charge: 20000, freeOver: null }, STAFF);
  await shipping.saveRate({ methodId: ids.method, city: "*", charge: 30000, freeOver: 5000000 }, STAFF);
  assert.equal((await db.collection("shippingRates").where("methodId", "==", ids.method).get()).size, 2);

  await assert.rejects(shipping.saveRate({ methodId: ids.method, city: "Karachi", charge: 100, freeOver: 0 }, STAFF), (e) => e.code === "invalid-argument");
  await assert.rejects(shipping.saveRate({ methodId: "nope", city: "Karachi", charge: 100, freeOver: null }, STAFF), (e) => e.code === "not-found");

  const throwaway = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Express" }), STAFF)).id;
  await shipping.saveRate({ methodId: throwaway, city: "*", charge: 90000, freeOver: null }, STAFF);
  await shipping.deleteShipping("method", throwaway, STAFF);
  assert.equal((await db.collection("shippingRates").where("methodId", "==", throwaway).get()).size, 0);
  assert.equal((await db.doc(`shippingMethods/${throwaway}`).get()).exists, false);
  await assert.rejects(shipping.deleteShipping("method", throwaway, STAFF), (e) => e.code === "not-found");
  assert.ok((await db.collection("auditLogs").where("action", "==", "shipping_method.deleted").get()).size >= 1);
});

/* ───────── Cash on Delivery ───────── */

test("cash can only be recorded after dispatch, once, for the full amount", async () => {
  const o = await newOrder();
  assert.deepEqual([(await pay(o)).status, (await pay(o)).amount], ["pending", 1020000]);
  const collect = () => payments.recordCollection({ orderId: o, note: "Courier TCS" }, STAFF);

  await assert.rejects(collect(), (e) => e.code === "failed-precondition" && /dispatched or delivered/.test(e.message));
  await advance(o, "confirmed", "processing", "dispatched");
  await collect();
  assert.equal((await pay(o)).status, "collected");
  assert.equal((await order(o)).paymentStatus, "collected");
  const t = await txs(o);
  assert.deepEqual([t.length, t[0].type, t[0].amount, t[0].actorUid, t[0].note], [1, "collection", 1020000, STAFF, "Courier TCS"]);
  await assert.rejects(collect(), (e) => /already recorded/.test(e.message), "no double collection");
  assert.equal((await txs(o)).length, 1);
  assert.ok((await db.collection("notifications").where("type", "==", "payment.status").get()).size >= 1);
});

test("two staff recording the same cash at once: exactly one succeeds", async () => {
  const o = await newOrder();
  await advance(o, "confirmed", "processing", "dispatched", "delivered");
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => payments.recordCollection({ orderId: o }, STAFF)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await txs(o)).length, 1);
});

/* ───────── Refunds ───────── */

test("refunds: nothing to refund before collection; never more than collected; partial then full", async () => {
  const o = await newOrder();
  await advance(o, "confirmed", "processing", "dispatched", "delivered");
  const refund = (amount, reason = "Wrong size returned") => payments.recordRefund({ orderId: o, amount, reason }, STAFF);

  await assert.rejects(refund(100), (e) => /Nothing has been collected/.test(e.message));
  await payments.recordCollection({ orderId: o }, STAFF);
  await assert.rejects(refund(1020001), (e) => e.code === "invalid-argument" && Boolean(e.details.fields.amount));

  const part = await refund(300000);
  assert.deepEqual([part.status, part.refundedTotal, part.remaining], ["partially_refunded", 300000, 720000]);
  assert.equal((await order(o)).paymentStatus, "partially_refunded");
  await assert.rejects(refund(720001), (e) => e.code === "invalid-argument", "can't exceed what's left");

  const rest = await refund(720000, "Rest refunded");
  assert.deepEqual([rest.status, rest.remaining], ["refunded", 0]);
  assert.equal((await pay(o)).status, "refunded");
  await assert.rejects(refund(1), (e) => /already fully refunded/.test(e.message));
  assert.deepEqual((await txs(o)).map((t) => `${t.type}:${t.amount}`), ["collection:1020000", "refund:300000", "refund:720000"]);
  assert.equal((await order(o)).status, "delivered", "a delivered order isn't rewritten by a refund alone");
  assert.ok((await db.collection("notifications").where("type", "==", "refund").get()).size >= 2);
});

test("returning a collected order and refunding it in full closes the order", async () => {
  const o = await newOrder();
  await advance(o, "confirmed", "processing", "dispatched", "delivered");
  await payments.recordCollection({ orderId: o }, STAFF);
  await advance(o, "returned");
  assert.equal((await pay(o)).status, "collected", "money was collected, so it is not voided");
  await payments.recordRefund({ orderId: o, amount: 1020000, reason: "Customer returned the pair" }, STAFF);
  assert.equal((await order(o)).status, "refunded");
  const hist = (await db.collection(`orders/${o}/history`).orderBy("at").get()).docs.map((d) => d.data().to);
  assert.equal(hist.at(-1), "refunded");
});

/* ───────── Nothing collected → nothing owed ───────── */

test("cancelling or returning an unpaid COD order voids its payment", async () => {
  const o = await newOrder();
  await advance(o, "cancelled");
  assert.equal((await pay(o)).status, "void");
  assert.equal((await order(o)).paymentStatus, "void");
  await assert.rejects(payments.recordCollection({ orderId: o }, STAFF), (e) => e.code === "failed-precondition");
  await assert.rejects(payments.recordRefund({ orderId: o, amount: 100, reason: "test" }, STAFF), (e) => /Nothing has been collected/.test(e.message));

  const refused = await newOrder();
  await advance(refused, "confirmed", "processing", "dispatched", "returned");
  assert.equal((await pay(refused)).status, "void", "parcel came back undelivered, no cash taken");
});

/* ───────── Cash on Delivery switch ───────── */

test("the COD switch blocks and re-allows ordering, and is logged", async () => {
  await payments.setPaymentMethod({ key: "cod", isEnabled: false }, STAFF);
  await assert.rejects(newOrder(), (e) => e.code === "failed-precondition" && /Cash on Delivery isn't available/.test(e.message));
  await payments.setPaymentMethod({ key: "cod", isEnabled: true }, STAFF);
  assert.ok(await newOrder());
  const logs = await db.collection("auditLogs").where("action", "==", "payment_method.updated").get();
  assert.deepEqual(logs.docs.map((d) => d.data().changes.isEnabled).sort(), [false, true]);
});

test("rates drive real quotes, and removing the last rate stops ordering again", async () => {
  const p = await newProduct();
  const item = { productId: p.productId, variantId: p.variantId, qty: 1 };
  assert.equal((await orders.quote({ items: [item], city: "Lahore" })).shippingTotal, 20000);
  assert.equal((await orders.quote({ items: [item], city: "Multan" })).shippingTotal, 30000);
  for (const r of (await db.collection("shippingRates").get()).docs) await shipping.deleteShipping("rate", r.id, STAFF);
  await assert.rejects(orders.quote({ items: [item], city: "Lahore" }), (e) => /Delivery hasn't been set up/.test(e.message));
});
