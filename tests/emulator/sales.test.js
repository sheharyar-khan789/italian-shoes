/**
 * The unified sales model against the emulators (`npm run test:emulator`). All data is created inside a
 * throwaway "demo-" database for these tests; no real store data or accounts are involved.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth, FieldValue } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const orders = await import("../../functions/services/orders.js");
const payments = await import("../../functions/services/payments.js");
const salePayments = await import("../../functions/services/salePayments.js");
const reports = await import("../../functions/services/salesReports.js");
const coupons = await import("../../functions/services/coupons.js");
const shipping = await import("../../functions/services/shipping.js");
const { runSalesBackfill } = await import("../../functions/migrations/003-sales-backfill.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;
const key = () => randomUUID().replace(/-/g, "");

const TOKENS = {
  viewer: { uid: "sv-1", staff: true, perms: ["sales.read"], auth_time: 9999999999 },
  finance: { uid: "sf-1", staff: true, perms: ["sales.read", "costs.read"], auth_time: 9999999999 },
  payer: { uid: "sp-1", staff: true, perms: ["payments.update"], auth_time: 9999999999 },
  customer: { uid: "c-9" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

const get = async (path) => (await db.doc(path).get()).data();
const sale = (orderId) => get(`sales/${orderId}`);
const saleCost = (orderId) => get(`saleCosts/${orderId}`);
const order = (orderId) => get(`orders/${orderId}`);
const pay = (orderId) => get(`payments/${orderId}`);
const txns = async (orderId) => (await db.collection(`payments/${orderId}/transactions`).orderBy("at").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const stockOf = async (p) => (await get(`inventory/${p.productId}__${p.variantId}`)).onHand;

async function newProduct({ stock = 20, price = 1000000, sale: salePrice = null, cost = null } = {}) {
  seq += 1;
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Sale Item ${seq}`, slug: `sale-item-${seq}`, categoryId: ids.cat, sku: `SL-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice, ...(cost ? { costPrice: cost } : {}) }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  if (stock) await inventory.adjustStock({ productId, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId, variantId };
}
const draft = (p, qty = 1, over = {}) =>
  schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items: [{ productId: p.productId, variantId: p.variantId, qty }],
    customer: { name: "Test Customer", phone: "0300 1234567" },
    address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: ids.method,
    paymentMethod: "cod",
    termsAccepted: true,
    ...over,
  });
const place = async (p, qty = 1, over = {}, uid = "cust-s") => (await orders.placeOrder(draft(p, qty, over), { uid })).orderId;
const advance = async (orderId, ...path) => {
  for (const status of path) await orders.updateOrderStatus({ orderId, status }, { actorUid: STAFF });
};
/** The order and its sale must always tell the same story. */
async function agree(orderId, label = "") {
  const [o, s, p] = await Promise.all([order(orderId), sale(orderId), pay(orderId)]);
  assert.equal(s.status, o.status, `${label} status`);
  assert.equal(s.paymentStatus, o.paymentStatus, `${label} payment status`);
  assert.equal(s.paymentStatus, p.status, `${label} payment record status`);
  assert.equal(s.total, o.grandTotal, `${label} total`);
  assert.equal((await saleCost(orderId)).status, o.status, `${label} cost record status`);
}

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const uid of ["sv-1", "sf-1", "sp-1"]) await auth.createUser({ uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true });
  ids.method = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Standard" }), STAFF)).id;
  await shipping.saveRate({ methodId: ids.method, city: "*", charge: 20000, freeOver: null }, STAFF);
});

/* ───────── One order, one sale ───────── */

test("an online order creates exactly one linked sale with the same totals", async () => {
  const p = await newProduct({ cost: 600000 });
  const result = await orders.placeOrder(draft(p, 2), { uid: "cust-s" });
  assert.deepEqual(Object.keys(result).sort(), ["existing", "number", "orderId"], "the order API answer is unchanged");
  const o = await order(result.orderId);
  const s = await sale(result.orderId);
  assert.match(s.number, /^SL-\d{6}$/);
  assert.equal(o.saleId, result.orderId);
  assert.equal(o.saleNumber, s.number);
  assert.deepEqual([s.channel, s.orderId, s.orderNumber, s.customerId, s.status, s.paymentMethod, s.paymentStatus, s.stockApplied], ["online", result.orderId, o.number, "cust-s", "pending", "cod", "pending", true]);
  assert.deepEqual([s.subtotal, s.discountTotal, s.shippingTotal, s.taxTotal, s.total], [o.subtotal, o.discountTotal, o.shippingTotal, o.taxTotal, o.grandTotal]);
  assert.equal(s.total, 2020000, "2 × Rs 10,000 + Rs 200 delivery");
  assert.equal(s.customer.phone, "+92 300 1234567", "the phone as the order saved it");
  assert.equal(s.address.city, "Lahore");
  assert.equal(s.warehouseId, "main");
  assert.equal(s.paidTotal, 0);
  assert.equal(s.amountDue, s.total);
  assert.equal((await db.collection("sales").where("orderId", "==", result.orderId).get()).size, 1);
  assert.ok(s.createdAt && s.updatedAt && s.createdBy === "cust-s");
  assert.ok(s.idempotencyKey);
  await agree(result.orderId);
});

test("a retried or simultaneous order makes one order, one sale, and takes the stock once", async () => {
  const p = await newProduct({ stock: 10 });
  const input = draft(p, 3);
  const results = await Promise.all(Array.from({ length: 5 }, () => orders.placeOrder(input, { uid: "cust-r" })));
  assert.equal(new Set(results.map((r) => r.orderId)).size, 1, "everyone gets the same order");
  assert.equal(results.filter((r) => !r.existing).length, 1);
  const id = results[0].orderId;
  assert.equal((await db.collection("orders").where("saleId", "==", id).get()).size, 1);
  assert.equal((await db.collection("sales").where("orderId", "==", id).get()).size, 1);
  assert.equal(await stockOf(p), 7, "3 pairs taken once, not five times");
  assert.equal((await db.collection("stockMovements").where("orderId", "==", id).get()).size, 1);
  const before = await db.collection("sales").get();
  await orders.placeOrder(input, { uid: "cust-r" }); // a later retry
  assert.equal((await db.collection("sales").get()).size, before.size, "no extra sale");
  const numbers = (await db.collection("sales").get()).docs.map((d) => d.data().number);
  assert.equal(new Set(numbers).size, numbers.length, "sale numbers are unique");
});

test("sale price, coupon and delivery: every amount is right, and the lines add up", async () => {
  const p = await newProduct({ price: 1000000, sale: 900000, cost: 600000 });
  await coupons.saveCoupon(schemas.saveCouponInput.parse({ code: "SALE10", type: "percent", value: 10 }), STAFF);
  const id = await place(p, 2, { couponCode: "SALE10" });
  const o = await order(id);
  const s = await sale(id);
  assert.deepEqual([s.grossSales, s.itemDiscountTotal, s.subtotal, s.discountTotal, s.netSales, s.shippingTotal, s.total], [2000000, 200000, 1800000, 180000, 1620000, 20000, 1640000]);
  assert.equal(s.total, o.grandTotal);
  assert.equal(s.couponCode, "SALE10");
  const l = s.lines[0];
  assert.deepEqual([l.regularPrice, l.unitPrice, l.qty, l.itemDiscount, l.lineTotal, l.couponShare, l.lineNet], [1000000, 900000, 2, 200000, 1800000, 180000, 1620000]);
  assert.equal(s.lines.reduce((n, x) => n + x.lineTotal, 0), s.subtotal);
  assert.equal(s.lines.reduce((n, x) => n + x.couponShare, 0), s.discountTotal);
  assert.deepEqual([l.productName, l.sku, l.colorName, l.sizeLabel], [`Sale Item ${seq}`, `SL-${seq}-BLACK-42`, "Black", "EU 42"]);
  assert.deepEqual(l.allocations, [{ warehouseId: "main", qty: 2 }]);
  const c = await saleCost(id);
  assert.deepEqual([c.costComplete, c.costTotal, c.grossProfit], [true, 1200000, 420000], "net sales Rs 16,200 − cost Rs 12,000 = Rs 4,200 gross profit");
  assert.deepEqual([c.costLines[0].unitCost, c.costLines[0].lineCost, c.costLines[0].lineProfit], [600000, 1200000, 420000]);
});

test("the sale keeps its own names, prices and cost after the catalogue and costs change", async () => {
  const p = await newProduct({ price: 1000000, cost: 600000 });
  const id = await place(p, 1);
  const frozen = JSON.stringify([await sale(id), await saleCost(id)].map((x) => ({ ...x, createdAt: 0, updatedAt: 0 })));
  await db.doc(`variantCosts/${p.productId}__${p.variantId}`).update({ costPrice: 999999 });
  await db.doc(`products/${p.productId}`).update({ name: "Renamed product" });
  await db.doc(`products/${p.productId}/variants/${p.variantId}`).update({ price: 5, sku: "CHANGED" });
  assert.equal(JSON.stringify([await sale(id), await saleCost(id)].map((x) => ({ ...x, createdAt: 0, updatedAt: 0 }))), frozen, "nothing on the sale moved");
  const later = await place(p, 1);
  assert.equal((await saleCost(later)).costLines[0].unitCost, 999999, "a new sale takes the new cost");
  assert.equal((await saleCost(id)).costLines[0].unitCost, 600000);
  const noCost = await newProduct();
  const c = await saleCost(await place(noCost, 1));
  assert.deepEqual([c.costComplete, c.costTotal, c.grossProfit, c.costLines[0].unitCost], [false, null, null, null], "no cost on file → no invented cost or profit");
});

/* ───────── Stock and status stay consistent ───────── */

test("stock is deducted once; cancelling puts it back once and the sale follows the order", async () => {
  const p = await newProduct({ stock: 10 });
  const id = await place(p, 4);
  assert.equal(await stockOf(p), 6);
  const sold = (await db.collection("stockMovements").where("orderId", "==", id).get()).docs.map((d) => d.data());
  assert.deepEqual([sold.length, sold[0].reason, sold[0].change, sold[0].sourceType], [1, "sale", -4, "order"]);
  await agree(id, "placed");
  const linesBefore = JSON.stringify((await sale(id)).lines);

  await orders.updateOrderStatus({ orderId: id, status: "cancelled", note: "test" }, { actorUid: STAFF });
  assert.equal(await stockOf(p), 10, "restocked once");
  await assert.rejects(orders.updateOrderStatus({ orderId: id, status: "cancelled" }, { actorUid: STAFF }), (e) => /can't be changed/.test(e.message));
  assert.equal(await stockOf(p), 10, "a second attempt restocks nothing");
  const s = await sale(id);
  assert.deepEqual([s.status, s.paymentStatus, s.amountDue, s.paidTotal], ["cancelled", "void", 0, 0]);
  assert.ok(s.cancelledAt);
  assert.equal(JSON.stringify(s.lines), linesBefore, "the sale lines are history and stay");
  await agree(id, "cancelled");
  const moves = (await db.collection("stockMovements").where("orderId", "==", id).get()).docs.map((d) => d.data().reason).sort();
  assert.deepEqual(moves, ["cancellation", "sale"]);
});

test("a customer cancelling their own order updates the sale too", async () => {
  const p = await newProduct({ stock: 3 });
  const id = await place(p, 1, {}, "cust-own");
  await orders.updateOrderStatus({ orderId: id, status: "cancelled", note: "Cancelled by customer" }, { actorUid: "cust-own", ownerUid: "cust-own" });
  await agree(id);
  assert.equal((await sale(id)).status, "cancelled");
  assert.equal(await stockOf(p), 3);
});

test("through delivery, cash collection and refunds the sale and the payment record agree at every step", async () => {
  const p = await newProduct({ stock: 5 });
  const id = await place(p, 1);
  for (const status of ["confirmed", "processing", "dispatched", "delivered"]) {
    await advance(id, status);
    await agree(id, status);
  }
  assert.ok((await sale(id)).deliveredAt);
  await payments.recordCollection({ orderId: id }, STAFF);
  await agree(id, "collected");
  let s = await sale(id);
  assert.deepEqual([s.paymentStatus, s.paidTotal, s.amountDue], ["collected", s.total, 0]);
  await payments.recordRefund({ orderId: id, amount: 300000, reason: "Wrong size" }, STAFF);
  await agree(id, "part refund");
  s = await sale(id);
  assert.deepEqual([s.paymentStatus, s.refundedTotal], ["partially_refunded", 300000]);
  await advance(id, "returned");
  await agree(id, "returned");
  await payments.recordRefund({ orderId: id, amount: s.total - 300000, reason: "Rest" }, STAFF);
  await agree(id, "refunded");
  s = await sale(id);
  assert.deepEqual([s.status, s.paymentStatus, s.refundedTotal], ["refunded", "refunded", s.total]);
  assert.equal(await stockOf(p), 5, "the returned pair is back on the shelf once");
});

/* ───────── Payments: several payments, partial payments, corrections ───────── */

test("part-payments add up; more than is due, duplicates and COD before dispatch are refused", async () => {
  const p = await newProduct();
  const id = await place(p, 1); // Rs 10,200
  const total = (await sale(id)).total;
  const part = (amount, over = {}) => salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount, method: "bank_transfer", reference: "TXN-1", ...over }), STAFF);

  await assert.rejects(part(1000, { method: "cod", reference: "" }), (e) => /dispatched or delivered/.test(e.message), "COD cash is recorded once the parcel is out");
  const first = await part(300000);
  assert.deepEqual([first.status, first.paidTotal, first.amountDue], ["partially_paid", 300000, total - 300000]);
  await agree(id, "after part payment");
  assert.equal((await sale(id)).paidTotal, 300000);
  await assert.rejects(part(total), (e) => e.code === "invalid-argument" && /still due/.test(e.message), "more than is due");

  const input = schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount: 200000, method: "easypaisa", reference: "EP-99" });
  const results = await Promise.all(Array.from({ length: 4 }, () => salePayments.recordSalePayment(input, STAFF)));
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal(results.filter((r) => !r.existing).length, 1);
  assert.equal((await sale(id)).paidTotal, 500000, "the same payment sent four times is recorded once");

  const last = await part(total - 500000, { method: "cash", reference: "" });
  assert.deepEqual([last.status, last.amountDue], ["collected", 0]);
  await agree(id, "fully paid");
  await assert.rejects(part(1), (e) => /already fully paid/.test(e.message));
  const t = await txns(id);
  assert.deepEqual(t.map((x) => [x.type, x.method, x.amount]), [["collection", "bank_transfer", 300000], ["collection", "easypaisa", 200000], ["collection", "cash", total - 500000]]);
  assert.ok(t.every((x) => x.recordedOnly === true && x.actorUid === STAFF), "recorded entries, never claimed as verified gateway payments");
  assert.equal((await sale(id)).paymentMethod, "cod", "the sale still says how the customer chose to pay");
});

test("after a part-payment, recording the COD cash collects only what is still due", async () => {
  const p = await newProduct();
  const id = await place(p, 1);
  const total = (await sale(id)).total;
  await salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount: 400000, method: "bank_transfer", reference: "ADV-1" }), STAFF);
  await advance(id, "confirmed", "processing", "dispatched");
  await payments.recordCollection({ orderId: id }, STAFF);
  const t = await txns(id);
  assert.deepEqual(t.map((x) => x.amount), [400000, total - 400000], "the advance isn't collected twice");
  assert.equal(t.reduce((n, x) => n + x.amount, 0), total);
  await agree(id);
  const s = await sale(id);
  assert.deepEqual([s.paidTotal, s.amountDue, s.paymentStatus], [total, 0, "collected"]);
  await assert.rejects(payments.recordCollection({ orderId: id }, STAFF), (e) => /already recorded|can't be marked/.test(e.message));
});

test("a mistaken payment is corrected by a new opposite entry; the original is never edited and can't be reversed twice", async () => {
  const p = await newProduct();
  const id = await place(p, 1);
  const total = (await sale(id)).total;
  const pay1 = await salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount: 300000, method: "bank_transfer", reference: "WRONG-1" }), STAFF);
  await salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount: 200000, method: "cash" }), STAFF);
  const originalBefore = JSON.stringify((await db.doc(`payments/${id}/transactions/${pay1.transactionId}`).get()).data());

  const rev = await salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: pay1.transactionId, reason: "Wrong transfer id typed" }), STAFF);
  assert.deepEqual([rev.status, rev.paidTotal, rev.amountDue], ["partially_paid", 200000, total - 200000]);
  await agree(id, "after reversal");
  assert.equal(JSON.stringify((await db.doc(`payments/${id}/transactions/${pay1.transactionId}`).get()).data()), originalBefore, "the original entry is untouched");
  const t = await txns(id);
  assert.deepEqual(t.map((x) => x.type).sort(), ["collection", "collection", "reversal"]);
  const r = t.find((x) => x.type === "reversal");
  assert.deepEqual([r.reverses, r.amount, r.reason], [pay1.transactionId, 300000, "Wrong transfer id typed"]);
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: pay1.transactionId, reason: "Again, by mistake" }), STAFF), (e) => /already reversed/.test(e.message));
  assert.equal((await sale(id)).paidTotal, 200000, "not reversed twice");
  const cash = t.find((x) => x.type === "collection" && x.method === "cash");
  const dup = schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: cash.id, reason: "Cash not received" });
  const results = await Promise.all(Array.from({ length: 3 }, () => salePayments.reverseSalePayment(dup, STAFF)));
  assert.equal(results.filter((x) => !x.existing).length, 1);
  assert.deepEqual([(await sale(id)).paidTotal, (await sale(id)).paymentStatus], [0, "pending"], "back to nothing paid");
  await agree(id, "all reversed");
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: "nope", reason: "Not there at all" }), STAFF), (e) => e.code === "not-found");
});

test("a reversal is refused once money was refunded or the sale is closed", async () => {
  const p = await newProduct();
  const id = await place(p, 1);
  const total = (await sale(id)).total;
  const full = await salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, amount: total, method: "cash" }), STAFF);
  await payments.recordRefund({ orderId: id, amount: 1000, reason: "Goodwill" }, STAFF);
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: full.transactionId, reason: "Too late for this" }), STAFF), (e) => /refund/.test(e.message));
  const p2 = await newProduct();
  const id2 = await place(p2, 1);
  const paid = await salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id2, amount: 1000, method: "cash" }), STAFF);
  await advance(id2, "cancelled");
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id2, transactionId: paid.transactionId, reason: "Order was cancelled" }), STAFF), (e) => /closed|refund/.test(e.message));
  await assert.rejects(salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId: id2, amount: 1000, method: "cash" }), STAFF), (e) => /cancelled/.test(e.message), "no payment on a cancelled sale");
});

/* ───────── Access ───────── */

test("sales endpoints: nobody without the permission can read figures or touch payments", async () => {
  const range = { from: new Date(Date.now() - 30 * 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() };
  assert.equal((await call("salesSummary", null, range)).status, 401);
  assert.equal((await call("salesSummary", "customer", range)).status, 403);
  assert.equal((await call("salesSummary", "payer", range)).status, 403, "payments.update isn't sales.read");
  const viewer = await call("salesSummary", "viewer", range);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.data.profit, null, "no cost or profit without costs.read");
  assert.ok(!JSON.stringify(viewer.body).includes("costOfGoods"));
  const finance = await call("salesSummary", "finance", range);
  assert.equal(finance.status, 200);
  assert.ok(finance.body.data.profit && finance.body.data.profit.costOfGoods >= 0);
  const input = { idempotencyKey: key(), saleId: "x", amount: 100, method: "cash" };
  assert.equal((await call("recordSalePayment", null, input)).status, 401);
  assert.equal((await call("recordSalePayment", "customer", input)).status, 403);
  assert.equal((await call("recordSalePayment", "viewer", input)).status, 403, "viewing sales isn't recording payments");
  assert.equal((await call("recordSalePayment", "payer", { ...input, amount: 0 })).status, 400);
  assert.equal((await call("recordSalePayment", "payer", input)).status, 404, "allowed, but there is no such sale");
  assert.equal((await call("reverseSalePayment", "viewer", { idempotencyKey: key(), saleId: "x", transactionId: "t", reason: "Because" })).status, 403);
  assert.equal((await call("salesSummary", "viewer", { from: "2030-01-02", to: "2030-01-01" })).status, 400, "a backwards range");
});

/* ───────── Report ───────── */

test("the sales report adds up the saved sales and costs; POS stays an honest zero; profit counts only sales with a cost", async () => {
  const r = await reports.salesSummary({ from: new Date("2020-01-01"), to: new Date("2030-01-01") }, { canSeeCost: true });
  const all = (await db.collection("sales").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const counted = all.filter((s) => !["cancelled", "returned", "refunded"].includes(s.status));
  assert.equal(r.combined.sales, counted.length);
  assert.equal(r.combined.netSales, counted.reduce((n, s) => n + s.netSales, 0));
  assert.equal(r.combined.grossSales - r.combined.itemDiscounts - r.combined.couponDiscounts, r.combined.netSales, "gross − discounts = net");
  assert.equal(r.combined.total, r.combined.netSales + r.combined.deliveryCharges + r.combined.tax);
  assert.deepEqual(r.online, r.combined, "all sales so far are online");
  assert.equal(r.pos.sales, 0);
  assert.equal(r.pos.total, 0);
  assert.match(r.pos.note, /POS is not built/);
  assert.equal(r.byMethod.cod.sales, counted.length);
  assert.equal(Object.values(r.byStatus).reduce((n, x) => n + x, 0), all.length);

  const costs = (await db.collection("saleCosts").get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => counted.some((s) => s.id === c.id));
  const complete = costs.filter((c) => c.costComplete);
  assert.equal(r.profit.salesWithCost, complete.length);
  assert.equal(r.profit.salesWithoutCost, costs.length - complete.length);
  assert.equal(r.profit.grossProfit, complete.reduce((n, c) => n + c.grossProfit, 0));
  assert.equal(r.profit.costOfGoods, complete.reduce((n, c) => n + c.costTotal, 0));
  assert.equal(r.profit.netSalesWithCost - r.profit.costOfGoods, r.profit.grossProfit, "gross profit = net sales − cost of goods");
  const blind = await reports.salesSummary({ from: new Date("2020-01-01"), to: new Date("2030-01-01") }, { canSeeCost: false });
  assert.equal(blind.profit, null);
  assert.equal(blind.combined.netSales, r.combined.netSales);
  const empty = await reports.salesSummary({ from: new Date("2001-01-01"), to: new Date("2001-01-31") }, { canSeeCost: true });
  assert.deepEqual([empty.combined.sales, empty.combined.total, empty.profit.grossProfit], [0, 0, 0]);
});

/* ───────── Historical orders ───────── */

test("backfill: a dry run writes nothing; apply links old orders without changing them or inventing cost; running again does nothing", async () => {
  const p = await newProduct({ stock: 30, cost: 600000 });
  const old1 = await place(p, 2, {}, "legacy-1");
  const old2 = await place(p, 1, {}, "legacy-2");
  await advance(old2, "confirmed", "processing", "dispatched", "delivered");
  await payments.recordCollection({ orderId: old2 }, STAFF);
  const bad = await place(p, 1, {}, "legacy-3");
  const orphan = await place(p, 1, {}, "legacy-4");
  const orphanOrder = await order(orphan);
  // Make them look like orders from before sales existed.
  for (const id of [old1, old2, bad, orphan]) {
    await db.doc(`sales/${id}`).delete();
    await db.doc(`saleCosts/${id}`).delete();
    await db.doc(`orders/${id}`).update({ saleId: FieldValue.delete(), saleNumber: FieldValue.delete() });
  }
  await db.doc(`orders/${bad}`).update({ grandTotal: 1 }); // an order whose totals don't add up
  await db.doc(`orders/${orphan}`).delete(); // …and a sale left behind without its order
  await db.doc("sales/ghost-order").set({ ...(await sale(old1).catch(() => ({}))), channel: "online", orderId: "ghost-order", createdAt: new Date() });

  const snap = async () => JSON.stringify(await Promise.all([old1, old2, bad].map(async (id) => [await order(id), await pay(id), await txns(id)])));
  const counterBefore = (await get("counters/sales")).next;
  const orderState = await snap();
  const salesBefore = (await db.collection("sales").get()).size;
  const dry = await runSalesBackfill(db, { apply: false });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.toBackfill, 2);
  assert.deepEqual(dry.problems.orderTotalsDontAdd, [bad]);
  assert.deepEqual(dry.problems.saleWithoutOrder, ["ghost-order"]);
  assert.equal((await db.collection("sales").get()).size, salesBefore, "a dry run writes nothing");
  assert.equal((await get("counters/sales")).next, counterBefore);
  assert.equal(await snap(), orderState);

  const applied = await runSalesBackfill(db, { apply: true });
  assert.equal(applied.backfilled, 2);
  assert.equal(applied.skipped, 1, "the order that doesn't add up is left for a person to look at");
  assert.deepEqual(applied.verification.mismatches, []);
  assert.equal((await db.doc(`sales/${bad}`).get()).exists, false);
  for (const id of [old1, old2]) {
    const o = await order(id);
    const s = await sale(id);
    assert.equal(s.total, o.grandTotal);
    assert.equal(s.status, o.status);
    assert.equal(s.paymentStatus, (await pay(id)).status);
    assert.equal(s.createdAt.toMillis(), o.createdAt.toMillis(), "the original date is kept");
    assert.equal(o.saleId, id);
    assert.equal(o.updatedAt.toMillis(), (await db.doc(`orders/${id}`).get()).data().updatedAt.toMillis());
    assert.equal(s.channel, "online");
    const c = await saleCost(id);
    assert.deepEqual([c.costComplete, c.costTotal, c.grossProfit, c.costLines[0].unitCost], [false, null, null, null], "historical cost is not invented");
  }
  assert.equal((await sale(old2)).paymentStatus, "collected");
  assert.equal((await sale(old2)).paidTotal, (await order(old2)).grandTotal);
  const after = JSON.parse(await snap());
  const before = JSON.parse(orderState);
  for (const k of [0, 1]) {
    delete after[k][0].saleId;
    delete after[k][0].saleNumber;
    assert.deepEqual(after[k], before[k], "orders, payments and transactions are exactly as they were");
  }
  assert.deepEqual(JSON.parse(await snap())[2], before[2], "the skipped order wasn't touched");
  assert.equal(orphanOrder.number.length > 0, true);

  const again = await runSalesBackfill(db, { apply: true });
  assert.equal(again.backfilled, 0, "idempotent");
  assert.equal(again.alreadyLinked >= 2, true);
  const nums = (await db.collection("sales").get()).docs.map((d) => d.data().number);
  assert.equal(new Set(nums).size, nums.length, "numbers stay unique");
  assert.equal((await db.doc("_migrations/003-sales-backfill").get()).data().status, "done");
});
