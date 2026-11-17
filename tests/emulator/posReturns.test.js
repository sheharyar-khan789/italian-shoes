/**
 * POS returns, refunds and exchanges against the emulators (`npm run test:emulator`). Throwaway "demo-" data only.
 * Every figure below is worked out by hand from the prices, so a wrong refund, restock or journal fails loudly.
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
const { restockAllocations } = await import("../../functions/services/posReturns.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;
const key = () => randomUUID().replace(/-/g, "");
const TOKENS = {
  cashier: { uid: "cash-1", name: "Cashier One", staff: true, perms: POS_ROLES.cashier.permissions, auth_time: 9999999999 },
  cashier2: { uid: "cash-2", name: "Cashier Two", staff: true, perms: [...POS_ROLES.cashier.permissions, "pos.return"], auth_time: 9999999999 },
  manager: { uid: "mgr-1", name: "Manager", staff: true, perms: POS_ROLES.pos_manager.permissions, auth_time: 9999999999 },
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
const CODES = ["1010", "1021", "1110", "1200", "2020", "4010", "4020", "4030", "5010", "5030"];
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const books = async () => Object.fromEntries(await Promise.all(CODES.map(async (c) => [c, await net(c)])));
const diff = (a, b) => Object.fromEntries(CODES.map((c) => [c, b[c] - a[c]]));
const zero = Object.fromEntries(CODES.map((c) => [c, 0]));
/** Revenue and returns are two accounts; for "back to where it was" what matters is that together they net to nothing. */
const settled = (d) => ({ ...d, 4010: d[4010] + d[4030], 4030: 0 });
const stockIn = async (p, wid) => (await get(`inventory/${p.productId}__${p.variantId}`)).byWarehouse?.[wid]?.onHand ?? 0;

async function newProduct({ shop = 10, price = 1000000, cost = 600000 } = {}) {
  seq += 1;
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Ret Item ${seq}`, slug: `ret-item-${seq}`, categoryId: ids.cat, sku: `RT-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null, costPrice: cost }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: shop, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId, variantId };
}
let regSeq = 0;
async function openFor(token, openingFloat = 5000000) {
  const uid = TOKENS[token].uid;
  const lock = await get(`registerLocks/${uid}`);
  if (lock) await ok("closeRegister", token, { sessionId: lock.sessionId, countedCash: (await get(`registerSessions/${lock.sessionId}`)).openingFloat });
  regSeq += 1;
  return (await ok("openRegister", token, { idempotencyKey: `open-${regSeq}-${key()}`, warehouseId: ids.shop, openingFloat })).sessionId;
}
const sell = (token, sessionId, p, qty, tenders, over = {}) => ok("posCheckout", token, { idempotencyKey: key(), sessionId, items: [{ productId: p.productId, variantId: p.variantId, qty }], tenders, ...over });
const ret = (token, saleId, lines, over = {}) => call("posReturn", token, { idempotencyKey: key(), saleId, lines, reason: "Customer changed mind", ...over });
const okRet = async (token, saleId, lines, over = {}) => {
  const r = await ret(token, saleId, lines, over);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
};

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-x") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", phone: "0300 1112223", address: "Main Road", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyLowStock: true });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  await db.doc("users/cust-1").set({ name: "Ali Khan", phone: "03001234567", email: "ali@example.test" });
});

test("allocations are put back where the sale took them from, never more than was taken", () => {
  const a = [{ warehouseId: "w1", qty: 2 }, { warehouseId: "w2", qty: 3 }];
  const r = restockAllocations(a, 3);
  assert.deepEqual(r.put, [{ warehouseId: "w1", qty: 2 }, { warehouseId: "w2", qty: 1 }]);
  assert.deepEqual(r.next.map((x) => x.returned), [2, 1]);
  assert.deepEqual(restockAllocations(r.next, 2).put, [{ warehouseId: "w2", qty: 2 }]);
  assert.throws(() => restockAllocations(r.next, 3), /can't be matched/);
});

test("permissions and validation: only pos.return can take goods back", async () => {
  const p = await newProduct();
  const reg = await openFor("manager");
  const s = await sell("manager", reg, p, 1, [{ method: "cash", amount: 1000000 }]);
  const data = { idempotencyKey: key(), saleId: s.saleId, lines: [{ lineIndex: 0, qty: 1 }], reason: "x y z", sessionId: reg };
  assert.equal((await call("posReturn", null, data)).status, 401);
  assert.equal((await call("posReturn", "customer", data)).status, 403);
  assert.equal((await call("posReturn", "cashier", data)).status, 403, "a plain cashier cannot refund");
  assert.equal((await call("posReturnList", "cashier", {})).status, 403);
  assert.equal((await call("posReturn", "manager", { ...data, lines: [] })).status, 400, "nothing chosen");
  assert.equal((await call("posReturn", "manager", { ...data, lines: [{ lineIndex: 0, qty: 1 }, { lineIndex: 0, qty: 1 }] })).status, 400, "same line twice");
  assert.equal((await call("posReturn", "manager", { ...data, refundMethod: "bank_transfer" })).status, 400, "bank refund needs a reference");
  assert.equal(await stockIn(p, ids.shop), 9, "nothing changed by the refused calls");
});

test("a partial cash return: stock back, refund from the register, books reverse exactly the returned share", async () => {
  const p = await newProduct({ shop: 10 });
  const reg = await openFor("manager");
  const start = await books();
  const s = await sell("manager", reg, p, 3, [{ method: "cash", amount: 3000000 }]);
  assert.equal(await stockIn(p, ids.shop), 7);
  const cashBefore = (await get(`registerSessions/${reg}`)).totals.cash;

  const r = await okRet("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg });
  assert.equal(r.value, 1000000);
  assert.equal(r.refund, 1000000);
  assert.equal(r.posting, "posted");
  assert.equal(await stockIn(p, ids.shop), 8, "one pair back on the shelf");
  const sale = await get(`sales/${s.saleId}`);
  assert.equal(sale.status, "completed", "still open: two pairs kept");
  assert.equal(sale.lines[0].returnedQty, 1);
  assert.equal(sale.returnedTotal, 1000000);
  assert.equal(sale.refundedTotal, 1000000);
  const pay = await get(`payments/${s.saleId}`);
  assert.equal(pay.status, "partially_refunded");
  assert.equal(pay.refundedTotal, 1000000);
  assert.equal((await get(`registerSessions/${reg}`)).totals.cash, cashBefore - 1000000, "the refund left the register");
  // Sale of 3 then 1 returned: revenue 3,000,000 less returns 1,000,000; cost of goods 1,800,000 less 600,000; cash +2,000,000.
  assert.deepEqual(diff(start, await books()), { ...zero, 1010: 2000000, 1200: -1200000, 4010: -3000000, 4030: 1000000, 5010: 1200000 });
  const rec = await get(`salesReturns/${r.returnId}`);
  assert.equal(rec.lines[0].cost, 600000);
  assert.equal(rec.restockCost, 600000);
  const mv = (await db.collection("stockMovements").where("inventoryId", "==", `${p.productId}__${p.variantId}`).get()).docs.map((x) => x.data());
  assert.ok(mv.some((m) => m.change === 1 && m.warehouseId === ids.shop), "a stock movement records the return");
});

test("the same request twice returns the first result and changes nothing; over-returning is refused", async () => {
  const p = await newProduct({ shop: 5 });
  const reg = await openFor("manager");
  const s = await sell("manager", reg, p, 2, [{ method: "cash", amount: 2000000 }]);
  const body = { idempotencyKey: key(), saleId: s.saleId, lines: [{ lineIndex: 0, qty: 1 }], reason: "Wrong size", sessionId: reg };
  const first = await ok("posReturn", "manager", body);
  const again = await ok("posReturn", "manager", body);
  assert.equal(again.existing, true);
  assert.equal(again.returnId, first.returnId);
  assert.equal(await stockIn(p, ids.shop), 4, "restocked once");
  assert.equal((await db.collection("salesReturns").where("saleId", "==", s.saleId).get()).size, 1);
  const tooMany = await ret("manager", s.saleId, [{ lineIndex: 0, qty: 2 }], { sessionId: reg });
  assert.equal(tooMany.status, 400);
  assert.match(JSON.stringify(tooMany.body), /only 1 can still be taken back/);
  assert.equal((await ret("manager", s.saleId, [{ lineIndex: 9, qty: 1 }], { sessionId: reg })).status, 400, "no such line");
});

test("returning everything closes the sale and leaves the books exactly as if it never happened", async () => {
  const p = await newProduct({ shop: 6 });
  const reg = await openFor("manager");
  const start = await books();
  const s = await sell("manager", reg, p, 3, [{ method: "cash", amount: 3000000 }]);
  for (let i = 0; i < 3; i++) await okRet("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg });
  assert.deepEqual(settled(diff(start, await books())), zero, "every account back to where it was (revenue less returns nets to nothing)");
  const sale = await get(`sales/${s.saleId}`);
  assert.equal(sale.status, "returned");
  assert.equal(sale.returnedTotal, sale.total);
  assert.equal((await get(`payments/${s.saleId}`)).status, "refunded");
  assert.equal(await stockIn(p, ids.shop), 6);
  assert.notEqual((await ret("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg })).status, 200, "a closed sale takes nothing more back");
});

test("damaged pairs are not restocked: cost of goods is reversed into a write-off", async () => {
  const p = await newProduct({ shop: 4 });
  const reg = await openFor("manager");
  const start = await books();
  const s = await sell("manager", reg, p, 1, [{ method: "cash", amount: 1000000 }]);
  const r = await okRet("manager", s.saleId, [{ lineIndex: 0, qty: 1, condition: "damaged" }], { sessionId: reg });
  assert.equal(await stockIn(p, ids.shop), 3, "nothing went back on the shelf");
  assert.equal(r.refund, 1000000);
  const d = diff(start, await books());
  assert.equal(d[5030], 600000, "the pair's cost is written off");
  assert.equal(d[5010], 0, "cost of goods sold is reversed");
  assert.equal(d[1200], -600000, "inventory stays lower: the pair is gone");
  assert.equal(d[1010], 0);
});

test("a part-paid sale: the unpaid balance shrinks, only the overpaid part is refunded", async () => {
  const p = await newProduct({ shop: 3 });
  const reg = await openFor("manager");
  const start = await books();
  const s = await sell("manager", reg, p, 1, [{ method: "cash", amount: 400000 }], { customerId: "cust-1" });
  assert.equal(s.amountDue, 600000);
  const r = await okRet("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg });
  assert.equal(r.value, 1000000);
  assert.equal(r.refund, 400000, "only what was paid comes back");
  assert.equal(r.receivableCredit, 600000, "the rest just cancels what they owed");
  const sale = await get(`sales/${s.saleId}`);
  assert.equal(sale.amountDue, 0);
  assert.equal(sale.status, "returned");
  assert.deepEqual(settled(diff(start, await books())), zero, "customer owes nothing, cash back to start");
});

test("sales tax is given back in proportion, and partial returns add up to exactly the sale total", async () => {
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyLowStock: true, taxEnabled: true, taxRatePercent: 10 });
  try {
    const p = await newProduct({ shop: 5, price: 333333, cost: 100000 });
    const reg = await openFor("manager");
    const start = await books();
    const total = 1099998; // 3 x 3,333.33 = 9,999.99, plus 10% tax rounded as the till rounds it
    const s = await sell("manager", reg, p, 3, [{ method: "cash", amount: total }]);
    const sale = await get(`sales/${s.saleId}`);
    assert.ok(sale.taxTotal > 0, "tax was charged");
    const vals = [];
    for (let i = 0; i < 3; i++) vals.push((await okRet("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg })).value);
    assert.equal(vals.reduce((a, b) => a + b, 0), sale.total, `three returns (${vals.join(" + ")}) must equal the sale total ${sale.total}`);
    assert.deepEqual(settled(diff(start, await books())), zero, "tax, revenue, cost and cash all back to where they were");
  } finally {
    await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyLowStock: true });
  }
});

test("a cash refund needs the cashier's own open register; a bank refund does not", async () => {
  const p = await newProduct({ shop: 4 });
  const reg = await openFor("manager", 0);
  const s = await sell("manager", reg, p, 1, [{ method: "cash", amount: 1000000 }]);
  const noReg = await ret("manager", s.saleId, [{ lineIndex: 0, qty: 1 }]);
  assert.equal(noReg.status, 400);
  assert.match(JSON.stringify(noReg.body), /open register/);
  await openFor("cashier2", 0);
  assert.equal((await ret("cashier2", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg })).status, 403, "someone else's register");
  const bankBefore = await net("1021");
  const bank = await ret("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { refundMethod: "bank_transfer", reference: "TXN-1234" });
  assert.equal(bank.status, 200, JSON.stringify(bank.body));
  assert.equal(bank.body.data.refund, 1000000);
  assert.equal(await net("1021"), bankBefore - 1000000, "the bank paid the refund");
});

test("a cash refund is limited to the cash in the drawer", async () => {
  const p = await newProduct({ shop: 4 });
  const reg = await openFor("manager", 0);
  const s = await sell("manager", reg, p, 1, [{ method: "cash", amount: 1000000 }]);
  await ok("registerCash", "manager", { idempotencyKey: key(), sessionId: reg, type: "cash_out", reason: "bank_deposit", amount: 900000, note: "banked" });
  const tooLittle = await ret("manager", s.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg });
  assert.equal(tooLittle.status, 400);
  assert.match(JSON.stringify(tooLittle.body), /should be in this register/);
  assert.equal(await stockIn(p, ids.shop), 3, "a refused return changes no stock");
  assert.equal((await get(`sales/${s.saleId}`)).status, "completed");
});

test("an exchange is a return flagged as one; the new pair is an ordinary new sale and the books stay balanced", async () => {
  const oldPair = await newProduct({ shop: 3, price: 1000000, cost: 600000 });
  const newPair = await newProduct({ shop: 3, price: 1200000, cost: 700000 });
  const reg = await openFor("manager");
  const start = await books();
  const s1 = await sell("manager", reg, oldPair, 1, [{ method: "cash", amount: 1000000 }]);
  const r = await okRet("manager", s1.saleId, [{ lineIndex: 0, qty: 1 }], { sessionId: reg, exchange: true, reason: "Exchange for bigger size" });
  assert.equal((await get(`salesReturns/${r.returnId}`)).exchange, true);
  await sell("manager", reg, newPair, 1, [{ method: "cash", amount: 1200000 }]);
  assert.equal(await stockIn(oldPair, ids.shop), 3);
  assert.equal(await stockIn(newPair, ids.shop), 2);
  const d = diff(start, await books());
  assert.equal(d[1010], 1200000, "the till kept the new pair's price");
  assert.equal(d[4010] + d[4030] + d[4020], -1200000, "net revenue is the new pair only");
  assert.equal(d[5010], 700000);
});

test("every journal in the books is balanced after all the returns, and returns are listed", async () => {
  const all = await db.collection("journalEntries").get();
  for (const j of all.docs) {
    const d = j.data();
    assert.equal(d.lines.reduce((n, l) => n + (l.debit ?? 0), 0), d.lines.reduce((n, l) => n + (l.credit ?? 0), 0), `journal ${d.number} is balanced`);
  }
  assert.ok(all.docs.some((j) => j.data().sourceType === "salereturn"));
  const list = await ok("posReturnList", "manager", { limit: 50 });
  assert.ok(list.returns.length >= 8);
});
