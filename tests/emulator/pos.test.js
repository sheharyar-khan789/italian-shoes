/**
 * The physical-store POS against the emulators (`npm run test:emulator`). All data is created inside a throwaway
 * "demo-" database for these tests; no real store data or accounts are involved. Tests share state, in order.
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
const accounting = await import("../../functions/services/accounting.js");
const pos = await import("../../functions/services/pos.js");
const salePayments = await import("../../functions/services/salePayments.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;
const key = () => randomUUID().replace(/-/g, "");

const ALL = ["pos.access", "pos.sell", "pos.register", "pos.cash", "pos.override", "pos.sessions.read", "pos.reports"];
const TOKENS = {
  cashier: { uid: "cash-1", name: "Cashier One", staff: true, perms: POS_ROLES.cashier.permissions, auth_time: 9999999999 },
  cashier2: { uid: "cash-2", name: "Cashier Two", staff: true, perms: POS_ROLES.cashier.permissions, auth_time: 9999999999 },
  manager: { uid: "mgr-1", name: "Manager", staff: true, perms: POS_ROLES.pos_manager.permissions, auth_time: 9999999999 },
  owner: { uid: "own-1", name: "Owner", staff: true, perms: [...ALL, "staff.manage"], auth_time: 9999999999 },
  plain: { uid: "plain-1", staff: true, perms: ["orders.read", "sales.read"], auth_time: 9999999999 },
  customer: { uid: "cust-x" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });
const ok = async (name, token, data) => {
  const r = await call(name, token, data);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

const get = async (path) => (await db.doc(path).get()).data();
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const stockIn = async (p, wid) => (await get(`inventory/${p.productId}__${p.variantId}`)).byWarehouse?.[wid]?.onHand ?? 0;
const movements = async (p) => (await db.collection("stockMovements").where("inventoryId", "==", `${p.productId}__${p.variantId}`).get()).docs.map((d) => d.data());

async function newProduct({ shop = 10, main = 0, price = 1000000, sale = null, cost = 600000, status = "published" } = {}) {
  seq += 1;
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: `POS Item ${seq}`, slug: `pos-item-${seq}`, categoryId: ids.cat, sku: `PS-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: sale, ...(cost ? { costPrice: cost } : {}) }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  if (shop) await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: shop, reason: "initial", note: "" }, STAFF);
  if (main) await inventory.adjustStock({ productId, variantId, warehouseId: "main", change: main, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status, images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId, variantId };
}
const cart = (p, qty = 1, extra = {}) => ({ productId: p.productId, variantId: p.variantId, qty, ...extra });
const cash = (amount, over = {}) => ({ method: "cash", amount, ...over });

let regSeq = 0;
/** Open a register for a cashier (closing any left open from a previous test). */
async function openFor(token, { warehouseId = ids.shop, openingFloat = 500000 } = {}) {
  const uid = TOKENS[token].uid;
  const lock = await get(`registerLocks/${uid}`);
  if (lock) await ok("closeRegister", token, { sessionId: lock.sessionId, countedCash: (await get(`registerSessions/${lock.sessionId}`)).openingFloat });
  regSeq += 1;
  return (await ok("openRegister", token, { idempotencyKey: `open-${regSeq}-${key()}`, warehouseId, openingFloat })).sessionId;
}
const checkout = (token, sessionId, items, tenders, over = {}) => call("posCheckout", token, { idempotencyKey: key(), sessionId, items, tenders, ...over });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-x") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", phone: "0300 1112223", address: "Main Road", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyLowStock: true });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  ids.off = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Old store", code: "OLD" }), STAFF)).id;
  await warehouses.setWarehouseActive({ id: ids.off, isActive: false }, STAFF);
  await accounting.initializeAccounting(STAFF);
});

/* ───────── Access ───────── */

test("every POS endpoint needs its own permission; a cashier can't grant themselves anything or touch cash, prices or reports", async () => {
  const range = { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() };
  const calls = [["posContext", {}, "pos.access"], ["posSearch", { q: "x", warehouseId: "main" }, "pos.access"], ["posCustomerLookup", { q: "0300 1234567" }, "pos.sell"], ["openRegister", { idempotencyKey: key(), warehouseId: "main", openingFloat: 0 }, "pos.register"], ["registerCash", { idempotencyKey: key(), sessionId: "s", type: "cash_in", reason: "owner_capital", amount: 100, note: "Capital in" }, "pos.cash"], ["posReport", range, "pos.reports"], ["createPosRoles", {}, "staff.manage"]];
  for (const [name, data] of calls) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "plain", data)).status, 403, `${name} staff without POS permissions`);
  }
  for (const [name, data] of calls.slice(5)) assert.equal((await call(name, "cashier", data)).status, 403, `${name} cashier`);
  assert.equal((await call("registerCash", "cashier", calls[4][1])).status, 403, "a cashier can't move cash");
  assert.equal((await call("createPosRoles", "manager", {})).status, 403, "a manager can't create roles either");
  assert.equal((await call("posContext", "cashier", {})).status, 200);
  assert.equal((await call("posReport", "manager", range)).status, 200);
});

test("the owner creates the Cashier and POS Manager roles once; they hold only the intended permissions and nothing is overwritten", async () => {
  const first = await ok("createPosRoles", "owner", {});
  assert.deepEqual(first.created.sort(), ["cashier", "pos_manager"]);
  assert.deepEqual((await get("roles/cashier")).permissions, ["pos.access", "pos.sell", "pos.register"]);
  assert.ok(!(await get("roles/cashier")).permissions.some((p) => /staff|override|cash$|reports|sessions/.test(p)), "a cashier can't change prices, move cash or see reports");
  assert.ok((await get("roles/pos_manager")).permissions.includes("pos.override"));
  await db.doc("roles/cashier").update({ name: "Renamed by owner" });
  assert.deepEqual((await ok("createPosRoles", "owner", {})).created, [], "existing roles are left alone");
  assert.equal((await get("roles/cashier")).name, "Renamed by owner");
});

/* ───────── Registers ───────── */

test("opening a register: a warehouse that is on, an opening float, one register per cashier, and a record of who and when", async () => {
  assert.equal((await call("openRegister", "cashier", { idempotencyKey: key(), warehouseId: ids.off, openingFloat: 0 })).status, 400, "a switched-off warehouse");
  assert.equal((await call("openRegister", "cashier", { idempotencyKey: key(), warehouseId: "ghost", openingFloat: 0 })).status, 400);
  assert.equal((await call("openRegister", "cashier", { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: -5 })).status, 400);
  const k = key();
  const a = await ok("openRegister", "cashier", { idempotencyKey: k, warehouseId: ids.shop, openingFloat: 500000, note: "Morning" });
  assert.equal((await ok("openRegister", "cashier", { idempotencyKey: k, warehouseId: ids.shop, openingFloat: 500000 })).sessionId, a.sessionId, "the same request opens one register");
  const s = await get(`registerSessions/${a.sessionId}`);
  assert.deepEqual([s.status, s.warehouseId, s.cashierUid, s.cashierName, s.openingFloat, s.number], ["open", ids.shop, "cash-1", "Cashier One", 500000, "RS-000001"]);
  assert.ok(s.openedAt);
  assert.equal((await call("openRegister", "cashier", { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).status, 400, "a second register for the same cashier");
  const ctx = await ok("posContext", "cashier", {});
  assert.equal(ctx.session.id, a.sessionId);
  assert.equal(ctx.session.expectedCash, 500000);
  assert.ok(ctx.warehouses.some((w) => w.id === ids.shop) && !ctx.warehouses.some((w) => w.id === ids.off), "only warehouses that are on");
  assert.equal(ctx.store.storeName, "Test Store");
  const move = (await db.collection("registerMovements").where("sessionId", "==", a.sessionId).get()).docs.map((d) => d.data());
  assert.deepEqual([move.length, move[0].type, move[0].amount, move[0].staffUid], [1, "opening", 500000, "cash-1"]);
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "registermove").get()).size, 0, "the float is a move inside Cash in Hand: no journal");
  ids.reg1 = a.sessionId;
});

test("no sale without an open register of your own", async () => {
  const p = await newProduct();
  assert.equal((await checkout("cashier", "nope", [cart(p)], [cash(1000000)])).status, 400);
  assert.equal((await checkout("cashier2", ids.reg1, [cart(p)], [cash(1000000)])).status, 403, "someone else's register");
  assert.equal((await db.collection("sales").where("channel", "==", "pos").get()).size, 0);
});

/* ───────── Checkout ───────── */

test("a cash sale: one central sale, stock from the register's warehouse once, the payment counted in the register, journals posted", async () => {
  const p = await newProduct({ shop: 10, main: 7, sale: 900000, cost: 600000 });
  const cashBefore = await net("1010");
  const r = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg1, items: [cart(p, 2)], tenders: [cash(1800000, { cashReceived: 2000000 })], note: "Walk-in" });
  assert.match(r.number, /^SL-\d{6}$/);
  assert.deepEqual([r.total, r.paidTotal, r.amountDue, r.paymentStatus, r.change, r.failedPayment], [1800000, 1800000, 0, "collected", 200000, null]);
  const s = await get(`sales/${r.saleId}`);
  assert.deepEqual([s.channel, s.orderId, s.status, s.warehouseId, s.sessionId, s.cashierUid, s.cashierName, s.customerId], ["pos", null, "completed", ids.shop, ids.reg1, "cash-1", "Cashier One", null]);
  assert.deepEqual([s.grossSales, s.itemDiscountTotal, s.subtotal, s.discountTotal, s.netSales, s.shippingTotal, s.total], [2000000, 200000, 1800000, 0, 1800000, 0, 1800000], "the sale price, taken from the database");
  assert.deepEqual([s.lines[0].productName, s.lines[0].colorName, s.lines[0].sizeLabel, s.lines[0].sku, s.lines[0].allocations], [`POS Item ${seq}`, "Black", "EU 42", `PS-${seq}-BLACK-42`, [{ warehouseId: ids.shop, qty: 2 }]]);
  const c = await get(`saleCosts/${r.saleId}`);
  assert.deepEqual([c.costComplete, c.costTotal, c.grossProfit], [true, 1200000, 600000]);
  assert.equal(await stockIn(p, ids.shop), 8, "taken from the shop warehouse");
  assert.equal(await stockIn(p, "main"), 7, "the other warehouse is untouched");
  const mv = (await movements(p)).filter((m) => m.sourceType === "pos_sale");
  assert.deepEqual([mv.length, mv[0].sourceId, mv[0].warehouseId, mv[0].change, mv[0].reason], [1, r.saleId, ids.shop, -2, "sale"]);
  const pay = await get(`payments/${r.saleId}`);
  assert.deepEqual([pay.status, pay.paidTotal, pay.source], ["collected", 1800000, "pos"]);
  const txs = (await db.collection(`payments/${r.saleId}/transactions`).get()).docs.map((d) => d.data());
  assert.deepEqual([txs.length, txs[0].method, txs[0].amount, txs[0].sessionId, txs[0].recordedOnly], [1, "cash", 1800000, ids.reg1, true]);
  const reg = await get(`registerSessions/${ids.reg1}`);
  assert.deepEqual([reg.saleCount, reg.salesTotal, reg.totals.cash], [1, 1800000, 1800000]);
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", r.saleId).get()).size, 1, "one sale journal");
  assert.equal((await net("1010")) - cashBefore, 1800000, "cash account, exactly the cash taken");
  assert.equal(await net("1110"), 0, "the receivable raised by the sale is cleared by the payment");
  ids.sale1 = r.saleId;
  ids.p1 = p;
});

test("stock is checked on the server per warehouse and variant; nothing goes negative; prices come from the database", async () => {
  const p = await newProduct({ shop: 2, main: 50 });
  const r = await checkout("cashier", ids.reg1, [cart(p, 3)], [cash(3000000)]);
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Only 2 of POS Item \d+ \(Black \/ EU 42\) in Shop floor/, "main has 50 but this register sells from the shop");
  assert.equal(await stockIn(p, ids.shop), 2, "a refused sale changes nothing");
  const none = await newProduct({ shop: 0, main: 5 });
  assert.match((await checkout("cashier", ids.reg1, [cart(none)], [cash(1)])).body.error.message, /not in stock in Shop floor/);
  assert.equal((await checkout("cashier", ids.reg1, [{ productId: p.productId, variantId: "nope_nope", qty: 1 }], [cash(1)])).status, 400, "an unknown variant");
  const arch = await newProduct({ status: "archived" });
  assert.equal((await checkout("cashier", ids.reg1, [cart(arch)], [cash(1000000)])).status, 400, "an archived product can't be sold");
  // The browser can't set a price or a total: extra fields are ignored and the price is the database's.
  const r2 = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg1, items: [{ ...cart(p, 1), price: 1, lineTotal: 1 }], total: 1, subtotal: 1, tenders: [cash(1000000)] });
  assert.equal(r2.total, 1000000);
  assert.equal(await stockIn(p, ids.shop), 1);
});

test("discounts and price changes need the override permission, a reason, and leave an audit trail; a price can only be lowered", async () => {
  const p = await newProduct({ shop: 10, price: 1000000 });
  const base = { sessionId: ids.reg1, tenders: [cash(900000)] };
  const withDiscount = { ...base, discount: { type: "amount", value: 100000, reason: "Loyal customer" }, items: [cart(p)] };
  const denied = await call("posCheckout", "cashier", { idempotencyKey: key(), ...withDiscount });
  assert.equal(denied.status, 403, "a cashier can't give a discount");
  assert.equal((await call("posCheckout", "cashier", { idempotencyKey: key(), ...base, items: [cart(p, 1, { unitPrice: 800000, overrideReason: "x" })] })).status, 403, "or lower a price");
  assert.equal(await stockIn(p, ids.shop), 10);
  const mgrReg = await openFor("manager");
  const r = await ok("posCheckout", "manager", { idempotencyKey: key(), sessionId: mgrReg, items: [cart(p)], discount: { type: "amount", value: 100000, reason: "Loyal customer" }, tenders: [cash(900000)] });
  const s = await get(`sales/${r.saleId}`);
  assert.deepEqual([s.subtotal, s.discountTotal, s.netSales, s.total, s.lines[0].couponShare], [1000000, 100000, 900000, 900000, 100000]);
  const j = await get(`journalEntries/sale__${r.saleId}`);
  assert.equal(j.lines.find((l) => l.accountCode === "4020").debit, 100000, "the discount is posted to Sales Discounts");
  const pct = await ok("posCheckout", "manager", { idempotencyKey: key(), sessionId: mgrReg, items: [cart(p, 2)], discount: { type: "percent", value: 10, reason: "Staff price" }, tenders: [cash(1800000)] });
  assert.equal(pct.total, 1800000);
  const low = await ok("posCheckout", "manager", { idempotencyKey: key(), sessionId: mgrReg, items: [cart(p, 1, { unitPrice: 750000, overrideReason: "Scuffed display pair" })], tenders: [cash(750000)] });
  const ls = await get(`sales/${low.saleId}`);
  assert.deepEqual([ls.lines[0].unitPrice, ls.lines[0].regularPrice, ls.lines[0].itemDiscount, ls.total], [750000, 1000000, 250000, 750000]);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data());
  assert.ok(audit.some((a) => a.action === "pos.discount" && a.entityId === r.saleId && a.changes.reason === "Loyal customer" && a.actorUid === "mgr-1"));
  assert.ok(audit.some((a) => a.action === "pos.price_override" && a.entityId === low.saleId && a.changes.reason === "Scuffed display pair"));
  const bad = (items, extra = {}) => call("posCheckout", "manager", { idempotencyKey: key(), sessionId: mgrReg, items, tenders: [cash(100)], ...extra });
  assert.equal((await bad([cart(p, 1, { unitPrice: 1200000, overrideReason: "Up!" })])).status, 400, "never raised above the list price");
  assert.equal((await bad([cart(p, 1, { unitPrice: 900000 })])).status, 400, "a changed price needs a reason");
  assert.equal((await bad([cart(p)], { discount: { type: "amount", value: 99999999, reason: "Too much" } })).status, 400, "more than the sale");
  assert.equal((await bad([cart(p)], { discount: { type: "percent", value: 150, reason: "Silly" } })).status, 400);
  assert.equal((await bad([cart(p)], { discount: { type: "amount", value: 100, reason: "" } })).status, 400, "a discount needs a reason");
});

test("two cashiers racing for the last pairs can't oversell", async () => {
  const p = await newProduct({ shop: 5 });
  const r2 = await openFor("cashier2");
  const regs = [ids.reg1, r2];
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => checkout(i % 2 ? "cashier2" : "cashier", regs[i % 2], [cart(p, 1)], [cash(1000000)])));
  const sold = attempts.filter((a) => a.status === 200).length;
  assert.ok(sold >= 1 && sold <= 5, `sold ${sold}`);
  assert.equal(await stockIn(p, ids.shop), 5 - sold, "stock is exactly what was not sold, never negative");
  assert.equal((await movements(p)).filter((m) => m.sourceType === "pos_sale").length, sold);
  assert.equal((await db.collection("sales").where("lines", "!=", null).get()).docs.filter((d) => d.data().lines[0].productId === p.productId).length, sold, "one sale per success");
  assert.ok(attempts.filter((a) => a.status !== 200).every((a) => a.status === 400 || a.status === 409 || a.status >= 500), "the rest are refused, not oversold");
});

test("the same checkout sent several times (even at once) makes one sale, one stock deduction, one payment and one journal", async () => {
  const p = await newProduct({ shop: 10 });
  const input = { idempotencyKey: key(), sessionId: ids.reg1, items: [cart(p, 2)], tenders: [cash(2000000)] };
  const results = await Promise.all(Array.from({ length: 5 }, () => call("posCheckout", "cashier", input)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.body.data.saleId)).size, 1);
  const id = results[0].body.data.saleId;
  assert.equal(await stockIn(p, ids.shop), 8);
  assert.equal((await db.collection(`payments/${id}/transactions`).get()).size, 1, "one payment record");
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", id).get()).size, 1, "one sale journal");
  const number = (await get(`sales/${id}`)).number;
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "payment").get()).docs.filter((d) => d.data().memo.includes(number)).length, 1, "one payment journal");
  const again = await ok("posCheckout", "cashier", input);
  assert.equal(again.saleId, id);
  assert.equal((await get(`sales/${id}`)).paidTotal, 2000000, "a later retry doesn't take the money twice");
  assert.equal(await stockIn(p, ids.shop), 8);
});

/* ───────── Payments ───────── */

test("split payments: cash, bank and wallet each land in their own account; wallet money is clearing, not bank", async () => {
  const p = await newProduct({ shop: 10 });
  const [cash0, bank0, wallet0] = [await net("1010"), await net("1021"), await net("1030")];
  const r = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg1, items: [cart(p, 2)], tenders: [cash(500000), { method: "bank_transfer", amount: 700000, reference: "TXN-8890" }, { method: "easypaisa", amount: 400000, reference: "EP-3321" }, { method: "jazzcash", amount: 400000, reference: "JC-1100" }] });
  assert.deepEqual([r.total, r.paidTotal, r.amountDue, r.paymentStatus], [2000000, 2000000, 0, "collected"]);
  assert.equal((await net("1010")) - cash0, 500000, "cash → the cash account");
  assert.equal((await net("1021")) - bank0, 700000, "bank transfer → the bank account");
  assert.equal((await net("1030")) - wallet0, 800000, "Easypaisa + JazzCash → clearing, never the bank");
  const s = await get(`sales/${r.saleId}`);
  assert.deepEqual(s.pos.tenders.map((t) => [t.method, t.amount]), [["cash", 500000], ["bank_transfer", 700000], ["easypaisa", 400000], ["jazzcash", 400000]]);
  const reg = await get(`registerSessions/${ids.reg1}`);
  assert.ok(reg.totals.bank_transfer >= 700000 && reg.totals.easypaisa >= 400000 && reg.totals.jazzcash >= 400000, "every method is totalled in the register");
  const txs = (await db.collection(`payments/${r.saleId}/transactions`).get()).docs.map((d) => d.data());
  assert.ok(txs.every((t) => t.recordedOnly === true), "recorded, never described as verified");
  assert.deepEqual(txs.map((t) => t.reference).sort(), ["", "EP-3321", "JC-1100", "TXN-8890"].sort());
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "payment").get()).docs.filter((d) => d.data().memo.includes(s.number)).length, 4, "one journal per payment");
});

test("payments are validated: references, overpayment, and a part-paid sale needs a registered customer", async () => {
  const p = await newProduct({ shop: 10 });
  const bad = (tenders, over = {}) => call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg1, items: [cart(p)], tenders, ...over });
  assert.equal((await bad([{ method: "bank_transfer", amount: 1000000 }])).status, 400, "a bank payment needs its reference");
  assert.equal((await bad([{ method: "jazzcash", amount: 1000000, reference: "x" }])).status, 400);
  assert.equal((await bad([{ method: "card", amount: 1000000 }])).status, 400, "unknown method");
  assert.equal((await bad([cash(1000001)])).status, 400, "more than the total");
  assert.equal((await bad([cash(600000), cash(600000)])).status, 400, "split payments add up to more than the total");
  assert.equal((await bad([cash(300000)])).status, 400, "a part payment for a walk-in");
  assert.equal((await bad([cash(1000000, { cashReceived: 500000 })])).status, 400, "cash received can't be less than the amount");
  assert.equal(await stockIn(p, ids.shop), 10, "nothing was sold");
  const cust = "cust-acct-1";
  await db.doc(`users/${cust}`).set({ name: "Ayesha Khan", email: "ayesha@example.com", phone: "+92 300 1234567" });
  const part = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg1, items: [cart(p)], customerId: cust, tenders: [cash(400000)] });
  assert.deepEqual([part.paidTotal, part.amountDue, part.paymentStatus], [400000, 600000, "partially_paid"]);
  const s = await get(`sales/${part.saleId}`);
  assert.deepEqual([s.customerId, s.customer.name, s.customer.phone], [cust, "Ayesha Khan", "+92 300 1234567"]);
  assert.equal((await get(`partyBalances/customer__${cust}`)).balance, 600000, "the customer owes the balance (accounts receivable)");
  const pk = key();
  const input = { idempotencyKey: pk, saleId: part.saleId, sessionId: ids.reg1, tender: { method: "bank_transfer", amount: 600000, reference: "BAL-1", } };
  const settled = await ok("posRecordPayment", "cashier", input);
  assert.deepEqual([settled.status, settled.amountDue], ["collected", 0]);
  await ok("posRecordPayment", "cashier", input);
  assert.equal((await get(`sales/${part.saleId}`)).paidTotal, 1000000, "the same payment sent again is recorded once");
  assert.equal((await call("posRecordPayment", "cashier", { ...input, idempotencyKey: key() })).status, 400, "nothing is due any more");
  assert.equal((await get(`partyBalances/customer__${cust}`)).balance, 0);
  assert.equal((await call("posRecordPayment", "cashier", { idempotencyKey: key(), saleId: ids.sale1, sessionId: "nope", tender: { method: "cash", amount: 1 } })).status, 400, "an unknown register");
  ids.customer = cust;
});

/* ───────── Cash in and out, closing ───────── */

test("cash in and out: permission, a reason, who did it, never more than is in the register, posted to the existing accounts", async () => {
  const mgr = await openFor("manager", { openingFloat: 100000 });
  const mv = (token, over = {}) => call("registerCash", token, { idempotencyKey: key(), sessionId: mgr, type: "cash_in", reason: "owner_capital", amount: 50000, note: "Float top-up", ...over });
  assert.equal((await mv("cashier")).status, 403);
  assert.equal((await mv("manager", { reason: "bank_deposit" })).status, 400, "a reason that doesn't fit the movement");
  assert.equal((await mv("manager", { note: "x" })).status, 400, "a note is required");
  assert.equal((await mv("manager", { type: "cash_out", reason: "bank_deposit", amount: 100001, note: "Too much" })).status, 400, "more than is in the register");
  const [cash0, cap0, bank0, exp0] = [await net("1010"), await net("3010"), await net("1021"), await net("6010")];
  const k = key();
  const a = await ok("registerCash", "manager", { idempotencyKey: k, sessionId: mgr, type: "cash_in", reason: "owner_capital", amount: 50000, note: "Owner paid in" });
  await ok("registerCash", "manager", { idempotencyKey: k, sessionId: mgr, type: "cash_in", reason: "owner_capital", amount: 50000, note: "Owner paid in" });
  assert.deepEqual([a.expectedCash, a.posting], [150000, "posted"]);
  assert.equal((await net("1010")) - cash0, 50000);
  assert.equal(cap0 - (await net("3010")), 50000, "credited to Owner Capital");
  await ok("registerCash", "manager", { idempotencyKey: key(), sessionId: mgr, type: "cash_in", reason: "bank_withdrawal", amount: 20000, note: "From the bank" });
  assert.equal(bank0 - (await net("1021")), 20000);
  await ok("registerCash", "manager", { idempotencyKey: key(), sessionId: mgr, type: "cash_out", reason: "bank_deposit", amount: 30000, note: "Evening deposit" });
  await ok("registerCash", "manager", { idempotencyKey: key(), sessionId: mgr, type: "cash_out", reason: "operating_expense", amount: 5000, note: "Tea and cleaning" });
  assert.equal((await net("6010")) - exp0, 5000, "a shop expense");
  const s = await get(`registerSessions/${mgr}`);
  assert.deepEqual([s.cashIn, s.cashOut], [70000, 35000], "the repeated request counted once");
  const moves = (await db.collection("registerMovements").where("sessionId", "==", mgr).get()).docs.map((d) => d.data());
  assert.equal(moves.filter((m) => m.type === "cash_in" || m.type === "cash_out").every((m) => m.staffUid === "mgr-1" && m.staffName === "Manager" && m.reason && m.note && m.at), true);
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "register.cash_out" && d.data().actorUid === "mgr-1"));
  ids.mgr = mgr;
});

test("closing: expected cash = float + cash sales + cash in − cash out; a shortage and an excess are shown and posted as their own journals; nothing posted is changed", async () => {
  const reg = await openFor("cashier", { openingFloat: 200000 });
  const p = await newProduct({ shop: 10 });
  await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [cart(p, 2)], tenders: [cash(1000000), { method: "bank_transfer", amount: 1000000, reference: "TXN-CLOSE" }] });
  const before = JSON.stringify((await db.collection("journalEntries").get()).docs.map((d) => [d.id, d.data().totalDebit, d.data().lines.length]).sort());
  assert.equal((await ok("posContext", "cashier", {})).session.expectedCash, 1200000, "200,000 float + 1,000,000 cash (the bank part isn't cash)");
  assert.equal((await call("closeRegister", "cashier2", { sessionId: reg, countedCash: 1200000 })).status, 403, "another cashier can't close it");
  const cash0 = await net("1010");
  const close = await ok("closeRegister", "cashier", { sessionId: reg, countedCash: 1150000, note: "Counted twice" });
  assert.deepEqual([close.expectedCash, close.countedCash, close.variance, close.outcome, close.posting], [1200000, 1150000, -50000, "shortage", "posted"]);
  const s = await get(`registerSessions/${reg}`);
  assert.deepEqual([s.status, s.expectedCash, s.countedCash, s.variance, s.closedBy, s.closeNote], ["closed", 1200000, 1150000, -50000, "cash-1", "Counted twice"]);
  assert.equal(cash0 - (await net("1010")), 50000, "the shortage reduces cash");
  const vj = await get(`journalEntries/registervariance__${reg}`);
  assert.deepEqual(vj.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["6010", 50000, 0], ["1010", 0, 50000]], "expensed to the existing operating-expenses account");
  const posted = JSON.parse(before);
  for (const [id, total, n] of posted) assert.deepEqual([(await get(`journalEntries/${id}`)).totalDebit, (await get(`journalEntries/${id}`)).lines.length], [total, n], "no earlier journal was changed to make the cash fit");
  assert.equal(await get(`registerLocks/cash-1`), undefined, "the cashier can open a new register");
  assert.equal((await checkout("cashier", reg, [cart(p)], [cash(1000000)])).status, 400, "no sales on a closed register");
  assert.equal((await call("closeRegister", "cashier", { sessionId: reg, countedCash: 1 })).status, 400, "already closed");

  const reg2 = await openFor("cashier", { openingFloat: 300000 });
  await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg2, items: [cart(p)], tenders: [cash(1000000)] });
  const exact = await ok("closeRegister", "cashier", { sessionId: reg2, countedCash: 1300000 });
  assert.deepEqual([exact.variance, exact.outcome, exact.posting], [0, "exact", "none"]);
  assert.equal((await db.doc(`journalEntries/registervariance__${reg2}`).get()).exists, false, "no difference, no journal");

  const reg3 = await openFor("cashier", { openingFloat: 100000 });
  const over = await ok("closeRegister", "cashier", { sessionId: reg3, countedCash: 130000 });
  assert.deepEqual([over.variance, over.outcome], [30000, "excess"]);
  assert.deepEqual((await get(`journalEntries/registervariance__${reg3}`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1010", 30000, 0], ["6010", 0, 30000]]);
  const mgrClose = await openFor("cashier", { openingFloat: 10000 });
  assert.equal((await ok("closeRegister", "manager", { sessionId: mgrClose, countedCash: 10000 })).outcome, "exact", "a manager can close someone else's register");
  ids.closed = reg;
});

test("a payment taken in a register that is now closed can't be reversed; one in an open register keeps its totals right", async () => {
  const p = await newProduct({ shop: 10 });
  const reg = await openFor("cashier", { openingFloat: 0 });
  const r = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [cart(p)], tenders: [cash(400000), { method: "easypaisa", amount: 600000, reference: "EP-REV" }] });
  const txs = (await db.collection(`payments/${r.saleId}/transactions`).get()).docs;
  const cashTx = txs.find((d) => d.data().method === "cash");
  const wallet = txs.find((d) => d.data().method === "easypaisa");
  await salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: r.saleId, transactionId: wallet.id, reason: "Wallet payment never arrived" }), STAFF);
  assert.equal((await get(`registerSessions/${reg}`)).totals.easypaisa, 0, "the open register's totals follow the reversal");
  await ok("closeRegister", "cashier", { sessionId: reg, countedCash: 400000 });
  await assert.rejects(salePayments.reverseSalePayment(schemas.reverseSalePaymentInput.parse({ idempotencyKey: key(), saleId: r.saleId, transactionId: cashTx.id, reason: "Too late to reverse" }), STAFF), (e) => /now closed/.test(e.message));
  assert.equal((await get(`registerSessions/${reg}`)).totals.cash, 400000, "a closed register's reconciliation isn't touched");
});

/* ───────── Search, customers, receipts, reports ───────── */

test("search finds a scanned SKU exactly and names by word, with the stock of the register's warehouse", async () => {
  const p = await newProduct({ shop: 4, main: 9, price: 1200000 });
  const sku = (await get(`products/${p.productId}/variants/${p.variantId}`)).sku;
  const exact = await ok("posSearch", "cashier", { q: sku.toLowerCase(), warehouseId: ids.shop, exact: true });
  assert.equal(exact.match, "sku");
  assert.deepEqual([exact.products.length, exact.products[0].variants.length, exact.products[0].variants[0].sku, exact.products[0].variants[0].available, exact.products[0].variants[0].price], [1, 1, sku, 4, 1200000]);
  assert.equal((await ok("posSearch", "cashier", { q: sku, warehouseId: "main" })).products[0].variants[0].available, 9, "stock of the chosen warehouse");
  const byName = await ok("posSearch", "cashier", { q: `item ${seq}`, warehouseId: ids.shop });
  assert.equal(byName.match, "name");
  assert.ok(byName.products.some((x) => x.id === p.productId));
  assert.deepEqual((await ok("posSearch", "cashier", { q: "NO-SUCH-SKU-123", warehouseId: ids.shop, exact: true })).products, []);
  const arch = await newProduct({ status: "archived" });
  const archSku = (await get(`products/${arch.productId}/variants/${arch.variantId}`)).sku;
  assert.deepEqual((await ok("posSearch", "cashier", { q: archSku, warehouseId: ids.shop, exact: true })).products, [], "archived products aren't offered");
});

test("customer lookup by phone shows past purchases; a walk-in sale keeps only the typed receipt name", async () => {
  const found = await ok("posCustomerLookup", "cashier", { q: "03001234567" });
  assert.equal(found.customers.length, 1);
  assert.equal(found.customers[0].name, "Ayesha Khan");
  assert.ok(found.customers[0].recent.length >= 1 && found.customers[0].recent[0].channel === "pos");
  assert.deepEqual((await ok("posCustomerLookup", "cashier", { q: "ayesha@example.com" })).customers.map((c) => c.id), [ids.customer]);
  assert.deepEqual((await ok("posCustomerLookup", "cashier", { q: "0345 0000000" })).customers, []);
  const p = await newProduct({ shop: 3 });
  const reg = await openFor("cashier");
  const r = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [cart(p)], customerName: "Bilal", customerPhone: "0301 5555555", tenders: [cash(1000000)] });
  const s = await get(`sales/${r.saleId}`);
  assert.deepEqual([s.customerId, s.customer.name], [null, "Bilal"]);
  assert.equal((await call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [cart(p)], customerId: "no-such-user", tenders: [cash(1000000)] })).status, 400, "an unknown customer");
});

test("receipt data: the cashier gets their own sales; others get nothing; staff with register access can reprint", async () => {
  const mine = await ok("posReceipt", "cashier", { saleId: ids.sale1 });
  assert.equal(mine.sale.number, (await get(`sales/${ids.sale1}`)).number);
  assert.equal(mine.sale.cashierName, "Cashier One");
  assert.deepEqual(mine.payments.map((p) => [p.type, p.method, p.amount]), [["collection", "cash", 1800000]]);
  assert.equal((await call("posReceipt", "cashier2", { saleId: ids.sale1 })).status, 404, "someone else's sale");
  assert.equal((await call("posReceipt", "manager", { saleId: ids.sale1 })).status, 200, "a manager can reprint any");
  assert.equal((await call("posReceipt", "cashier", { saleId: "ghost" })).status, 404);
});

test("POS reports add up the saved sales, payments and registers; unrelated staff can't see them", async () => {
  const range = { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) };
  const r = await pos.posReport(range);
  const sales = (await db.collection("sales").where("channel", "==", "pos").get()).docs.map((d) => d.data());
  assert.equal(r.totals.sales, sales.length);
  assert.equal(r.totals.total, sales.reduce((n, s) => n + s.total, 0));
  assert.equal(r.totals.netSales, sales.reduce((n, s) => n + s.netSales, 0));
  assert.equal(r.byDay.reduce((n, d) => n + d.total, 0), r.totals.total, "days add up to the total");
  assert.equal(r.byCashier.reduce((n, c) => n + c.sales, 0), sales.length);
  assert.ok(r.byCashier.some((c) => c.name === "Cashier One") && r.byCashier.some((c) => c.name === "Manager"));
  assert.equal(r.byWarehouse.length, 1);
  assert.equal(r.byWarehouse[0].name, "Shop floor");
  assert.equal(r.byMethod.cash, sales.flatMap((s) => s.pos.tenders).filter((t) => t.method === "cash").reduce((n, t) => n + t.amount, 0));
  assert.ok(r.byMethod.bank_transfer > 0 && r.byMethod.easypaisa > 0 && r.byMethod.jazzcash > 0);
  assert.equal(r.collected + r.stillDue, r.totals.total, "paid + due = sales");
  const closed = r.sessions.filter((x) => x.status === "closed");
  assert.ok(closed.some((x) => x.variance === -50000), "a shortage shows in the session history");
  assert.ok(closed.some((x) => x.variance === 30000), "and an excess");
  assert.equal(r.cash.shortages, closed.filter((x) => x.variance < 0).reduce((n, x) => n + x.variance, 0));
  assert.equal(r.cash.sessionsWithShortage, closed.filter((x) => x.variance < 0).length);
  assert.equal(r.cash.sessionsWithExcess, closed.filter((x) => x.variance > 0).length);
  assert.ok(r.sessions.every((x) => x.expectedCash !== undefined));
  const empty = await pos.posReport({ from: new Date("2001-01-01"), to: new Date("2001-01-31") });
  assert.deepEqual([empty.totals.sales, empty.totals.total, empty.sessions.length], [0, 0, 0], "no invented figures for an empty period");
});

/* ───────── Accounting ───────── */

test("every POS sale and payment is journalled exactly once and the books balance; a failed posting never blocks the counter", async () => {
  const js = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(js.every((j) => j.totalDebit === j.totalCredit));
  const sales = (await db.collection("sales").where("channel", "==", "pos").get()).docs;
  for (const s of sales) assert.equal(js.filter((j) => j.id === `sale__${s.id}`).length, 1, `sale ${s.data().number} has exactly one journal`);
  const paymentJournals = js.filter((j) => j.sourceType === "payment");
  const txCount = (await Promise.all(sales.map((s) => db.collection(`payments/${s.id}/transactions`).get()))).reduce((n, q) => n + q.docs.filter((d) => d.data().type === "collection").length, 0);
  assert.equal(paymentJournals.filter((j) => sales.some((s) => j.memo.includes(s.data().number))).length, txCount, "one journal per payment entry");
  const tb = (await db.collection("ledgerEntries").get()).docs.reduce((a, d) => [a[0] + d.data().debit, a[1] + d.data().credit], [0, 0]);
  assert.equal(tb[0], tb[1]);

  // An account problem: the sale still happens and the failed posting is kept for repair.
  await db.doc("accountingConfig/main").update({ "accounts.4010.active": false });
  const p = await newProduct({ shop: 5 });
  const reg = await openFor("cashier");
  const r = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [cart(p)], tenders: [cash(1000000)] });
  assert.equal(r.posting, "failed");
  assert.equal(await stockIn(p, ids.shop), 4, "the sale and its stock went through");
  assert.equal((await get(`accountingExceptions/sale__${r.saleId}`)).status, "failed");
  await db.doc("accountingConfig/main").update({ "accounts.4010.active": true });
  assert.equal((await accounting.retryException({ id: `sale__${r.saleId}` }, STAFF)).status, "posted");
});
