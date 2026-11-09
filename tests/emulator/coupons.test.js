/**
 * Coupons against the emulators (`npm run test:emulator`). Throwaway "demo-" data only.
 * Prices here are test numbers inside the emulator, not store data.
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
const coupons = await import("../../functions/services/coupons.js");
const shipping = await import("../../functions/services/shipping.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;

async function newProduct(stock = 20, categoryId = ids.cat) {
  seq += 1;
  const p = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Item ${seq}`, slug: `cp-item-${seq}`, categoryId, sku: `CP-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId: p, colorIds: [ids.black], sizeIds: [ids.s42], price: 1000000 }), { actorUid: STAFF, canEditCost: false });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId: p, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${p}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId: p, variantId };
}
const draft = (p, over = {}) =>
  schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items: [{ productId: p.productId, variantId: p.variantId, qty: 1 }],
    customer: { name: "Test Customer", phone: "0300 1234567" },
    address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: ids.method,
    paymentMethod: "cod",
    termsAccepted: true,
    ...over,
  });
const make = (over) => coupons.saveCoupon(schemas.saveCouponInput.parse({ type: "percent", value: 10, ...over }), STAFF);
const coupon = async (code) => (await db.doc(`coupons/${code}`).get()).data();

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.cat2 = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Casual", slug: "casual" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Italian Shoes", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true });
  ids.method = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Standard" }), STAFF)).id;
  await shipping.saveRate({ methodId: ids.method, city: "*", charge: 20000, freeOver: null }, STAFF);
});

test("a percent coupon discounts the order, shows in the quote, and is counted once", async () => {
  await make({ code: "save10" });
  const p = await newProduct();
  const q = await orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "save10" }, "cust-1");
  assert.deepEqual([q.subtotal, q.discountTotal, q.shippingTotal, q.grandTotal, q.couponCode], [1000000, 100000, 20000, 920000, "SAVE10"]);
  assert.equal((await coupon("SAVE10")).usedCount, 0, "a quote never uses the coupon up");

  const { orderId } = await orders.placeOrder(draft(p, { couponCode: "save10" }), { uid: "cust-1" });
  const o = (await db.doc(`orders/${orderId}`).get()).data();
  assert.deepEqual([o.discountTotal, o.grandTotal, o.couponCode], [100000, 920000, "SAVE10"]);
  assert.equal((await db.doc(`payments/${orderId}`).get()).data().amount, 920000, "COD amount follows the discount");
  assert.equal((await coupon("SAVE10")).usedCount, 1);
});

test("a coupon can't be used while signed out, and unknown codes give the same answer as unusable ones", async () => {
  const p = await newProduct();
  await assert.rejects(orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "SAVE10" }, null), (e) => e.code === "unauthenticated");
  await make({ code: "OFFLINE", isActive: false });
  const unknown = await orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "NOPE123" }, "c").catch((e) => e);
  assert.equal(unknown.code, "failed-precondition");
  await assert.rejects(orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "OFFLINE" }, "c"), (e) => /isn't active/.test(e.message));
});

test("usage limits hold under simultaneous orders: a 3-use coupon is redeemed exactly 3 times", async () => {
  await make({ code: "FIRST3", usageLimit: 3 });
  const p = await newProduct(50);
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => orders.placeOrder(draft(p, { couponCode: "FIRST3" }), { uid: `racer-${i}` })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal((await coupon("FIRST3")).usedCount, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => /fully used/.test(r.reason.message)));
});

test("one use per customer; cancelling before dispatch gives the use back", async () => {
  await make({ code: "ONCE", perCustomerLimit: 1 });
  const p = await newProduct();
  const first = await orders.placeOrder(draft(p, { couponCode: "ONCE" }), { uid: "cust-once" });
  await assert.rejects(orders.placeOrder(draft(p, { couponCode: "ONCE" }), { uid: "cust-once" }), (e) => /already used/.test(e.message));
  assert.equal((await orders.placeOrder(draft(p, { couponCode: "ONCE" }), { uid: "someone-else" })).orderId.length > 0, true);

  await orders.updateOrderStatus({ orderId: first.orderId, status: "cancelled" }, { actorUid: STAFF });
  const again = await orders.placeOrder(draft(p, { couponCode: "ONCE" }), { uid: "cust-once" });
  assert.ok(again.orderId);
  assert.equal((await coupon("ONCE")).usedCount, 2, "2 live uses: someone-else + cust-once's second order");
});

test("category-restricted coupons apply only to matching items; minimum order is enforced", async () => {
  await make({ code: "FORMAL20", value: 20, categoryIds: [ids.cat] });
  await make({ code: "BIGSPEND", minOrder: 5000000 });
  const formal = await newProduct(5, ids.cat);
  const casual = await newProduct(5, ids.cat2);
  await assert.rejects(orders.quote({ items: [{ ...casual, qty: 1 }], city: "Lahore", couponCode: "FORMAL20" }, "c"), (e) => /doesn't apply/.test(e.message));
  const mixed = await orders.quote({ items: [{ ...formal, qty: 1 }, { ...casual, qty: 1 }], city: "Lahore", couponCode: "FORMAL20" }, "c");
  assert.equal(mixed.discountTotal, 200000, "20% of the formal pair only");
  await assert.rejects(orders.quote({ items: [{ ...formal, qty: 1 }], city: "Lahore", couponCode: "BIGSPEND" }, "c"), (e) => /minimum/.test(e.message));
});

test("dates and the usage-limit floor are enforced; deleting keeps past orders intact", async () => {
  await make({ code: "FUTURE", startsAt: new Date(Date.now() + 86400000) });
  await make({ code: "OLD", startsAt: new Date(Date.now() - 2 * 86400000), endsAt: new Date(Date.now() - 86400000) });
  const p = await newProduct();
  await assert.rejects(orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "FUTURE" }, "c"), (e) => /isn't valid yet/.test(e.message));
  await assert.rejects(orders.quote({ items: [{ ...p, qty: 1 }], city: "Lahore", couponCode: "OLD" }, "c"), (e) => /expired/.test(e.message));

  await assert.rejects(make({ code: "FIRST3", usageLimit: 2 }), (e) => e.code === "invalid-argument");
  const before = (await db.collection("orders").where("couponCode", "==", "SAVE10").get()).docs[0].data();
  await coupons.deleteCoupon("SAVE10", STAFF);
  assert.equal((await db.doc("coupons/SAVE10").get()).exists, false);
  assert.equal((await db.collection("orders").where("couponCode", "==", "SAVE10").get()).docs[0].data().discountTotal, before.discountTotal);
  await assert.rejects(coupons.deleteCoupon("SAVE10", STAFF), (e) => e.code === "not-found");
  assert.ok((await db.collection("auditLogs").where("action", "==", "coupon.created").get()).size >= 4);
});

test("a suspended customer can't place orders even with a still-valid sign-in", async () => {
  const p = await newProduct();
  await db.doc("users/suspended-1").set({ name: "Suspended Person", disabled: true });
  await assert.rejects(orders.placeOrder(draft(p), { uid: "suspended-1" }), (e) => e.code === "permission-denied" && /suspended/.test(e.message));
  await db.doc("users/suspended-1").update({ disabled: false });
  assert.ok((await orders.placeOrder(draft(p), { uid: "suspended-1" })).orderId);
});
