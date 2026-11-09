/**
 * Reviews, content and reports against the emulators (`npm run test:emulator`).
 * Throwaway "demo-" data only. No accounts are created: customers here are just ids on orders.
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
const shipping = await import("../../functions/services/shipping.js");
const reviews = await import("../../functions/services/reviews.js");
const content = await import("../../functions/services/content.js");
const reports = await import("../../functions/services/reports.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;

async function newProduct(stock = 20) {
  seq += 1;
  const p = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Pair ${seq}`, slug: `eg-pair-${seq}`, categoryId: ids.cat, sku: `EG-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId: p, colorIds: [ids.black], sizeIds: [ids.s42], price: 1000000 }), { actorUid: STAFF, canEditCost: false });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId: p, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${p}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId: p, variantId };
}
async function order(p, uid, qty = 1) {
  const data = schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items: [{ ...p, qty }],
    customer: { name: "Ayesha Bibi Khan", phone: "0300 1234567" },
    address: { name: "Ayesha Khan", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: ids.method,
    paymentMethod: "cod",
    termsAccepted: true,
  });
  return (await orders.placeOrder(data, { uid })).orderId;
}
const deliver = async (orderId) => {
  for (const status of ["confirmed", "processing", "dispatched", "delivered"]) await orders.updateOrderStatus({ orderId, status }, { actorUid: STAFF });
};
const rev = (productId, over = {}) => schemas.submitReviewInput.parse({ productId, rating: 5, title: "Lovely", body: "Very comfortable and well made.", ...over });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Italian Shoes", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 3, notifyNewOrders: true, notifyLowStock: true });
  ids.method = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Standard" }), STAFF)).id;
  await shipping.saveRate({ methodId: ids.method, city: "*", charge: 20000, freeOver: null }, STAFF);
});

/* ───────── Reviews ───────── */

test("only a customer whose order was delivered can review, with a shortened public name", async () => {
  const p = await newProduct();
  const o = await order(p, "buyer-1");
  await assert.rejects(reviews.submitReview(rev(p.productId), { uid: "buyer-1" }), (e) => /after your order .* delivered/.test(e.message), "still pending");
  await deliver(o);
  await assert.rejects(reviews.submitReview(rev(p.productId), { uid: "stranger" }), (e) => e.code === "failed-precondition", "someone who never bought it");

  const r = await reviews.submitReview(rev(p.productId), { uid: "buyer-1" });
  assert.equal(r.status, "pending");
  const doc = (await db.doc(`reviews/${r.id}`).get()).data();
  assert.deepEqual([doc.authorName, doc.verifiedPurchase, doc.status], ["Ayesha K.", true, "pending"]);
  assert.equal((await db.doc(`products/${p.productId}`).get()).data().rating, undefined, "pending reviews don't count");
});

test("moderation controls the public rating; editing a review sends it back for approval", async () => {
  const p = await newProduct();
  await deliver(await order(p, "buyer-2"));
  const { id } = await reviews.submitReview(rev(p.productId, { rating: 4 }), { uid: "buyer-2" });
  const out = await reviews.moderateReview({ reviewId: id, status: "approved", reply: "Thank you!" }, STAFF);
  assert.deepEqual([out.avg, out.count], [4, 1]);
  assert.deepEqual((await db.doc(`products/${p.productId}`).get()).data().rating, { avg: 4, count: 1 });

  await reviews.submitReview(rev(p.productId, { rating: 1, body: "Changed my mind about it." }), { uid: "buyer-2" });
  assert.equal((await db.doc(`reviews/${id}`).get()).data().status, "pending");
  assert.deepEqual((await db.doc(`products/${p.productId}`).get()).data().rating, { avg: 0, count: 0 });

  await reviews.moderateReview({ reviewId: id, status: "rejected", reply: "" }, STAFF);
  await assert.rejects(reviews.moderateReview({ reviewId: "nope", status: "approved", reply: "" }, STAFF), (e) => e.code === "not-found");
  await reviews.deleteReview(id, STAFF);
  assert.equal((await db.doc(`reviews/${id}`).get()).exists, false);
  assert.throws(() => schemas.submitReviewInput.parse(rev(p.productId, { rating: 6 })));
  assert.ok((await db.collection("notifications").where("type", "==", "review.new").get()).size >= 2);
});

/* ───────── Content ───────── */

test("content is saved only with safe links; featured products must be published", async () => {
  assert.equal(schemas.saveBannerInput.safeParse({ title: "Sale", linkUrl: "javascript:alert(1)" }).success, false);
  assert.equal(schemas.saveBannerInput.safeParse({ title: "Sale", linkUrl: "//evil.example" }).success, false);
  assert.equal(schemas.saveBannerInput.safeParse({ title: "Sale", linkUrl: "/shop" }).success, true);
  assert.equal(schemas.saveBannerInput.safeParse({ title: "Sale", linkUrl: "https://example.com/x" }).success, true);

  const b = await content.saveBanner(schemas.saveBannerInput.parse({ title: "New arrivals", linkUrl: "/shop" }), STAFF);
  await content.saveBanner(schemas.saveBannerInput.parse({ id: b.id, title: "New arrivals!", isActive: false }), STAFF);
  assert.equal((await db.doc(`banners/${b.id}`).get()).data().isActive, false);
  await assert.rejects(content.saveBanner(schemas.saveBannerInput.parse({ id: "gone", title: "x" }), STAFF), (e) => e.code === "not-found");
  await content.deleteContent("banner", b.id, STAFF);
  await assert.rejects(content.deleteContent("banner", b.id, STAFF), (e) => e.code === "not-found");

  const f = await content.saveFaq(schemas.saveFaqInput.parse({ question: "Do you deliver?", answer: "Yes, see Shipping." }), STAFF);
  assert.ok((await db.doc(`faqs/${f.id}`).get()).exists);

  await content.savePage(schemas.savePageInput.parse({ slug: "about", title: "About us", body: "Written by the owner." }), STAFF);
  assert.equal((await db.doc("pages/about").get()).data().isPublished, false, "pages start as drafts");
  await content.deletePage("about", STAFF);

  const draftProduct = await newProduct();
  await db.doc(`products/${draftProduct.productId}`).update({ status: "draft" });
  await assert.rejects(content.saveHome(schemas.saveHomeInput.parse({ featuredProductIds: [draftProduct.productId] }), STAFF), (e) => /published/.test(e.message));
  const live = await newProduct();
  await content.saveHome(schemas.saveHomeInput.parse({ featuredProductIds: [live.productId] }), STAFF);
  assert.deepEqual((await db.doc("content/home").get()).data().featuredProductIds, [live.productId]);
});

/* ───────── Reports ───────── */

test("sales report counts only real, non-cancelled orders and ranks best sellers; empty range is zeros", async () => {
  const a = await newProduct();
  const b = await newProduct();
  await order(a, "r-1", 3);
  await order(b, "r-2", 1);
  const cancelled = await order(b, "r-3", 2);
  await orders.updateOrderStatus({ orderId: cancelled, status: "cancelled" }, { actorUid: STAFF });

  const range = { from: new Date(Date.now() - 3600000), to: new Date(Date.now() + 3600000) };
  const r = await reports.salesReport(range);
  const mine = r.bestSellers.filter((s) => [a.productId, b.productId].includes(s.productId));
  assert.deepEqual(mine.map((s) => [s.name, s.units]), [["Pair " + (seq - 1), 3], ["Pair " + seq, 1]]);
  assert.equal(r.byStatus.cancelled, 1);
  assert.equal(r.daily.length, 1);
  assert.equal(r.averageOrder, Math.round(r.sales / r.orders));

  const empty = await reports.salesReport({ from: new Date("2001-01-01"), to: new Date("2001-01-31") });
  assert.deepEqual([empty.orders, empty.sales, empty.averageOrder, empty.daily.length, empty.bestSellers.length], [0, 0, 0, 0, 0]);
  assert.equal(schemas.reportRangeInput.safeParse({ from: "2024-01-01", to: "2026-01-01" }).success, false, "more than a year is refused");
});

test("inventory report lists out-of-stock and low-stock using the owner's threshold", async () => {
  const low = await newProduct(2);
  const out = await newProduct(1);
  await inventory.adjustStock({ productId: out.productId, variantId: out.variantId, change: -1, reason: "damaged", note: "Scuffed in storage" }, STAFF);
  const r = await reports.inventoryReport();
  assert.equal(r.threshold, 3);
  assert.ok(r.lowStock.some((x) => x.productId === low.productId));
  assert.ok(r.outOfStock.some((x) => x.productId === out.productId));
});
