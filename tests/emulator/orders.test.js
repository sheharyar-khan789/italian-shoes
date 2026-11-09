/**
 * Orders against the emulators (`npm run test:emulator`). All data is created inside a throwaway
 * "demo-" database for these tests; no real store data or accounts are involved.
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
const schemas = await import("../../functions/shared/schemas/index.js");
const year = new Date().getUTCFullYear();

const STAFF = "staff-1";
const ids = {};

async function makeProduct(name, slug, sku, { price = 1000000, sale = null, stock = 5, status = "published" } = {}) {
  const p = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId: p, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: sale }), { actorUid: STAFF, canEditCost: false });
  const variantId = products.variantKey(ids.black, ids.s42);
  if (stock) await inventory.adjustStock({ productId: p, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  // Skip the photo pipeline here (covered in catalog.test.js): give it a photo record and publish.
  await db.doc(`products/${p}`).update({ status, images: [{ id: "i1", isPrimary: true, alt: "", paths: { 400: `products/${p}/images/i1-400.webp` } }] });
  return { productId: p, variantId };
}

const onHand = async (p) => (await db.doc(`inventory/${p.productId}__${p.variantId}`).get()).data().onHand;

const draft = (items, over = {}) =>
  schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items,
    customer: { name: "Test Customer", phone: "0300 1234567" },
    address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: "std",
    paymentMethod: "cod",
    termsAccepted: true,
    ...over,
  });
const line = (p, qty = 1) => ({ productId: p.productId, variantId: p.variantId, qty });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Italian Shoes", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true, taxEnabled: false });
});

test("no delivery configured → ordering is blocked with a clear message (no invented fee)", async () => {
  const a = await makeProduct("Alpha", "alpha", "A-1");
  await assert.rejects(orders.quote({ items: [line(a)], city: "Lahore" }), (e) => e.code === "failed-precondition" && /Delivery hasn't been set up/.test(e.message));
  await db.doc("shippingMethods/std").set({ name: "Standard", description: "", estimateText: "", isActive: true });
  await assert.rejects(orders.quote({ items: [line(a)], city: "Lahore" }), (e) => /Delivery hasn't been set up/.test(e.message), "a method without a rate is still not usable");
  await db.collection("shippingRates").add({ methodId: "std", city: "Lahore", charge: 20000, freeOver: null });
  await db.collection("shippingRates").add({ methodId: "std", city: "*", charge: 30000, freeOver: 5000000 });
});

test("quote and order use database prices: sale price, shipping by city, exact totals", async () => {
  const p = await makeProduct("Sale Shoe", "sale-shoe", "S-1", { price: 1000000, sale: 900000, stock: 10 });
  const q = await orders.quote({ items: [line(p, 2)], city: "lahore" });
  assert.equal(q.subtotal, 1800000);
  assert.equal(q.shippingTotal, 20000, "exact-city rate wins, case-insensitive");
  assert.equal(q.grandTotal, 1820000);
  assert.equal((await orders.quote({ items: [line(p, 2)], city: "Karachi" })).shippingTotal, 30000, "* rate for other cities");
  assert.equal((await orders.quote({ items: [line(p, 6)], city: "Karachi" })).shippingTotal, 0, "free over the threshold (Rs 54,000 ≥ Rs 50,000)");

  const r = await orders.placeOrder(draft([line(p, 2)]), { uid: "cust-1", email: "c1@example.com" });
  assert.equal(r.number, `IS-${year}-000001`);
  const o = (await db.doc(`orders/${r.orderId}`).get()).data();
  assert.deepEqual([o.status, o.paymentStatus, o.paymentMethod, o.userId], ["pending", "pending", "cod", "cust-1"]);
  assert.deepEqual([o.subtotal, o.shippingTotal, o.grandTotal, o.itemCount], [1800000, 20000, 1820000, 2]);
  assert.equal(o.items[0].unitPrice, 900000);
  assert.equal(o.items[0].regularPrice, 1000000);
  assert.equal(o.customer.phone, "+92 300 1234567");

  assert.equal(await onHand(p), 8, "stock taken");
  const mv = (await db.collection("stockMovements").where("orderId", "==", r.orderId).get()).docs[0].data();
  assert.deepEqual([mv.change, mv.reason], [-2, "sale"]);

  const pay = (await db.doc(`payments/${r.orderId}`).get()).data();
  assert.deepEqual([pay.status, pay.method, pay.amount], ["pending", "cod", 1820000], "COD is never marked paid");
  assert.equal((await db.collection(`orders/${r.orderId}/history`).get()).size, 1);
  assert.equal((await db.collection("notifications").where("type", "==", "order.new").get()).size >= 1, true);
  ids.sale = p;
  ids.order1 = r.orderId;
});

test("the same checkout submitted twice returns the same order and takes stock once", async () => {
  const p = await makeProduct("Idem", "idem", "I-1", { stock: 5 });
  const d = draft([line(p)]);
  const a = await orders.placeOrder(d, { uid: "cust-2" });
  const b = await orders.placeOrder(d, { uid: "cust-2" });
  assert.equal(a.orderId, b.orderId);
  assert.equal(b.existing, true);
  assert.equal(await onHand(p), 4);
  const c = await orders.placeOrder(d, { uid: "cust-3" });
  assert.notEqual(c.orderId, a.orderId, "another customer reusing a key gets their own order");
});

test("past orders keep their snapshot when the product is edited later", async () => {
  await db.doc(`products/${ids.sale.productId}`).update({ name: "Renamed Later" });
  await db.doc(`products/${ids.sale.productId}/variants/${ids.sale.variantId}`).update({ price: 5, salePrice: null });
  const o = (await db.doc(`orders/${ids.order1}`).get()).data();
  assert.equal(o.items[0].productName, "Sale Shoe");
  assert.equal(o.items[0].unitPrice, 900000);
  assert.equal(o.grandTotal, 1820000);
});

test("all-or-nothing: if one line can't be fulfilled, nothing is ordered and no stock moves", async () => {
  const ok = await makeProduct("Ok", "ok", "OK-1", { stock: 5 });
  const low = await makeProduct("Low", "low", "LOW-1", { stock: 1 });
  const before = await db.collection("orders").get();
  await assert.rejects(orders.placeOrder(draft([line(ok, 2), line(low, 2)]), { uid: "cust-4" }), (e) => e.code === "failed-precondition" && /Only 1 left of Low/.test(e.message));
  assert.equal(await onHand(ok), 5);
  assert.equal(await onHand(low), 1);
  assert.equal((await db.collection("orders").get()).size, before.size);
  const none = await makeProduct("Gone", "gone", "G-1", { stock: 0 });
  await assert.rejects(orders.placeOrder(draft([line(none)]), { uid: "cust-4" }), (e) => /sold out/.test(e.message));
});

test("unpublished, archived and deactivated items can't be ordered", async () => {
  const d = await makeProduct("Draft One", "draft-one", "D-1", { status: "draft" });
  await assert.rejects(orders.placeOrder(draft([line(d)]), { uid: "cust-5" }), (e) => /isn't available any more/.test(e.message));
  const a = await makeProduct("Arch", "arch", "AR-1", { status: "archived" });
  await assert.rejects(orders.placeOrder(draft([line(a)]), { uid: "cust-5" }), (e) => /isn't available/.test(e.message));
  const v = await makeProduct("Inactive", "inactive", "IN-1");
  await db.doc(`products/${v.productId}/variants/${v.variantId}`).update({ isActive: false });
  await assert.rejects(orders.placeOrder(draft([line(v)]), { uid: "cust-5" }), (e) => /isn't available/.test(e.message));
  await assert.rejects(orders.placeOrder(draft([{ productId: "nope", variantId: "x_y", qty: 1 }]), { uid: "cust-5" }), (e) => /isn't available/.test(e.message));
});

test("the last pair can only be sold once, even with parallel checkouts", async () => {
  const p = await makeProduct("Last Pair", "last-pair", "LP-1", { stock: 1 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => orders.placeOrder(draft([line(p)]), { uid: `racer-${i}` })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one buyer");
  assert.equal(await onHand(p), 0, "never negative");
  assert.equal((await db.collection("orders").get()).docs.filter((d) => d.data().items[0].productId === p.productId).length, 1);
});

test("order numbers are sequential and settings gate ordering", async () => {
  const nums = (await db.collection("orders").orderBy("createdAt").get()).docs.map((d) => d.data().number);
  assert.deepEqual(nums, nums.map((_, i) => `IS-${year}-${String(i + 1).padStart(6, "0")}`));

  const p = await makeProduct("Gate", "gate", "GT-1");
  await db.doc("settings/public").update({ isOpen: false });
  await assert.rejects(orders.placeOrder(draft([line(p)]), { uid: "cust-6" }), (e) => /isn't taking orders/.test(e.message));
  await db.doc("settings/public").update({ isOpen: true });
  await db.doc("settings/private").update({ orderPrefix: "" });
  await assert.rejects(orders.placeOrder(draft([line(p)]), { uid: "cust-6" }), (e) => /isn't set up/.test(e.message));
  await db.doc("settings/private").update({ orderPrefix: "IS" });
  await assert.rejects(orders.placeOrder(draft([line(p)], { couponCode: "EID10" }), { uid: "cust-6" }), (e) => /coupon code isn't valid/.test(e.message));
});

test("status changes follow the allowed paths; cancelling or returning puts stock back with a record", async () => {
  const p = await makeProduct("Flow", "flow", "FL-1", { stock: 5 });
  const { orderId } = await orders.placeOrder(draft([line(p, 2)]), { uid: "cust-7" });
  const set = (status, note = "") => orders.updateOrderStatus({ orderId, status, note }, { actorUid: STAFF });

  await assert.rejects(set("delivered"), (e) => /can't be changed to delivered/.test(e.message));
  await set("confirmed", "Called customer");
  await set("processing");
  await assert.rejects(set("pending"), (e) => e.code === "failed-precondition");
  assert.equal(await onHand(p), 3);

  await set("cancelled", "Customer asked");
  assert.equal(await onHand(p), 5, "stock restored");
  const mv = (await db.collection("stockMovements").where("orderId", "==", orderId).get()).docs.map((d) => d.data().reason).sort();
  assert.deepEqual(mv, ["cancellation", "sale"]);
  await assert.rejects(set("cancelled"), (e) => e.code === "failed-precondition", "can't cancel twice (no double restock)");
  assert.equal(await onHand(p), 5);

  const hist = (await db.collection(`orders/${orderId}/history`).orderBy("at").get()).docs.map((d) => d.data().to);
  assert.deepEqual(hist, ["pending", "confirmed", "processing", "cancelled"]);

  // Delivered then returned also restocks.
  const r2 = await orders.placeOrder(draft([line(p)]), { uid: "cust-7" });
  for (const s of ["confirmed", "processing", "dispatched", "delivered", "returned"]) await orders.updateOrderStatus({ orderId: r2.orderId, status: s }, { actorUid: STAFF });
  assert.equal(await onHand(p), 5);
  assert.ok((await db.collection("stockMovements").where("orderId", "==", r2.orderId).get()).docs.some((d) => d.data().reason === "return"));
});

test("customers can cancel only their own pending order", async () => {
  const p = await makeProduct("Mine", "mine", "MI-1", { stock: 3 });
  const { orderId } = await orders.placeOrder(draft([line(p)]), { uid: "owner-cust" });
  const cancel = (uid) => orders.updateOrderStatus({ orderId, status: "cancelled", note: "Changed my mind" }, { actorUid: uid, ownerUid: uid });
  await assert.rejects(cancel("someone-else"), (e) => e.code === "not-found", "other customers can't even tell it exists");
  await orders.updateOrderStatus({ orderId, status: "confirmed" }, { actorUid: STAFF });
  await assert.rejects(cancel("owner-cust"), (e) => /can't be cancelled any more/.test(e.message));

  const r = await orders.placeOrder(draft([line(p)]), { uid: "owner-cust" });
  await orders.updateOrderStatus({ orderId: r.orderId, status: "cancelled" }, { actorUid: "owner-cust", ownerUid: "owner-cust" });
  assert.equal((await db.doc(`orders/${r.orderId}`).get()).data().status, "cancelled");
  await assert.rejects(orders.updateOrderStatus({ orderId: r.orderId, status: "confirmed" }, { actorUid: "owner-cust", ownerUid: "owner-cust" }), (e) => e.code === "failed-precondition", "customers can't move orders forward");
});

test("internal notes, shipments and CSV export (with formula-injection protection)", async () => {
  const p = await makeProduct("Export", "export", "EX-1", { stock: 3 });
  const evil = '=HYPERLINK("http://evil.example","click")';
  const { orderId } = await orders.placeOrder(draft([line(p)], { customer: { name: evil, phone: "0300 1234567" } }), { uid: "cust-8" });

  await orders.addOrderNote({ orderId, text: "Customer prefers evening delivery" }, STAFF);
  assert.equal((await db.collection(`orders/${orderId}/internalNotes`).get()).size, 1);
  await orders.addShipment({ orderId, courier: "TCS", trackingNumber: "TRK123456", trackingUrl: "" }, STAFF);
  assert.equal((await db.collection(`orders/${orderId}/shipments`).get()).docs[0].data().trackingNumber, "TRK123456");
  await orders.updateOrderStatus({ orderId, status: "cancelled" }, { actorUid: STAFF });
  await assert.rejects(orders.addShipment({ orderId, courier: "TCS", trackingNumber: "X1234", trackingUrl: "" }, STAFF), (e) => /closed/.test(e.message));

  const { csv, count } = await orders.exportOrders({}, STAFF);
  assert.ok(count >= 8);
  assert.ok(csv.startsWith("﻿Order,Date,Status"));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), "formula neutralised and quoted");
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), "no cell starts with =");
  const only = await orders.exportOrders({ status: "cancelled" }, STAFF);
  assert.ok(only.count >= 3);
  const statusColumn = only.csv.split(String.fromCharCode(13, 10)).slice(1).filter(Boolean).map((row) => row.split(",")[2]);
  assert.ok(statusColumn.length === only.count && statusColumn.every((st) => st === "cancelled"), "the filter returns only cancelled orders");
  assert.ok((await db.collection("auditLogs").where("action", "==", "orders.exported").get()).size >= 2, "exports are logged");
});
