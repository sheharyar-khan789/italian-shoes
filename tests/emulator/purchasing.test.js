/**
 * Suppliers and purchasing against the emulators (`npm run test:emulator`). All data is created inside a
 * throwaway "demo-" database for these tests; no real store data or accounts are involved.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const warehouses = await import("../../functions/services/warehouses.js");
const orders = await import("../../functions/services/orders.js");
const suppliers = await import("../../functions/services/suppliers.js");
const purchaseOrders = await import("../../functions/services/purchaseOrders.js");
const goods = await import("../../functions/services/goodsReceipts.js");
const payments = await import("../../functions/services/supplierPayments.js");
const returns = await import("../../functions/services/purchaseReturns.js");
const reports = await import("../../functions/services/purchaseReports.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");

const TOKENS = {
  buyer: { uid: "buyer-1", staff: true, perms: ["purchases.read", "suppliers.manage", "purchases.manage"], auth_time: 9999999999 },
  payer: { uid: "payer-1", staff: true, perms: ["purchases.read", "suppliers.pay"], auth_time: 9999999999 },
  reader: { uid: "reader-1", staff: true, perms: ["purchases.read"], auth_time: 9999999999 },
  customer: { uid: "c-1" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

const inv = async (p) => (await db.doc(`inventory/${p.productId}__${p.variantId}`).get()).data();
const at = async (p, wid) => (await inv(p)).byWarehouse?.[wid]?.onHand ?? 0;
const supplier = async (id) => (await db.doc(`suppliers/${id}`).get()).data();
const po = async (id) => (await db.doc(`purchaseOrders/${id}`).get()).data();
const cost = async (p) => (await db.doc(`variantCosts/${p.productId}__${p.variantId}`).get()).data();
const ledger = async (supplierId) => (await db.collection("supplierLedger").where("supplierId", "==", supplierId).get()).docs.map((d) => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis() || a.balanceAfter - b.balanceAfter);

async function makeVariant(name, slug, sku, { size = ids.s42 } = {}) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [size], price: 2000000, salePrice: null }), { actorUid: STAFF, canEditCost: false });
  return { productId, variantId: products.variantKey(ids.black, size) };
}
const newSupplier = async (name, over = {}) => (await suppliers.saveSupplier(schemas.saveSupplierInput.parse({ name, ...over }), STAFF)).id;
const line = (p, qty, unitCost, discount = 0) => ({ productId: p.productId, variantId: p.variantId, qty, unitCost, discount });
/** A draft that is approved and ready to receive. */
async function orderedPO(supplierId, warehouseId, lines, extra = {}) {
  const { id } = await purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ supplierId, warehouseId, lines, ...extra }), STAFF);
  await purchaseOrders.approvePurchaseOrder({ id }, STAFF);
  return id;
}
const receive = (poId, lines, over = {}) => goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: poId, lines, ...over }), STAFF);
const pay = (supplierId, amount, over = {}) => payments.recordSupplierPayment(schemas.supplierPaymentInput.parse({ idempotencyKey: key(), supplierId, amount, method: "cash", paidAt: "2026-01-15", ...over }), STAFF);
const giveBack = (grnId, lines, over = {}) => returns.createPurchaseReturn(schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId, reason: "Wrong size sent", lines, ...over }), STAFF);

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const uid of ["buyer-1", "payer-1", "reader-1"]) await auth.createUser({ uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  ids.s43 = (await catalog.saveCatalogItem("size", { system: "EU", value: "43", sortOrder: 43 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: true });
  await db.doc("shippingMethods/std").set({ name: "Standard", isActive: true });
  await db.collection("shippingRates").add({ methodId: "std", city: "*", charge: 10000, freeOver: null });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
});

/* ───────── Suppliers ───────── */

test("supplier endpoints need their permissions and validate input", async () => {
  const data = { name: "Al-Noor Traders", phone: "0300 1234567", openingBalance: 0 };
  assert.equal((await call("saveSupplier", null, data)).status, 401);
  assert.equal((await call("saveSupplier", "customer", data)).status, 403);
  assert.equal((await call("saveSupplier", "reader", data)).status, 403, "viewing isn't managing");
  assert.equal((await call("saveSupplier", "payer", data)).status, 403, "paying isn't managing");
  assert.equal((await call("saveSupplier", "buyer", { name: "A" })).status, 400);
  assert.equal((await call("saveSupplier", "buyer", { name: "Bad Email", email: "nope" })).status, 400);
  assert.equal((await call("saveSupplier", "buyer", { name: "Neg", openingBalance: -1 })).status, 400);
  const ok = await call("saveSupplier", "buyer", data);
  assert.equal(ok.status, 200);
  assert.equal((await call("saveSupplier", "buyer", { name: "al-noor traders" })).status, 409, "names are unique, case-insensitively");
  assert.equal((await supplier(ok.body.data.id)).balance, 0, "no opening balance unless one is entered");
  assert.equal((await ledger(ok.body.data.id)).length, 0, "…and no ledger line");
  for (const [name, d] of [["recordSupplierPayment", { idempotencyKey: key(), supplierId: "x", amount: 100, method: "cash", paidAt: "2026-01-01" }], ["receiveGoods", { idempotencyKey: key(), purchaseOrderId: "x", lines: [{ lineIndex: 0, acceptedQty: 1 }] }], ["approvePurchaseOrder", { id: "x" }], ["purchaseReport", { from: "2026-01-01", to: "2026-01-31" }]]) {
    assert.equal((await call(name, null, d)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", d)).status, 403, `${name} customer`);
  }
  assert.equal((await call("recordSupplierPayment", "buyer", { idempotencyKey: key(), supplierId: "x", amount: 100, method: "cash", paidAt: "2026-01-01" })).status, 403, "buying isn't paying");
  assert.equal((await call("approvePurchaseOrder", "payer", { id: "x" })).status, 403);
  assert.equal((await call("purchaseReport", "reader", { from: "2026-01-01", to: "2026-01-31" })).status, 200, "readers can view reports");
});

test("a supplier's opening balance is the first ledger line, can't be edited later, and a switched-off supplier gets no new orders", async () => {
  const id = await newSupplier("Opening Co", { openingBalance: 5000000, phone: "0321 0000000", address: "Lahore" });
  assert.equal((await supplier(id)).balance, 5000000);
  const l = await ledger(id);
  assert.deepEqual([l.length, l[0].type, l[0].credit, l[0].debit, l[0].balanceAfter], [1, "opening", 5000000, 0, 5000000]);
  await suppliers.saveSupplier(schemas.saveSupplierInput.parse({ id, name: "Opening Co", notes: "Pays on time", openingBalance: 999 }), STAFF);
  const s = await supplier(id);
  assert.equal(s.balance, 5000000, "editing never changes the balance");
  assert.equal(s.openingBalance, 5000000);
  assert.equal(s.notes, "Pays on time");
  assert.equal((await ledger(id)).length, 1);

  const p = await makeVariant("Off Supplier Shoe", "off-supplier-shoe", "OFF-1");
  await suppliers.setSupplierActive({ id, isActive: false }, STAFF);
  await assert.rejects(purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ supplierId: id, warehouseId: "main", lines: [line(p, 1, 100)] }), STAFF), (e) => /switched off/.test(e.message));
  await pay(id, 100); // money can still be paid to a switched-off supplier
  assert.equal((await supplier(id)).balance, 4999900);
  await suppliers.setSupplierActive({ id, isActive: true }, STAFF);
});

/* ───────── Purchase orders ───────── */

test("purchase order: totals are calculated on the server from unit costs and discounts; only drafts can be edited", async () => {
  const s = await newSupplier("PO Calc Supplier");
  const a = await makeVariant("Calc A", "calc-a", "CA-1");
  const b = await makeVariant("Calc B", "calc-b", "CB-1");
  const saved = await call("savePurchaseOrder", "buyer", { supplierId: s, warehouseId: "main", discount: 25000, lines: [line(a, 10, 120000, 50000), line(b, 4, 99950)], total: 1 /* a lying client */ });
  assert.equal(saved.status, 200);
  const d = await po(saved.body.data.id);
  assert.equal(d.status, "draft");
  assert.match(d.number, /^PO-\d{6}$/);
  assert.deepEqual([d.subtotal, d.orderDiscount, d.total, d.itemCount], [1549800, 25000, 1524800, 14]);
  assert.equal(d.lines.reduce((n, l) => n + l.effective, 0), d.total);
  assert.equal(d.lines[0].productName, "Calc A");
  assert.deepEqual([d.lines[0].receivedQty, d.lines[0].rejectedQty], [0, 0]);
  assert.equal((await call("savePurchaseOrder", "buyer", { supplierId: s, warehouseId: "main", discount: 99999999, lines: [line(a, 1, 100)] })).status, 400, "a discount bigger than the subtotal");
  assert.equal((await call("savePurchaseOrder", "buyer", { supplierId: s, warehouseId: "main", lines: [{ ...line(a, 1, 100), discount: 101 }] })).status, 400, "a line discount bigger than the line");

  const id = saved.body.data.id;
  await purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ id, supplierId: s, warehouseId: "main", lines: [line(a, 2, 100000)] }), STAFF);
  assert.equal((await po(id)).total, 200000, "a draft can be edited");
  await assert.rejects(receive(id, [{ lineIndex: 0, acceptedQty: 1 }]), (e) => /Approve the purchase order/.test(e.message), "nothing is received against a draft");
  await purchaseOrders.approvePurchaseOrder({ id }, STAFF);
  assert.equal((await po(id)).status, "ordered");
  await assert.rejects(purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ id, supplierId: s, warehouseId: "main", lines: [line(a, 3, 100000)] }), STAFF), (e) => /Only a draft/.test(e.message));
  await assert.rejects(purchaseOrders.approvePurchaseOrder({ id }, STAFF), (e) => /can't be approved/.test(e.message), "approving twice");
  await purchaseOrders.cancelPurchaseOrder({ id }, STAFF);
  assert.equal((await po(id)).status, "cancelled");
  await assert.rejects(receive(id, [{ lineIndex: 0, acceptedQty: 1 }]), (e) => /cancelled/.test(e.message));
  assert.equal(await at(a, "main"), 0, "nothing was stocked");
});

/* ───────── Receiving ───────── */

test("partial then full receiving: stock goes to the order's warehouse, movements reference the GRN, status stays accurate", async () => {
  const s = await newSupplier("Receiving Supplier");
  const p = await makeVariant("Receive Me", "receive-me", "RM-1");
  const id = await orderedPO(s, ids.shop, [line(p, 10, 100000)]); // Rs 1,000 each, into the (not online) shop floor
  assert.equal((await po(id)).total, 1000000);

  const g1 = await receive(id, [{ lineIndex: 0, acceptedQty: 4, rejectedQty: 1, rejectReason: "Stitching undone" }], { supplierInvoiceNo: "INV-77" });
  assert.equal(await at(p, ids.shop), 4, "only accepted pairs are stocked, in the order's warehouse");
  assert.equal(await at(p, "main"), 0);
  assert.equal((await inv(p)).onHand, 0, "a non-online warehouse doesn't add to what the shop can sell");
  const d1 = await po(id);
  assert.equal(d1.status, "partially_received");
  assert.deepEqual([d1.lines[0].receivedQty, d1.lines[0].rejectedQty], [4, 1]);
  assert.equal(d1.receivedValue, 400000, "only accepted pairs are owed for");
  const grn = (await db.doc(`goodsReceipts/${g1.grnId}`).get()).data();
  assert.equal(grn.number, g1.number);
  assert.deepEqual([grn.acceptedUnits, grn.rejectedUnits, grn.value, grn.warehouseId, grn.receivedBy], [4, 1, 400000, ids.shop, STAFF]);
  assert.equal(grn.supplierInvoiceNo, "INV-77");
  assert.ok(grn.receivedDate && grn.createdAt);
  assert.equal(grn.lines[0].rejectReason, "Stitching undone");
  const m = (await db.collection("stockMovements").where("inventoryId", "==", `${p.productId}__${p.variantId}`).get()).docs.map((x) => x.data());
  assert.equal(m.length, 1);
  assert.deepEqual([m[0].reason, m[0].sourceType, m[0].sourceId, m[0].warehouseId, m[0].change, m[0].quantity], ["purchase_receipt", "grn", g1.grnId, ids.shop, 4, 4]);
  assert.match(m[0].note, /GRN-\d{6}/);
  assert.equal((await supplier(s)).balance, 400000);

  await assert.rejects(receive(id, [{ lineIndex: 0, acceptedQty: 6 }]), (e) => /only 5 still to receive/.test(e.message), "pending is ordered − received − rejected");
  await assert.rejects(receive(id, [{ lineIndex: 7, acceptedQty: 1 }]), (e) => /isn't on the purchase order/.test(e.message));
  assert.equal(await at(p, ids.shop), 4, "refused deliveries change nothing");

  const g2 = await receive(id, [{ lineIndex: 0, acceptedQty: 5 }]);
  assert.equal((await po(id)).status, "received", "everything accounted for (accepted + rejected = ordered)");
  assert.equal(await at(p, ids.shop), 9);
  assert.equal((await supplier(s)).balance, 900000);
  assert.notEqual(g2.grnId, g1.grnId);
  await assert.rejects(receive(id, [{ lineIndex: 0, acceptedQty: 1 }]), (e) => /received/.test(e.message), "a fully received order takes no more");
});

test("the same delivery sent twice (even at once) is received once", async () => {
  const s = await newSupplier("Twice Supplier");
  const p = await makeVariant("Twice", "twice-po", "TW-9");
  const id = await orderedPO(s, "main", [line(p, 10, 50000)]);
  const input = schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: id, lines: [{ lineIndex: 0, acceptedQty: 6 }] });
  const results = await Promise.all(Array.from({ length: 5 }, () => goods.receiveGoods(input, STAFF)));
  assert.equal(new Set(results.map((r) => r.grnId)).size, 1, "everyone gets the same GRN");
  assert.equal(results.filter((r) => !r.existing).length, 1, "exactly one actually received");
  assert.equal(await at(p, "main"), 6);
  assert.equal((await db.collection("goodsReceipts").where("purchaseOrderId", "==", id).get()).size, 1);
  assert.equal((await supplier(s)).balance, 300000);
  assert.equal((await ledger(s)).length, 1, "one ledger line");
});

test("the supplier ledger and balance always agree (credit − debit, running balance)", async () => {
  const s = await newSupplier("Ledger Supplier", { openingBalance: 100000 });
  const p = await makeVariant("Ledger Shoe", "ledger-shoe", "LS-1");
  const id = await orderedPO(s, "main", [line(p, 10, 20000)]);
  const g = await receive(id, [{ lineIndex: 0, acceptedQty: 10 }]); // +200,000
  await pay(s, 50000, { purchaseOrderId: id }); // −50,000
  await giveBack(g.grnId, [{ lineIndex: 0, qty: 2 }]); // −40,000
  await pay(s, 10000); // −10,000
  const l = await ledger(s);
  assert.deepEqual(l.map((e) => [e.type, e.debit, e.credit, e.balanceAfter]), [["opening", 0, 100000, 100000], ["purchase", 0, 200000, 300000], ["payment", 50000, 0, 250000], ["return", 40000, 0, 210000], ["payment", 10000, 0, 200000]]);
  assert.equal((await supplier(s)).balance, 200000);
  assert.equal(l.reduce((n, e) => n + e.credit - e.debit, 0), 200000);
  const sup = await supplier(s);
  assert.deepEqual([sup.totalPurchased, sup.totalReturned, sup.totalPaid], [200000, 40000, 60000]);
  assert.ok(l.every((e) => e.refType && e.refNumber && e.actorUid));
});

/* ───────── Costs ───────── */

test("purchase cost: moving average over several purchases; history keeps every purchase; a variant save doesn't wipe it", async () => {
  const s = await newSupplier("Cost Supplier");
  const p = await makeVariant("Cost Shoe", "cost-shoe", "CS-1");
  await inventory.adjustStock({ productId: p.productId, variantId: p.variantId, change: 10, reason: "initial", note: "" }, STAFF);
  await db.doc(`variantCosts/${p.productId}__${p.variantId}`).set({ productId: p.productId, variantId: p.variantId, costPrice: 100000 }); // 10 pairs on hand at Rs 1,000
  const first = await receive(await orderedPO(s, "main", [line(p, 10, 140000)]), [{ lineIndex: 0, acceptedQty: 10 }]);
  assert.equal((await cost(p)).costPrice, 120000, "(10 × 1,000 + 10 × 1,400) / 20 = Rs 1,200");
  assert.equal((await cost(p)).costMethod, "moving_average");
  assert.equal((await cost(p)).lastPurchaseCost, 140000);

  // Stock changes, then a purchase with a discount: 20 pairs on hand → sell 5 → 15 at Rs 1,200, then 5 pairs for Rs 5,000 total (Rs 1,000 each after discount).
  await inventory.adjustStock({ productId: p.productId, variantId: p.variantId, change: -5, reason: "correction", note: "sold in shop" }, STAFF);
  const g2 = await receive(await orderedPO(s, "main", [line(p, 5, 110000, 50000)]), [{ lineIndex: 0, acceptedQty: 5 }]);
  assert.equal((await db.doc(`goodsReceipts/${g2.grnId}`).get()).data().value, 500000, "line discount applied to the value");
  assert.equal((await cost(p)).costPrice, 115000, "(15 × 1,200 + 5,000) / 20 = Rs 1,150");

  const hist = (await db.collection("variantCostHistory").where("productId", "==", p.productId).get()).docs.map((d) => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
  assert.deepEqual(hist.map((h) => [h.qty, h.unitCost, h.onHandBefore, h.costBefore, h.costAfter]), [[10, 140000, 10, 100000, 120000], [5, 100000, 15, 120000, 115000]], "every purchase is kept with its own numbers");
  const g1 = (await db.doc(`goodsReceipts/${first.grnId}`).get()).data();
  assert.deepEqual([g1.lines[0].unitCost, g1.lines[0].costBefore, g1.lines[0].costAfter], [140000, 100000, 120000], "an old GRN still shows its own cost after later changes");

  await products.saveVariant(schemas.saveVariantInput.parse({ productId: p.productId, variantId: p.variantId, colorId: ids.black, sizeId: ids.s42, sku: (await db.doc(`products/${p.productId}/variants/${p.variantId}`).get()).data().sku, price: 2000000, salePrice: null, costPrice: 118000, isActive: true, lowStockThreshold: null }), { actorUid: STAFF, canEditCost: true });
  const c = await cost(p);
  assert.equal(c.costPrice, 118000, "an owner's manual cost is respected as the new baseline");
  assert.equal(c.lastPurchaseCost, 100000, "…without erasing the purchase facts");
});

test("with no stock or no cost on file, the first purchase sets the cost", async () => {
  const s = await newSupplier("First Cost Supplier");
  const p = await makeVariant("First Cost", "first-cost", "FC-1");
  await receive(await orderedPO(s, "main", [line(p, 3, 77700)]), [{ lineIndex: 0, acceptedQty: 3 }]);
  assert.equal((await cost(p)).costPrice, 77700);
});

/* ───────── Payments ───────── */

test("supplier payments: full and part payments, several against one order, never more than is owed", async () => {
  const s = await newSupplier("Pay Supplier");
  const p = await makeVariant("Pay Shoe", "pay-shoe", "PY-1");
  const id = await orderedPO(s, "main", [line(p, 10, 100000)]);
  await receive(id, [{ lineIndex: 0, acceptedQty: 6 }]); // owes 600,000 so far

  const p1 = await pay(s, 200000, { purchaseOrderId: id, method: "bank_transfer", reference: "TXN-1001", note: "advance" });
  assert.equal(p1.balance, 400000);
  assert.equal((await po(id)).paymentStatus, "partial");
  assert.equal((await po(id)).paidTotal, 200000);
  await pay(s, 150000, { purchaseOrderId: id, method: "easypaisa", reference: "EP-55" });
  await pay(s, 250000, { purchaseOrderId: id });
  assert.equal((await po(id)).paymentStatus, "paid", "three payments cleared the received goods");
  assert.equal((await supplier(s)).balance, 0);
  await assert.rejects(pay(s, 1), (e) => /not owed anything/.test(e.message), "nothing left to pay");

  await receive(id, [{ lineIndex: 0, acceptedQty: 4 }]); // 400,000 more received
  assert.equal((await po(id)).paymentStatus, "partial", "more goods received → owing again");
  await assert.rejects(pay(s, 400001, { purchaseOrderId: id }), (e) => e.code === "invalid-argument" && /owed|owes/.test(e.message), "more than is owed is refused");
  await pay(s, 400000, { purchaseOrderId: id });
  assert.equal((await po(id)).paymentStatus, "paid");

  const rows = (await db.collection("supplierPayments").where("supplierId", "==", s).get()).docs.map((d) => d.data()).sort((a, b) => a.number.localeCompare(b.number));
  assert.deepEqual(rows.map((r) => [r.amount, r.method]), [[200000, "bank_transfer"], [150000, "easypaisa"], [250000, "cash"], [400000, "cash"]]);
  assert.ok(rows.every((r) => r.recordedOnly === true && r.paidAt && r.recordedBy === STAFF && /^SP-\d{6}$/.test(r.number)));
  assert.equal(rows[0].reference, "TXN-1001");
});

test("a payment against an order can't exceed what that order still owes; the same payment sent twice is recorded once", async () => {
  const s = await newSupplier("Cap Supplier", { openingBalance: 1000000 });
  const p = await makeVariant("Cap Shoe", "cap-shoe", "CP-1");
  const id = await orderedPO(s, "main", [line(p, 2, 100000)]);
  await receive(id, [{ lineIndex: 0, acceptedQty: 2 }]);
  await assert.rejects(pay(s, 200001, { purchaseOrderId: id }), (e) => /still owes/.test(e.message), "the supplier is owed more overall, but this order isn't");
  await pay(s, 500000); // against the opening balance, no order
  const input = schemas.supplierPaymentInput.parse({ idempotencyKey: key(), supplierId: s, amount: 100000, method: "cash", paidAt: "2026-02-01" });
  const results = await Promise.all(Array.from({ length: 4 }, () => payments.recordSupplierPayment(input, STAFF)));
  assert.equal(new Set(results.map((r) => r.paymentId)).size, 1);
  assert.equal(results.filter((r) => !r.existing).length, 1);
  assert.equal((await supplier(s)).balance, 1200000 - 500000 - 100000);
  await assert.rejects(payments.recordSupplierPayment({ ...input, idempotencyKey: key(), purchaseOrderId: "nope" }, STAFF), (e) => /isn't this supplier's/.test(e.message));
});

/* ───────── Returns ───────── */

test("purchase return: stock leaves the receiving warehouse, the supplier is credited, returns can't exceed what was received", async () => {
  const s = await newSupplier("Return Supplier");
  const p = await makeVariant("Return Shoe", "return-shoe", "RT-1");
  const id = await orderedPO(s, ids.shop, [line(p, 10, 100000)]);
  const g = await receive(id, [{ lineIndex: 0, acceptedQty: 8, rejectedQty: 2, rejectReason: "Wrong colour" }]);
  assert.equal(await at(p, ids.shop), 8);
  assert.equal((await supplier(s)).balance, 800000);

  const r1 = await giveBack(g.grnId, [{ lineIndex: 0, qty: 3 }], { supplierReference: "RMA-9" });
  assert.equal(await at(p, ids.shop), 5, "taken from the warehouse the goods went into");
  assert.equal((await supplier(s)).balance, 500000, "3 × Rs 1,000 off what is owed");
  const ret = (await db.doc(`purchaseReturns/${r1.returnId}`).get()).data();
  assert.deepEqual([ret.value, ret.units, ret.warehouseId, ret.reason, ret.supplierReference, ret.grnId], [300000, 3, ids.shop, "Wrong size sent", "RMA-9", g.grnId]);
  const m = (await db.collection("stockMovements").where("sourceId", "==", r1.returnId).get()).docs.map((x) => x.data());
  assert.deepEqual([m.length, m[0].reason, m[0].sourceType, m[0].change, m[0].warehouseId], [1, "purchase_return", "purchase_return", -3, ids.shop]);
  const grn = (await db.doc(`goodsReceipts/${g.grnId}`).get()).data();
  assert.deepEqual([grn.lines[0].returnedQty, grn.lines[0].returnedValue, grn.returnedValue], [3, 300000, 300000]);
  assert.equal((await po(id)).returnedValue, 300000);

  await assert.rejects(giveBack(g.grnId, [{ lineIndex: 0, qty: 6 }]), (e) => /only 5 can still be returned/.test(e.message), "8 received, 3 returned → 5 left");
  await giveBack(g.grnId, [{ lineIndex: 0, qty: 5 }]);
  await assert.rejects(giveBack(g.grnId, [{ lineIndex: 0, qty: 1 }]), (e) => /only 0 can still be returned/.test(e.message), "everything received has been returned");
  assert.equal(await at(p, ids.shop), 0);
  assert.equal((await supplier(s)).balance, 0, "nothing owed for goods that went back");
  assert.equal((await supplier(s)).totalReturned, 800000);
});

test("a return sent twice is recorded once; a return is refused if the warehouse no longer holds the pairs", async () => {
  const s = await newSupplier("Return Twice Supplier");
  const p = await makeVariant("Return Twice", "return-twice", "RW-1");
  const g = await receive(await orderedPO(s, "main", [line(p, 6, 100000)]), [{ lineIndex: 0, acceptedQty: 6 }]);
  const input = schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId: g.grnId, reason: "Damaged in transit", lines: [{ lineIndex: 0, qty: 2 }] });
  const results = await Promise.all(Array.from({ length: 4 }, () => returns.createPurchaseReturn(input, STAFF)));
  assert.equal(new Set(results.map((r) => r.returnId)).size, 1);
  assert.equal(results.filter((r) => !r.existing).length, 1);
  assert.equal(await at(p, "main"), 4, "returned once");
  assert.equal((await supplier(s)).balance, 400000);

  await inventory.adjustStock({ productId: p.productId, variantId: p.variantId, change: -3, reason: "damaged", note: "sold or lost" }, STAFF); // 1 pair left
  await assert.rejects(giveBack(g.grnId, [{ lineIndex: 0, qty: 2 }]), (e) => /Only 1 in stock/.test(e.message), "can't return pairs that are no longer there");
  assert.equal((await supplier(s)).balance, 400000, "a refused return changes nothing");
  assert.equal((await db.doc(`goodsReceipts/${g.grnId}`).get()).data().lines[0].returnedQty, 2);
});

/* ───────── Compatibility ───────── */

test("received stock is sold by the unchanged online checkout and the product summary stays right", async () => {
  const s = await newSupplier("Checkout Supplier");
  const p = await makeVariant("Sold Online", "sold-online", "SO-1");
  await receive(await orderedPO(s, "main", [line(p, 3, 100000)]), [{ lineIndex: 0, acceptedQty: 3 }]);
  assert.equal((await inv(p)).onHand, 3);
  assert.equal((await db.doc(`products/${p.productId}`).get()).data().summary.totalStock, 3, "the shop's stock summary follows the receipt");
  await db.doc(`products/${p.productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  const o = await orders.placeOrder(
    schemas.placeOrderSchema.parse({
      idempotencyKey: randomUUID(),
      items: [{ productId: p.productId, variantId: p.variantId, qty: 2 }],
      customer: { name: "Test Customer", phone: "0300 1234567" },
      address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
      shippingMethodId: "std",
      paymentMethod: "cod",
      termsAccepted: true,
    }),
    { uid: "cust-1" },
  );
  assert.equal(await at(p, "main"), 1);
  await orders.updateOrderStatus({ orderId: o.orderId, status: "cancelled", note: "" }, { actorUid: STAFF });
  assert.equal(await at(p, "main"), 3);
});

/* ───────── Report ───────── */

test("the purchase report adds up the real receipts, returns, payments and what is owed", async () => {
  const from = new Date(Date.now() - 86400000);
  const to = new Date(Date.now() + 86400000);
  const r = await reports.purchaseReport({ from, to });
  const grns = (await db.collection("goodsReceipts").get()).docs.map((d) => d.data());
  const rets = (await db.collection("purchaseReturns").get()).docs.map((d) => d.data());
  const pays = (await db.collection("supplierPayments").get()).docs.map((d) => d.data());
  assert.equal(r.purchased, grns.reduce((n, g) => n + g.value, 0));
  assert.equal(r.returned, rets.reduce((n, x) => n + x.value, 0));
  assert.equal(r.paid, pays.reduce((n, x) => n + x.amount, 0));
  assert.equal(r.netPurchases, r.purchased - r.returned);
  assert.equal(r.receipts, grns.length);
  assert.equal(r.payable, (await db.collection("suppliers").get()).docs.reduce((n, d) => n + (d.data().balance ?? 0), 0));
  assert.equal(r.bySupplier.reduce((n, x) => n + x.purchased, 0), r.purchased);
  assert.equal(r.paidByMethod.bank_transfer, 200000);
  assert.ok(r.topItems.length > 0 && r.topItems.length <= 10);
  const empty = await reports.purchaseReport({ from: new Date("2001-01-01"), to: new Date("2001-01-31") });
  assert.deepEqual([empty.purchased, empty.returned, empty.paid, empty.receipts], [0, 0, 0, 0]);
  assert.equal(empty.payable, r.payable, "what is owed now doesn't depend on the range");
});
