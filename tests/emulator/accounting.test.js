/**
 * Double-entry accounting against the emulators (`npm run test:emulator`). All data is created inside a throwaway
 * "demo-" database for these tests; no real store data or accounts are involved. The tests run in order and share
 * state, the way the business events do.
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
const orders = await import("../../functions/services/orders.js");
const payments = await import("../../functions/services/payments.js");
const salePayments = await import("../../functions/services/salePayments.js");
const coupons = await import("../../functions/services/coupons.js");
const shipping = await import("../../functions/services/shipping.js");
const suppliers = await import("../../functions/services/suppliers.js");
const purchaseOrders = await import("../../functions/services/purchaseOrders.js");
const goods = await import("../../functions/services/goodsReceipts.js");
const supplierPayments = await import("../../functions/services/supplierPayments.js");
const purchaseReturns = await import("../../functions/services/purchaseReturns.js");
const accounting = await import("../../functions/services/accounting.js");
const reports = await import("../../functions/services/accountingReports.js");
const { runAccountingBackfill } = await import("../../functions/migrations/004-accounting-backfill.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");

const STAFF = "staff-1";
const ids = {};
const hist = {};
let seq = 0;
const today = pktDateKey(new Date());
const key = () => randomUUID().replace(/-/g, "");

const TOKENS = {
  reader: { uid: "ac-r", staff: true, perms: ["accounting.read"], auth_time: 9999999999 },
  manager: { uid: "ac-m", staff: true, perms: ["accounting.read", "accounting.manage"], auth_time: 9999999999 },
  poster: { uid: "ac-p", staff: true, perms: ["accounting.read", "accounting.post"], auth_time: 9999999999 },
  reverser: { uid: "ac-v", staff: true, perms: ["accounting.read", "accounting.reverse"], auth_time: 9999999999 },
  orders: { uid: "ac-o", staff: true, perms: ["orders.read", "sales.read", "purchases.read"], auth_time: 9999999999 },
  customer: { uid: "ac-c" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

const get = async (path) => (await db.doc(path).get()).data();
const lines = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.map((d) => d.data());
/** Debit − credit of an account, from its ledger rows. */
const net = async (code) => (await lines(code)).reduce((n, l) => n + l.debit - l.credit, 0);
const journals = async () => (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
/** Every account's net balance, for before/after comparisons. */
async function allNets() {
  const m = {};
  for (const l of (await db.collection("ledgerEntries").get()).docs) m[l.data().accountCode] = (m[l.data().accountCode] ?? 0) + l.data().debit - l.data().credit;
  for (const k of Object.keys(m)) if (m[k] === 0) delete m[k];
  return m;
}

async function newProduct({ stock = 50, price = 1000000, sale = null, cost = null } = {}) {
  seq += 1;
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Acct Item ${seq}`, slug: `acct-item-${seq}`, categoryId: ids.cat, sku: `AC-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: sale, ...(cost ? { costPrice: cost } : {}) }), { actorUid: STAFF, canEditCost: true });
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
const place = async (p, qty = 1, over = {}, uid = "cust-a") => (await orders.placeOrder(draft(p, qty, over), { uid })).orderId;
const advance = async (id, ...path) => {
  for (const status of path) await orders.updateOrderStatus({ orderId: id, status }, { actorUid: STAFF });
};
const line = (p, qty, unitCost, discount = 0) => ({ productId: p.productId, variantId: p.variantId, qty, unitCost, discount });
const newSupplier = async (name, over = {}) => (await suppliers.saveSupplier(schemas.saveSupplierInput.parse({ name, ...over }), STAFF)).id;
async function receivedPO(supplierId, p, qty, unitCost, accepted, rejected = 0) {
  const { id } = await purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ supplierId, warehouseId: "main", lines: [line(p, qty, unitCost)] }), STAFF);
  await purchaseOrders.approvePurchaseOrder({ id }, STAFF);
  const g = await goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: id, lines: [{ lineIndex: 0, acceptedQty: accepted, rejectedQty: rejected, rejectReason: rejected ? "Damaged" : "" }] }), STAFF);
  return { poId: id, grnId: g.grnId };
}
const pay = (supplierId, amount, over = {}) => supplierPayments.recordSupplierPayment(schemas.supplierPaymentInput.parse({ idempotencyKey: key(), supplierId, amount, method: "cash", paidAt: today, ...over }), STAFF);
const salePay = (saleId, amount, method, reference = "") => salePayments.recordSalePayment(schemas.recordSalePaymentInput.parse({ idempotencyKey: key(), saleId, amount, method, reference }), STAFF);

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const uid of ["ac-r", "ac-m", "ac-p", "ac-v", "ac-o"]) await auth.createUser({ uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true });
  ids.method = (await shipping.saveMethod(schemas.saveShippingMethodInput.parse({ name: "Standard" }), STAFF)).id;
  await shipping.saveRate({ methodId: ids.method, city: "*", charge: 20000, freeOver: null }, STAFF);
});

/* ───────── Before accounting exists ───────── */

test("before accounting is set up the business carries on and nothing is posted; the reports say so", async () => {
  const a = await newProduct({ cost: 600000 });
  const b = await newProduct();
  hist.o1 = await place(a, 2);
  await advance(hist.o1, "confirmed", "processing", "dispatched", "delivered");
  await payments.recordCollection({ orderId: hist.o1 }, STAFF);
  hist.o2 = await place(a, 1);
  await orders.updateOrderStatus({ orderId: hist.o2, status: "cancelled" }, { actorUid: STAFF });
  hist.o3 = await place(b, 1); // no cost on file
  hist.supplier = await newSupplier("History Supplier");
  const r = await receivedPO(hist.supplier, a, 10, 500000, 10);
  hist.grn = r.grnId;
  hist.payment = (await pay(hist.supplier, 2000000)).paymentId;
  hist.ret = (await purchaseReturns.createPurchaseReturn(schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId: r.grnId, reason: "Wrong colour", lines: [{ lineIndex: 0, qty: 2 }] }), STAFF)).returnId;
  assert.equal((await journals()).length, 0, "no journals");
  assert.equal((await db.collection("accountingExceptions").get()).size, 0, "and no failed postings: accounting simply isn't on");
  assert.equal((await db.doc("accountingConfig/main").get()).exists, false);
  const res = await call("trialBalance", "reader", { from: "2020-01-01", to: today });
  assert.notEqual(res.status, 200);
  assert.match(res.body.error.message, /set up/);
  hist.before = JSON.stringify({ inv: (await db.collection("inventory").get()).docs.map((d) => [d.id, d.data().onHand, d.data().totalOnHand]).sort(), sup: (await get(`suppliers/${hist.supplier}`)).balance, sales: (await db.collection("sales").get()).size });
});

/* ───────── Chart of accounts ───────── */

test("only the owner-level manager sets up the chart; it is created once, as structure with no balances", async () => {
  for (const t of [null, "customer", "reader", "poster", "reverser", "orders"]) assert.equal((await call("initializeAccounting", t, {})).status, t ? 403 : 401, `${t}`);
  const first = await call("initializeAccounting", "manager", {});
  assert.equal(first.status, 200);
  assert.equal(first.body.data.created, true);
  assert.equal((await call("initializeAccounting", "manager", {})).body.data.created, false, "doing it twice changes nothing");
  const accounts = (await db.collection("accounts").get()).docs.map((d) => d.data());
  assert.equal(accounts.length, 30);
  assert.equal(new Set(accounts.map((a) => a.code)).size, 30, "unique codes (the code is the id)");
  const cfg = await get("accountingConfig/main");
  assert.equal(cfg.enabled, true);
  assert.deepEqual([cfg.roles.cash, cfg.roles.bank, cfg.roles.wallet_clearing, cfg.roles.cod_receivable, cfg.roles.inventory, cfg.roles.accounts_payable], ["1010", "1021", "1030", "1100", "1200", "2010"]);
  assert.equal((await db.collection("ledgerEntries").get()).size, 0, "no balance was invented");
  assert.equal((await journals()).length, 0);
});

test("accounts: children must match their parent; codes and types are fixed; used or standard accounts can't be deleted", async () => {
  const save = (data) => accounting.saveAccount(schemas.saveAccountInput.parse({ type: "asset", ...data }), STAFF);
  await save({ code: "1022", name: "HBL Current Account", parentCode: "1020" });
  assert.equal((await get("accounts/1022")).parentCode, "1020");
  assert.equal((await get("accountingConfig/main")).accounts["1022"].name, "HBL Current Account");
  await assert.rejects(save({ code: "1023", name: "Wrong parent type", type: "expense", parentCode: "1020" }), (e) => /same type/.test(e.message));
  await assert.rejects(save({ code: "1024", name: "Parent is an account", parentCode: "1010" }), (e) => /heading/.test(e.message));
  await save({ code: "1022", name: "HBL Current (renamed)", parentCode: "1020" });
  assert.equal((await get("accounts/1022")).name, "HBL Current (renamed)");
  await assert.rejects(accounting.saveAccount(schemas.saveAccountInput.parse({ code: "1022", name: "Now a liability", type: "liability" }), STAFF), (e) => /can't be changed/.test(e.message));
  await accounting.setAccountActive({ code: "1022", isActive: false }, STAFF);
  assert.equal((await get("accountingConfig/main")).accounts["1022"].active, false);
  await accounting.setAccountActive({ code: "1022", isActive: true }, STAFF);
  await assert.rejects(accounting.setAccountActive({ code: "1010", isActive: false }, STAFF), (e) => /automatic postings/.test(e.message));
  await assert.rejects(accounting.deleteAccount({ code: "1010" }, STAFF), (e) => /standard accounts/.test(e.message));
  await assert.rejects(accounting.deleteAccount({ code: "1020" }, STAFF), (e) => /sub-accounts/.test(e.message));
  await save({ code: "1090", name: "Temporary" });
  assert.deepEqual(await accounting.deleteAccount({ code: "1090" }, STAFF), { code: "1090" }, "an unused account can go");
  await assert.rejects(accounting.setRoleAccount({ role: "bank", code: "6010" }, STAFF), (e) => /asset/.test(e.message), "a role needs an account of its type");
  await accounting.setRoleAccount({ role: "bank", code: "1022" }, STAFF);
  assert.equal((await get("accountingConfig/main")).roles.bank, "1022");
  await accounting.setRoleAccount({ role: "bank", code: "1021" }, STAFF);
});

/* ───────── Historical backfill ───────── */

test("historical backfill: a dry run writes nothing, apply posts what is reliable, nothing is invented, running again does nothing", async () => {
  const dry = await runAccountingBackfill(db, { apply: false });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.ready, true);
  assert.deepEqual(dry.events, { sale: 3, sale_reversal: 1, payment: 1, grn: 1, supplier_payment: 1, purchase_return: 1 });
  assert.equal(dry.toPost, 8);
  assert.equal(dry.postedWithoutCost, 1, "the sale with no recorded cost would post revenue only");
  assert.deepEqual([dry.skipped.length, dry.wouldFail.length], [0, 0]);
  assert.equal((await journals()).length, 0, "a dry run writes nothing");

  const applied = await runAccountingBackfill(db, { apply: true });
  assert.deepEqual([applied.posted, applied.failed, applied.skipped.length], [8, 0, 0]);
  assert.deepEqual(applied.verification.missing, []);
  assert.equal(applied.verification.trialBalanceBalanced, true);
  const js = await journals();
  assert.equal(js.length, 8);
  assert.ok(js.every((j) => j.status === "posted" && j.totalDebit === j.totalCredit));
  assert.equal(js.find((j) => j.id === `sale__${hist.o3}`).costMissing, true);
  assert.ok(!js.find((j) => j.id === `sale__${hist.o3}`).lines.some((l) => l.accountCode === "5010"), "no cost of goods sold was invented");
  assert.ok(js.find((j) => j.id === `sale__${hist.o1}`).lines.some((l) => l.accountCode === "5010"), "the recorded cost was used");
  assert.ok(js.some((j) => j.id === `reversal__sale__${hist.o2}`), "the cancelled sale is reversed");

  // Balances follow the history: o1 (collected), o2 (cancelled), o3 (still owed), GRN, supplier payment, return.
  assert.equal(await net("1100"), 1020000, "only the uncollected order is still receivable");
  assert.equal(await net("1010"), 20000, "cash in: Rs 20,200; cash out: Rs 20,000");
  assert.equal(await net("4010"), -3000000, "revenue at list price (the cancelled sale is reversed)");
  assert.equal(await net("5010"), 1200000);
  assert.equal(await net("1200"), 2800000, "5,000,000 received − 1,200,000 sold − 1,000,000 returned");
  assert.equal(await net("2010"), -2000000, "5,000,000 − 2,000,000 paid − 1,000,000 returned");
  assert.equal((await get(`partyBalances/supplier__${hist.supplier}`)).balance, 2000000);
  assert.equal((await get(`suppliers/${hist.supplier}`)).balance, 2000000, "…which matches the supplier ledger");

  const again = await runAccountingBackfill(db, { apply: true });
  assert.deepEqual([again.posted, again.toPost, again.alreadyPosted], [0, 0, 8], "idempotent");
  assert.equal((await journals()).length, 8);
  const after = JSON.stringify({ inv: (await db.collection("inventory").get()).docs.map((d) => [d.id, d.data().onHand, d.data().totalOnHand]).sort(), sup: (await get(`suppliers/${hist.supplier}`)).balance, sales: (await db.collection("sales").get()).size });
  assert.equal(after, hist.before, "stock, supplier balances and sales are exactly as they were");
  assert.equal((await get("_migrations/004-accounting-backfill")).status, "done");
});

/* ───────── Live postings: sales ───────── */

test("an online sale posts revenue, discounts, delivery, receivable and cost in the order's own transaction; COD is not cash", async () => {
  const p = await newProduct({ price: 1000000, sale: 900000, cost: 600000 });
  await coupons.saveCoupon(schemas.saveCouponInput.parse({ code: "ACCT10", type: "percent", value: 10 }), STAFF);
  const cashBefore = await net("1010");
  const id = await place(p, 2, { couponCode: "ACCT10" }, "cust-live");
  const j = (await get(`journalEntries/sale__${id}`));
  assert.match(j.number, /^JE-\d{6}$/);
  assert.deepEqual([j.status, j.sourceType, j.sourceId, j.dateKey, j.reversalOf], ["posted", "sale", id, today, null]);
  assert.equal(j.totalDebit, j.totalCredit);
  const by = (c, side) => j.lines.filter((l) => l.accountCode === c).reduce((n, l) => n + l[side], 0);
  assert.deepEqual([by("1100", "debit"), by("4020", "debit"), by("4010", "credit"), by("4040", "credit"), by("5010", "debit"), by("1200", "credit")], [1640000, 380000, 2000000, 20000, 1200000, 1200000]);
  assert.equal(j.lines.find((l) => l.accountCode === "1100").partyId, "cust-live");
  assert.equal(await net("1010"), cashBefore, "no cash from a COD sale");
  assert.equal(j.costMissing, false);
  const rows = (await db.collection("ledgerEntries").where("journalId", "==", `sale__${id}`).get()).docs;
  assert.equal(rows.length, j.lines.length);
  assert.equal((await get(`partyBalances/customer__cust-live`)).balance, 1640000, "the customer owes the sale total");
  const month = await get(`accountMonths/${today.slice(0, 7)}`);
  assert.ok(month.accounts["4010"].credit >= 2000000);
  ids.liveSale = id;
  ids.liveProduct = p;
});

test("a sale with no recorded cost still posts, without cost of goods sold, and is flagged", async () => {
  const p = await newProduct();
  const id = await place(p, 1);
  const j = await get(`journalEntries/sale__${id}`);
  assert.equal(j.totalDebit, j.totalCredit);
  assert.equal(j.lines.some((l) => l.accountCode === "5010" || l.accountCode === "1200"), false);
  assert.equal(j.costMissing, true);
});

test("a retried or simultaneous order posts exactly one journal", async () => {
  const p = await newProduct({ cost: 500000 });
  const input = draft(p, 1);
  const results = await Promise.all(Array.from({ length: 5 }, () => orders.placeOrder(input, { uid: "cust-r" })));
  const id = results[0].orderId;
  assert.equal(new Set(results.map((r) => r.orderId)).size, 1);
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", id).get()).size, 1);
  await orders.placeOrder(input, { uid: "cust-r" });
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", id).get()).size, 1);
});

/* ───────── Customer payments ───────── */

test("partial and multiple payments settle the receivable; wallet money sits in clearing, not the bank", async () => {
  const p = await newProduct({ cost: 600000 });
  const id = await place(p, 1, {}, "cust-pay"); // Rs 10,200
  const total = (await get(`sales/${id}`)).total;
  const [cash0, bank0, wallet0] = [await net("1010"), await net("1021"), await net("1030")];
  await salePay(id, 300000, "bank_transfer", "TXN-1");
  await salePay(id, 200000, "easypaisa", "EP-9");
  await salePay(id, 100000, "jazzcash", "JC-3");
  assert.equal((await net("1021")) - bank0, 300000, "bank transfer → bank");
  assert.equal((await net("1030")) - wallet0, 300000, "Easypaisa + JazzCash → clearing, not bank settlement");
  assert.equal((await get("partyBalances/customer__cust-pay")).balance, total - 600000, "the customer owes what is left");
  await advance(id, "confirmed", "processing", "dispatched");
  await payments.recordCollection({ orderId: id }, STAFF);
  assert.equal((await net("1010")) - cash0, total - 600000, "only the remainder is cash");
  assert.equal((await get("partyBalances/customer__cust-pay")).balance, 0);
  const pj = (await db.collection("journalEntries").where("sourceType", "==", "payment").get()).docs.filter((d) => d.data().lines.some((l) => l.partyId === "cust-pay"));
  assert.equal(pj.length, 4, "one journal per payment entry");
  assert.ok(pj.every((d) => d.data().totalDebit === d.data().totalCredit));
});

test("reversing a part-payment posts the opposite journal once and restores the receivable", async () => {
  const p = await newProduct({ cost: 600000 });
  const id = await place(p, 1, {}, "cust-rev");
  const total = (await get(`sales/${id}`)).total;
  const first = await salePay(id, 400000, "jazzcash", "JC-REV");
    const before = { wallet: await net("1030"), rec: (await get("partyBalances/customer__cust-rev")).balance };
  assert.equal(before.rec, total - 400000);
  await salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: first.transactionId, reason: "Wallet transfer failed" }), STAFF);
  assert.equal((await get("partyBalances/customer__cust-rev")).balance, total, "the customer owes the full amount again");
  assert.equal(before.wallet - (await net("1030")), 400000, "the clearing balance went back down");
  const rev = await get(`journalEntries/reversal__payment__${first.transactionId}`);
  assert.deepEqual([rev.reversalOf, rev.totalDebit], [`payment__${first.transactionId}`, 400000]);
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: id, transactionId: first.transactionId, reason: "Again by mistake" }), STAFF), (e) => /already reversed/.test(e.message));
  assert.equal((await db.collection("journalEntries").where("reversalOf", "==", `payment__${first.transactionId}`).get()).size, 1);
});

test("cancel, return and refund: the books go back exactly to where they were", async () => {
  const p = await newProduct({ cost: 600000 });
  const before = await allNets();
  const id = await place(p, 2, {}, "cust-cycle");
  await advance(id, "confirmed", "processing", "dispatched", "delivered");
  await payments.recordCollection({ orderId: id }, STAFF);
  await advance(id, "returned");
  assert.ok((await get(`journalEntries/reversal__sale__${id}`)), "the sale is reversed when the order is returned");
  const total = (await get(`sales/${id}`)).total;
  assert.equal((await get("partyBalances/customer__cust-cycle")).balance, -total, "the customer is owed their money back");
  await payments.recordRefund({ orderId: id, amount: total, reason: "Returned" }, STAFF);
  assert.equal((await get("partyBalances/customer__cust-cycle")).balance, 0);
  assert.deepEqual(await allNets(), before, "revenue, receivable, cash, cost and inventory all net to zero");
  const refund = (await db.collection("journalEntries").where("sourceType", "==", "refund").get()).docs.find((d) => d.data().lines.some((l) => l.partyId === "cust-cycle"));
  assert.ok(refund && refund.data().totalDebit === total);
  assert.equal((await db.collection("journalEntries").where("reversalOf", "==", `sale__${id}`).get()).size, 1, "reversed once");
});

/* ───────── Purchases ───────── */

test("goods received post inventory against payables for accepted pairs only, and match the supplier ledger", async () => {
  const p = await newProduct({ stock: 0 });
  const s = await newSupplier("Live Supplier");
  const invBefore = await net("1200");
  const { grnId, poId } = await receivedPO(s, p, 10, 100000, 6, 2); // 6 accepted, 2 rejected, 2 still to come
  const g = await get(`goodsReceipts/${grnId}`);
  assert.equal(g.value, 600000);
  const j = await get(`journalEntries/grn__${grnId}`);
  assert.deepEqual(j.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1200", 600000, 0], ["2010", 0, 600000]]);
  assert.equal((await net("1200")) - invBefore, 600000, "rejected pairs aren't inventory");
  assert.equal((await get(`partyBalances/supplier__${s}`)).balance, 600000);
  assert.equal((await get(`suppliers/${s}`)).balance, 600000, "the same as the supplier ledger");
  // Receiving the rest posts a second journal; a repeated request posts nothing more.
  const input = schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: poId, lines: [{ lineIndex: 0, acceptedQty: 2 }] });
  await Promise.all(Array.from({ length: 4 }, () => goods.receiveGoods(input, STAFF)));
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "grn").get()).docs.filter((d) => d.data().lines.some((l) => l.partyId === s)).length, 2);
  assert.equal((await get(`partyBalances/supplier__${s}`)).balance, (await get(`suppliers/${s}`)).balance);
  ids.supplier = s;
  ids.grn = grnId;
});

test("supplier payments reduce payables from cash, bank or wallet clearing; purchase returns reduce payables and inventory", async () => {
  const s = ids.supplier;
  const [cash, bank, wallet] = [await net("1010"), await net("1021"), await net("1030")];
  await pay(s, 100000, { method: "cash" });
  await pay(s, 50000, { method: "bank_transfer", reference: "BT-1" });
  await pay(s, 30000, { method: "easypaisa", reference: "EP-1" });
  assert.deepEqual([cash - (await net("1010")), bank - (await net("1021")), wallet - (await net("1030"))], [100000, 50000, 30000]);
  const inv = await net("1200");
  await purchaseReturns.createPurchaseReturn(schemas.purchaseReturnInput.parse({ idempotencyKey: key(), grnId: ids.grn, reason: "Sole separated", lines: [{ lineIndex: 0, qty: 1 }] }), STAFF);
  assert.equal(inv - (await net("1200")), 100000, "returned pairs leave inventory at the receipt's value");
  const sup = await get(`suppliers/${s}`);
  assert.equal((await get(`partyBalances/supplier__${s}`)).balance, sup.balance, "payables follow the supplier ledger through payments and returns");
  assert.equal(sup.balance, 800000 - 100000 - 50000 - 30000 - 100000);
  const input = schemas.supplierPaymentInput.parse({ idempotencyKey: key(), supplierId: s, amount: 10000, method: "cash", paidAt: today });
  await Promise.all(Array.from({ length: 4 }, () => supplierPayments.recordSupplierPayment(input, STAFF)));
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "supplierpayment").get()).docs.filter((d) => d.data().lines.some((l) => l.partyId === s)).length, 4, "the repeated payment posted once");
});

/* ───────── Manual journals ───────── */

test("manual journals: drafts can be saved unbalanced, posting checks everything, posted journals are final", async () => {
  const jr = (over = {}) => ({ idempotencyKey: key(), date: today, memo: "Owner paid in cash", lines: [{ accountCode: "1010", debit: 500000 }, { accountCode: "3010", credit: 500000 }], post: true, ...over });
  for (const t of [null, "customer", "reader", "manager", "reverser"]) assert.equal((await call("createJournal", t, jr())).status, t ? 403 : 401, `${t} can't post`);
  assert.equal((await call("createJournal", "poster", jr({ lines: [{ accountCode: "1010", debit: 500000 }, { accountCode: "3010", credit: 400000 }] }))).status, 400, "unbalanced");
  assert.equal((await call("createJournal", "poster", jr({ lines: [{ accountCode: "1010", debit: 500000 }, { accountCode: "9999", credit: 500000 }] }))).status, 400, "unknown account");
  assert.equal((await call("createJournal", "poster", jr({ lines: [{ accountCode: "1000", debit: 500000 }, { accountCode: "3010", credit: 500000 }] }))).status, 400, "a heading");
  assert.equal((await call("createJournal", "poster", jr({ lines: [{ accountCode: "1010", debit: 500000, partyType: "customer", partyId: "c1" }, { accountCode: "3010", credit: 500000 }] }))).status, 400, "a customer on a cash account");
  assert.equal((await call("createJournal", "poster", jr({ date: "2999-01-01" }))).status, 400, "future date");
  const before = (await journals()).length;
  const ok = await call("createJournal", "poster", jr({ idempotencyKey: "samekey12345" }));
  assert.equal(ok.status, 200);
  const again = await call("createJournal", "poster", jr({ idempotencyKey: "samekey12345" }));
  assert.equal(again.body.data.id, ok.body.data.id, "the same request is posted once");
  assert.equal((await journals()).length, before + 1);
  const posted = await get(`journalEntries/${ok.body.data.id}`);
  assert.deepEqual([posted.status, posted.sourceType, posted.totalDebit, posted.totalCredit], ["posted", "manual", 500000, 500000]);
  assert.equal((await call("deleteDraftJournal", "poster", { id: ok.body.data.id })).status, 400, "a posted journal can't be deleted");

  const draftRes = await call("createJournal", "poster", jr({ post: false, lines: [{ accountCode: "1010", debit: 70000 }, { accountCode: "6010", credit: 10 }] }));
  assert.equal(draftRes.status, 200);
  assert.equal(draftRes.body.data.status, "draft");
  assert.equal((await db.collection("ledgerEntries").where("journalId", "==", draftRes.body.data.id).get()).size, 0, "a draft posts nothing");
  assert.equal((await call("postDraftJournal", "poster", { id: draftRes.body.data.id, idempotencyKey: key() })).status, 400, "posting re-checks the balance");
  assert.equal((await call("deleteDraftJournal", "poster", { id: draftRes.body.data.id })).status, 200, "drafts can be deleted");
  const d2 = await call("createJournal", "poster", jr({ post: false, memo: "Utilities bill", lines: [{ accountCode: "6010", debit: 25000 }, { accountCode: "1010", credit: 25000 }] }));
  const cash = await net("1010");
  const p2 = await call("postDraftJournal", "poster", { id: d2.body.data.id, idempotencyKey: key() });
  assert.equal(p2.status, 200);
  assert.equal(cash - (await net("1010")), 25000, "cash paid out for the bill");
  assert.equal((await call("postDraftJournal", "poster", { id: d2.body.data.id, idempotencyKey: key() })).status, 400, "already posted");
  ids.manual = ok.body.data.id;
});

test("reversal: only with the reverse permission, once, never of a reversal; the original stays", async () => {
  const r = { journalId: ids.manual, reason: "Posted to the wrong account" };
  for (const t of [null, "customer", "reader", "poster", "manager"]) assert.equal((await call("reverseJournal", t, r)).status, t ? 403 : 401, `${t}`);
  const original = JSON.stringify(await get(`journalEntries/${ids.manual}`));
  const cash = await net("1010");
  const res = await call("reverseJournal", "reverser", r);
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(await get(`journalEntries/${ids.manual}`)), original, "the posted journal is untouched");
  assert.equal(cash - (await net("1010")), 500000);
  const rev = await get(`journalEntries/reversal__${ids.manual}`);
  assert.deepEqual([rev.reversalOf, rev.sourceType, rev.totalDebit], [ids.manual, "reversal", 500000]);
  assert.equal((await call("reverseJournal", "reverser", r)).status, 400, "only once");
  assert.equal((await call("reverseJournal", "reverser", { journalId: `reversal__${ids.manual}`, reason: "Undo the undo" })).status, 400, "a reversal can't be reversed");
  assert.equal((await call("reverseJournal", "reverser", { journalId: "nope", reason: "Not there" })).status, 404);
});

/* ───────── Failed postings ───────── */

test("if an account is switched off the order still goes through, the failed posting is recorded, and it can be retried", async () => {
  const p = await newProduct({ cost: 600000 });
  await db.doc("accountingConfig/main").update({ "accounts.4040.active": false }); // delivery income switched off
  const stockBefore = (await get(`inventory/${p.productId}__${p.variantId}`)).onHand;
  const id = await place(p, 1);
  assert.equal((await get(`inventory/${p.productId}__${p.variantId}`)).onHand, stockBefore - 1, "the order and its stock went through");
  assert.equal((await db.doc(`journalEntries/sale__${id}`).get()).exists, false, "no half-posted journal");
  const ex = await get(`accountingExceptions/sale__${id}`);
  assert.equal(ex.status, "failed");
  assert.match(ex.reason, /4040/);
  assert.ok(JSON.parse(ex.spec).lines.length > 0, "everything needed to retry is kept");
  await assert.rejects(accounting.retryException({ id: `sale__${id}` }, STAFF), (e) => /Still can't post/.test(e.message));
  await db.doc("accountingConfig/main").update({ "accounts.4040.active": true });
  const r = await accounting.retryException({ id: `sale__${id}` }, STAFF);
  assert.equal(r.status, "posted");
  assert.equal((await get(`accountingExceptions/sale__${id}`)).status, "resolved");
  const j = await get(`journalEntries/sale__${id}`);
  assert.equal(j.totalDebit, j.totalCredit);
  assert.equal((await accounting.retryException({ id: `sale__${id}` }, STAFF).catch((e) => e)).code, "not-found", "a resolved posting can't be posted twice");
});

/* ───────── Opening balances ───────── */

test("opening balances: previewed first, balanced, assets/liabilities/equity only, identifiable, once; nothing else changes", async () => {
  const lines = [{ accountCode: "1010", debit: 1500000 }, { accountCode: "1021", debit: 3000000 }, { accountCode: "3010", credit: 4000000 }];
  for (const t of [null, "customer", "reader", "poster", "reverser"]) assert.equal((await call("previewOpeningBalances", t, { date: "2026-01-01", lines })).status, t ? 403 : 401, `${t}`);
  const prev = await call("previewOpeningBalances", "manager", { date: "2026-01-01", lines });
  assert.equal(prev.status, 200);
  assert.deepEqual([prev.body.data.valid, prev.body.data.difference, prev.body.data.totalDebit, prev.body.data.totalCredit], [false, 500000, 4500000, 4000000]);
  const post = (l, k = key()) => call("postOpeningBalances", "manager", { idempotencyKey: k, date: "2026-01-01", lines: l });
  assert.equal((await post(lines)).status, 400, "unbalanced opening balances are refused");
  assert.equal((await post([{ accountCode: "1010", debit: 100 }, { accountCode: "4010", credit: 100 }])).status, 400, "revenue isn't an opening balance");
  const supplierBefore = JSON.stringify(await get(`suppliers/${ids.supplier}`));
  const salesBefore = (await db.collection("sales").get()).size;
  const good = [...lines.slice(0, 2), { accountCode: "3010", credit: 4500000 }];
  assert.equal((await call("previewOpeningBalances", "manager", { date: "2026-01-01", lines: good })).body.data.valid, true);
  const done = await post(good, "opening-one-12345");
  assert.equal(done.status, 200);
  const j = await get(`journalEntries/${done.body.data.id}`);
  assert.deepEqual([j.sourceType, j.status, j.dateKey, j.totalDebit], ["opening", "posted", "2026-01-01", 4500000], "identifiable and dated");
  assert.equal((await post(good, "opening-two-12345")).status, 400, "a second set is refused while the first stands");
  assert.equal((await post(good, "opening-one-12345")).body.data.existing, true, "the same request is idempotent");
  assert.equal(JSON.stringify(await get(`suppliers/${ids.supplier}`)), supplierBefore, "supplier balances unchanged");
  assert.equal((await db.collection("sales").get()).size, salesBefore);
  await call("reverseJournal", "reverser", { journalId: done.body.data.id, reason: "Counted again" });
  assert.equal((await post(good, "opening-three-1234")).status, 200, "after a reversal it can be redone");
});

/* ───────── Reports ───────── */

test("trial balance: opening, debit, credit and closing per account; totals balance and agree with the ledger rows", async () => {
  const tb = await reports.trialBalance({ from: "2000-01-01", to: today });
  assert.equal(tb.balanced, true);
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.equal(tb.totals.closingNet, 0);
  assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
  const rows = (await db.collection("ledgerEntries").get()).docs.map((d) => d.data());
  for (const r of tb.rows) {
    assert.equal(r.debit, rows.filter((x) => x.accountCode === r.code).reduce((n, x) => n + x.debit, 0), `${r.code} debit`);
    assert.equal(r.credit, rows.filter((x) => x.accountCode === r.code).reduce((n, x) => n + x.credit, 0), `${r.code} credit`);
    assert.equal(r.closingNet, r.openingNet + r.debit - r.credit);
  }
  // A period: opening is everything before it.
  const later = await reports.trialBalance({ from: today, to: today });
  const opening = later.rows.reduce((n, r) => n + Math.abs(r.openingNet), 0);
  assert.ok(opening > 0, "the opening balances and earlier journals are carried in as the opening column");
  assert.equal(later.balanced, true);
  const early = await reports.trialBalance({ from: "2000-01-01", to: "2025-12-31" });
  assert.equal(early.rows.length, 0, "nothing before the first journal");
});

test("profit and loss and balance sheet are derived from the posted journals and balance", async () => {
  const pl = await reports.profitAndLoss({ from: "2020-01-01", to: today });
  const rows = (await db.collection("ledgerEntries").get()).docs.map((d) => d.data());
  const sum = (c, f) => rows.filter((r) => r.accountCode === c).reduce((n, r) => n + f(r), 0);
  const revenue = sum("4010", (r) => r.credit - r.debit) + sum("4040", (r) => r.credit - r.debit) - sum("4020", (r) => r.debit - r.credit) - sum("4030", (r) => r.debit - r.credit);
  assert.equal(pl.netRevenue, revenue);
  assert.equal(pl.costOfSalesTotal, sum("5010", (r) => r.debit - r.credit));
  assert.equal(pl.grossProfit, pl.netRevenue - pl.costOfSalesTotal);
  assert.equal(pl.operatingExpensesTotal, sum("6010", (r) => r.debit - r.credit) + sum("6020", (r) => r.debit - r.credit));
  assert.equal(pl.netProfit, pl.grossProfit - pl.operatingExpensesTotal);
  assert.ok(pl.incomplete.salesWithoutCost >= 2, "sales without a cost are counted and labelled");
  assert.match(pl.incomplete.note, /no recorded cost/);

  const bs = await reports.balanceSheet({ asOf: today });
  assert.equal(bs.balanced, true, "assets = liabilities + equity + current earnings");
  assert.equal(bs.totals.currentEarnings, pl.netProfit, "current earnings are the profit");
  assert.equal(bs.totals.assets, bs.totals.liabilitiesAndEquity);
  const empty = await reports.profitAndLoss({ from: "2001-01-01", to: "2001-01-31" });
  assert.deepEqual([empty.netRevenue, empty.grossProfit, empty.netProfit], [0, 0, 0], "no invented figures for an empty period");
  const bsEmpty = await reports.balanceSheet({ asOf: "2001-01-31" });
  assert.deepEqual([bsEmpty.totals.assets, bsEmpty.totals.liabilities, bsEmpty.totals.equity], [0, 0, 0]);
});

test("general ledger is paged with a running balance that ends at the closing balance; cash flow adds up; the overview shows real figures", async () => {
  const closing = (await reports.trialBalance({ from: "2000-01-01", to: today })).rows.find((r) => r.code === "1010").closingNet;
  let after = null;
  let all = [];
  let first;
  for (let i = 0; i < 50; i++) {
    const page = await reports.generalLedger({ accountCode: "1010", from: "2000-01-01", to: today, after }, { pageSize: 3 });
    first ??= page;
    all = all.concat(page.rows);
    after = page.next;
    if (!after) {
      assert.equal(page.closing, closing, "the last page reports the closing balance");
      break;
    }
  }
  assert.ok(all.length > 3, "several pages");
  assert.equal(first.opening, 0);
  assert.equal(all.at(-1).running, closing, "the running balance ends at the closing balance");
  assert.equal(all.reduce((n, r) => n + r.debit - r.credit, 0), closing);
  const cf = await reports.cashFlow({ from: "2000-01-01", to: today });
  assert.equal(cf.consistent, true);
  assert.equal(cf.closingTotal, cf.openingTotal + cf.netChange);
  assert.ok(cf.bySource.supplierpayment.out > 0 && cf.bySource.payment.in > 0);
  const ov = await reports.overview();
  const tb = await reports.trialBalance({ from: "2000-01-01", to: today });
  const by = (c) => tb.rows.find((r) => r.code === c)?.closingNet ?? 0;
  assert.equal(ov.receivables, by("1100") + by("1110"));
  assert.equal(ov.payables, -by("2010"));
  assert.equal(ov.cashTotal, by("1010") + by("1021") + by("1030") + by("1022"));
  assert.equal(ov.totalRevenue, -by("4010") - by("4040") - by("4020") - by("4030"), "credits less the discount and returns accounts");
  assert.equal(ov.incomplete.salesWithoutCost, (await db.collection("journalEntries").where("sourceType", "==", "sale").where("costMissing", "==", true).get()).size);
  assert.equal(ov.incomplete.failedPostings, 0);
  const ar = await reports.partyList({ partyType: "customer" });
  assert.equal(ar.control, ov.receivables);
  assert.equal(ar.rows.reduce((n, r) => n + r.balance, 0) >= 0, true);
  const ap = await reports.partyList({ partyType: "supplier" });
  assert.equal(ap.control, ov.payables);
});

/* ───────── Access ───────── */

test("accounting reports and ledgers need accounting.read; nothing is open to customers, signed-out visitors or unrelated staff", async () => {
  const range = { from: "2020-01-01", to: today };
  const year = { from: pktDateKey(new Date(Date.now() - 300 * 86400000)), to: today };
  for (const [name, data] of [["accountingOverview", {}], ["trialBalance", range], ["profitAndLoss", year], ["balanceSheet", { asOf: today }], ["cashFlow", year], ["generalLedger", { accountCode: "1010", ...range }], ["partyBalances", { partyType: "customer" }], ["reconcile", { stage: "sales" }]]) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "orders", data)).status, 403, `${name} staff with other permissions`);
    assert.equal((await call(name, "reader", data)).status, 200, `${name} reader`);
  }
  assert.equal((await call("saveAccount", "reader", { code: "7000", name: "Nope", type: "expense" })).status, 403);
  assert.equal((await call("saveAccount", "poster", { code: "7000", name: "Nope", type: "expense" })).status, 403, "posting isn't managing");
  assert.equal((await call("setAccountRole", "reader", { role: "bank", code: "1021" })).status, 403);
  assert.equal((await call("deleteAccount", "poster", { code: "1090" })).status, 403);
  assert.equal((await call("saveAccount", "manager", { code: "7000", name: "Bank charges", type: "expense", parentCode: "6000" })).status, 200);
  assert.equal((await call("saveAccount", "manager", { code: "7001", name: "Bad", type: "expense", parentCode: "1000" })).status, 400);
  assert.equal((await call("retryPosting", "reader", { id: "x" })).status, 403);
  assert.equal((await call("generalLedger", "reader", { accountCode: "1010", from: "2026-02-01", to: "2026-01-01" })).status, 400, "backwards range");
});

/* ───────── Reconciliation ───────── */

async function reconcileAll() {
  const out = [];
  for (const stage of ["journals", "sales", "grn", "supplierPayments", "purchaseReturns", "customerPayments", "suppliers"]) {
    let cursor = null;
    do {
      const r = await reports.reconcileStage({ stage, cursor });
      out.push(...r.issues);
      cursor = r.nextCursor;
    } while (cursor);
  }
  return out;
}

test("reconciliation finds missing, unbalanced and inconsistent records and repairs nothing", async () => {
  const clean = (await reconcileAll()).filter((i) => i.severity === "error");
  assert.deepEqual(clean, [], "every sale, receipt, payment and return has a balanced journal");
  const info = (await reconcileAll()).filter((i) => i.severity !== "error");
  assert.ok(info.every((i) => i.type === "supplier_balance_mismatch" || i.severity === "info"), "only expected notes: opening balances and pre-accounting events");

  const p = await newProduct({ cost: 600000 });
  const id = await place(p, 1);
  const g = await receivedPO(await newSupplier("Recon Supplier"), p, 4, 100000, 4);
  // Tamper directly with the database, the way a bug or an outside edit would.
  await db.doc(`journalEntries/sale__${id}`).delete();
  await db.doc(`journalEntries/grn__${g.grnId}`).update({ totalDebit: 1 });
  const victim = (await journals()).find((j) => j.sourceType === "supplierpayment");
  await db.doc(`ledgerEntries/${victim.id}_0`).delete();
  const found = await reconcileAll();
  const types = (t) => found.filter((i) => i.type === t);
  assert.equal(types("sale_without_journal").some((i) => i.sourceId === id && i.severity === "error"), true, "a missing journal");
  assert.equal(types("grn_amount_mismatch").some((i) => i.sourceId === g.grnId), true, "a journal that disagrees with its source");
  assert.equal(types("journal_unbalanced").some((i) => i.sourceId === `grn__${g.grnId}`), true, "an unbalanced journal");
  assert.equal(types("ledger_missing").some((i) => i.sourceId === victim.sourceId || i.sourceId === victim.id), true, "a missing ledger row");
  assert.equal((await db.doc(`journalEntries/sale__${id}`).get()).exists, false, "nothing was silently repaired");
  assert.equal((await get(`journalEntries/grn__${g.grnId}`)).totalDebit, 1);
});
