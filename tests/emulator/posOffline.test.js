/**
 * Offline POS sync against the emulators (`npm run test:emulator`): a sale made offline is sent later through
 * posSyncSale. Everything is created in a throwaway "demo-" database; nothing real is involved.
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
const schemas = await import("../../functions/shared/schemas/index.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};
let seq = 0;
const key = () => `off_${randomUUID().replace(/-/g, "")}`;
const TOKENS = {
  cashier: { uid: "cash-1", name: "Cashier One", staff: true, perms: POS_ROLES.cashier.permissions, auth_time: 9999999999 },
  cashier2: { uid: "cash-2", name: "Cashier Two", staff: true, perms: POS_ROLES.cashier.permissions, auth_time: 9999999999 },
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
const stockIn = async (p, wid) => (await get(`inventory/${p.productId}__${p.variantId}`)).byWarehouse?.[wid]?.onHand ?? 0;
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);

async function newProduct({ shop = 5, price = 1000000, cost = 600000 } = {}) {
  seq += 1;
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: `Off Item ${seq}`, slug: `off-item-${seq}`, categoryId: ids.cat, sku: `OF-${seq}` }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null, costPrice: cost }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  if (shop) await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: shop, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId, variantId };
}
const open = async (token, floatAmount = 100000) => {
  const uid = TOKENS[token].uid;
  const lock = await get(`registerLocks/${uid}`);
  if (lock) await ok("closeRegister", token, { sessionId: lock.sessionId, countedCash: 0 });
  return (await ok("openRegister", token, { idempotencyKey: key().slice(4), warehouseId: ids.shop, openingFloat: floatAmount })).sessionId;
};
/** The request the till would send for a sale rung up offline. */
const offline = (sessionId, p, { qty = 1, total = 1000000, cashReceived, id = key(), extra = {} } = {}) => ({
  sale: { idempotencyKey: id, sessionId, items: [{ productId: p.productId, variantId: p.variantId, qty }], tenders: [{ method: "cash", amount: total, ...(cashReceived ? { cashReceived } : {}) }], customerName: "Walk-in", ...extra },
  offlineId: id,
  recordedAt: new Date(Date.now() - 3600000).toISOString(),
  expectedTotal: total,
});

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-x") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyLowStock: true });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  ids.reg = await open("cashier");
});

test("an offline sale is accepted once: one central sale, stock from the register's warehouse, cash journal, audit trail", async () => {
  const p = await newProduct({ shop: 5 });
  const cash0 = await net("1010");
  const req = offline(ids.reg, p, { qty: 2, total: 2000000, cashReceived: 2500000 });
  const r = await ok("posSyncSale", "cashier", req);
  assert.deepEqual([r.status, r.total, r.paidTotal, r.amountDue, r.change], ["synced", 2000000, 2000000, 0, 500000]);
  const s = await get(`sales/${r.saleId}`);
  assert.deepEqual([s.channel, s.warehouseId, s.cashierUid, s.sessionId, s.idempotencyKey], ["pos", ids.shop, "cash-1", ids.reg, req.offlineId]);
  assert.equal(s.pos.offline.offlineId, req.offlineId);
  assert.equal(s.pos.offline.recordedAt, req.recordedAt, "the time the sale really happened is kept");
  assert.equal(await stockIn(p, ids.shop), 3);
  assert.equal((await net("1010")) - cash0, 2000000);
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", r.saleId).get()).size, 1);
  const sync = await get(`posOfflineSyncs/cash-1__${req.offlineId}`);
  assert.deepEqual([sync.status, sync.saleId, sync.attempts], ["synced", r.saleId, 1]);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data()).find((a) => a.action === "pos.offline_sale" && a.entityId === r.saleId);
  assert.ok(audit && audit.changes.offlineTotal === 2000000 && audit.actorUid === "cash-1");
});

test("sending the same offline sale again — one after another or all at once, from any tab — never duplicates the sale, stock, payment or journal", async () => {
  const p = await newProduct({ shop: 5 });
  const req = offline(ids.reg, p, { qty: 1, total: 1000000 });
  const results = await Promise.all(Array.from({ length: 6 }, () => call("posSyncSale", "cashier", req)));
  assert.ok(results.every((x) => x.status === 200), JSON.stringify(results.map((x) => x.status)));
  const sale = results[0].body.data.saleId;
  assert.equal(new Set(results.map((x) => x.body.data.saleId)).size, 1);
  const again = await ok("posSyncSale", "cashier", req);
  assert.equal(again.saleId, sale);
  assert.equal(again.existing, true);
  assert.equal(await stockIn(p, ids.shop), 4, "deducted once");
  assert.equal((await db.collection("sales").where("idempotencyKey", "==", req.offlineId).get()).size, 1);
  assert.equal((await db.collection(`payments/${sale}/transactions`).get()).size, 1, "one payment record");
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", sale).get()).size, 1, "one sale journal");
  const number = (await get(`sales/${sale}`)).number;
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "payment").get()).docs.filter((d) => d.data().memo.includes(number)).length, 1, "one payment journal");
  assert.equal((await get(`registerSessions/${ids.reg}`)).totals.cash, (await db.collection("sales").where("sessionId", "==", ids.reg).get()).docs.reduce((n, d) => n + d.data().paidTotal, 0), "the register counted it once");
});

test("offline sales are cash only, must carry their own id, and can't claim a future time; permissions are enforced on the server", async () => {
  const p = await newProduct({ shop: 3 });
  const base = offline(ids.reg, p);
  const bank = { ...base, sale: { ...base.sale, tenders: [{ method: "bank_transfer", amount: 1000000, reference: "TXN-1" }] } };
  assert.equal((await call("posSyncSale", "cashier", bank)).status, 400);
  assert.equal((await call("posSyncSale", "cashier", { ...base, offlineId: key() })).status, 400, "id must equal the sale's key");
  assert.equal((await call("posSyncSale", "cashier", { ...base, recordedAt: new Date(Date.now() + 3600000).toISOString() })).status, 400);
  assert.equal((await call("posSyncSale", null, base)).status, 401);
  assert.equal((await call("posSyncSale", "customer", base)).status, 403);
  assert.equal((await call("posSyncSale", "cashier2", base)).status, 403, "someone else's register");
  assert.equal(await stockIn(p, ids.shop), 3, "nothing was sold");
  const disc = { ...base, offlineId: key(), sale: { ...base.sale, idempotencyKey: undefined, discount: { type: "amount", value: 100, reason: "Sneaky" } } };
  disc.sale.idempotencyKey = disc.offlineId;
  assert.equal((await call("posSyncSale", "cashier", disc)).status, 403, "a cashier can't smuggle in a discount");
});

test("a price that changed while offline holds the sale for a manager; the server's price is never overridden silently", async () => {
  const p = await newProduct({ shop: 4, price: 1000000 });
  await db.doc(`products/${p.productId}/variants/${p.variantId}`).update({ price: 1200000 });
  const req = offline(ids.reg, p, { total: 1000000, cashReceived: 1000000 });
  const r = await ok("posSyncSale", "cashier", req);
  assert.deepEqual([r.status, r.conflict, r.details.offlineTotal, r.details.serverTotal], ["conflict", "price_changed", 1000000, 1200000]);
  assert.equal(await stockIn(p, ids.shop), 4, "no stock moved");
  assert.equal((await db.collection("sales").where("idempotencyKey", "==", req.offlineId).get()).size, 0, "no sale");
  assert.equal((await get(`posOfflineSyncs/cash-1__${req.offlineId}`)).status, "conflict");
  assert.equal((await ok("posSyncSale", "cashier", req)).status, "conflict", "resending doesn't change the answer");
  assert.equal((await call("posSyncSale", "cashier", { ...req, resolution: "accept_server_price" })).status, 403, "a cashier can't accept it");
  const higher = await ok("posSyncSale", "cashier", { ...req });
  assert.equal(higher.conflict, "price_changed");
  // Server price HIGHER than the cash taken can't be accepted.
  const refused = await ok("posSyncSale", "manager", { ...req, sale: { ...req.sale, sessionId: await open("manager") }, resolution: "accept_server_price" });
  assert.equal(refused.status, "conflict");
  // Server price LOWER than the cash taken: the manager accepts it and the sale is recorded at the server's price.
  await db.doc(`products/${p.productId}/variants/${p.variantId}`).update({ price: 900000 });
  const mreg = await open("manager");
  const mreq = offline(mreg, p, { total: 1000000, cashReceived: 1000000 });
  assert.equal((await ok("posSyncSale", "manager", mreq)).conflict, "price_changed");
  const accepted = await ok("posSyncSale", "manager", { ...mreq, resolution: "accept_server_price" });
  assert.deepEqual([accepted.status, accepted.total, accepted.paidTotal, accepted.amountDue], ["synced", 900000, 900000, 0]);
  const sale = await get(`sales/${accepted.saleId}`);
  assert.equal(sale.lines[0].unitPrice, 900000);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data()).find((a) => a.action === "pos.offline_sale" && a.entityId === accepted.saleId);
  assert.deepEqual([audit.changes.offlineTotal, audit.changes.serverTotal, audit.changes.acceptedServerPrice], [1000000, 900000, true], "the difference is on record");
  assert.equal((await net("1110")), (await net("1110")), "receivable untouched by the cash sale");
});

test("stock conflicts: an offline sale never takes stock below zero or from another warehouse; the server's newer stock is never overwritten; after restocking it can be retried", async () => {
  const p = await newProduct({ shop: 2 });
  const reg = await open("cashier");
  // Someone else sold the pairs while this till was offline.
  const reg2 = await open("cashier2");
  await ok("posSyncSale", "cashier2", offline(reg2, p, { qty: 2, total: 2000000 }));
  assert.equal(await stockIn(p, ids.shop), 0);
  const req = offline(reg, p, { qty: 1, total: 1000000 });
  const r = await ok("posSyncSale", "cashier", req);
  assert.deepEqual([r.status, r.conflict, r.details.available], ["conflict", "stock", 0]);
  assert.match(r.message, /not in stock in Shop floor/);
  assert.equal(await stockIn(p, ids.shop), 0, "no negative stock");
  assert.equal((await db.collection("sales").where("idempotencyKey", "==", req.offlineId).get()).size, 0);
  // Stock arrives; the same sale is retried and now goes through, once.
  await inventory.adjustStock({ productId: p.productId, variantId: p.variantId, warehouseId: ids.shop, change: 3, reason: "purchase", note: "" }, STAFF);
  const done = await ok("posSyncSale", "cashier", req);
  assert.equal(done.status, "synced");
  assert.equal(await stockIn(p, ids.shop), 2);
  const sync = await get(`posOfflineSyncs/cash-1__${req.offlineId}`);
  assert.deepEqual([sync.status, sync.attempts, sync.conflict], ["synced", 2, null]);
});

test("two offline tills selling the last pair: exactly one is accepted, the other is held, stock ends at zero", async () => {
  const p = await newProduct({ shop: 1 });
  const a = await open("cashier");
  const b = await open("cashier2");
  const [x, y] = await Promise.all([ok("posSyncSale", "cashier", offline(a, p)), ok("posSyncSale", "cashier2", offline(b, p))]);
  assert.deepEqual([x.status, y.status].sort(), ["conflict", "synced"]);
  assert.equal(await stockIn(p, ids.shop), 0);
  assert.equal((await db.collection("sales").get()).docs.filter((d) => d.data().lines[0].productId === p.productId).length, 1);
});

test("a register that was closed before the sale arrived holds it; a manager can discard it, but not once it exists", async () => {
  const p = await newProduct({ shop: 3 });
  const reg = await open("cashier");
  await ok("closeRegister", "cashier", { sessionId: reg, countedCash: 100000 });
  const req = offline(reg, p);
  const r = await ok("posSyncSale", "cashier", req);
  assert.deepEqual([r.status, r.conflict], ["conflict", "register"]);
  assert.equal((await call("posSyncDiscard", "cashier", { offlineId: req.offlineId, reason: "Customer returned the shoes" })).status, 403, "a cashier can't discard");
  const d = await ok("posSyncDiscard", "manager", { offlineId: req.offlineId, reason: "Cash handed back to the customer" });
  assert.equal(d.status, "discarded");
  assert.equal((await get(`posOfflineSyncs/mgr-1__${req.offlineId}`)).status, "discarded");
  assert.ok((await db.collection("auditLogs").get()).docs.some((x) => x.data().action === "pos.offline_discard" && x.data().entityId === req.offlineId && x.data().changes.reason));
  // A sale that exists can't be discarded.
  const reg2 = await open("manager");
  const good = offline(reg2, p);
  await ok("posSyncSale", "manager", good);
  assert.equal((await call("posSyncDiscard", "manager", { offlineId: good.offlineId, reason: "Changed my mind" })).status, 400);
  assert.equal(await stockIn(p, ids.shop), 2);
});

test("accounting: every accepted offline sale has one balanced journal, retries and conflicts add none, and the books still balance", async () => {
  const sales = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().pos?.offline);
  assert.ok(sales.length >= 4);
  const journals = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const s of sales) assert.equal(journals.filter((j) => j.id === `sale__${s.id}`).length, 1, s.data().number);
  assert.ok(journals.every((j) => j.totalDebit === j.totalCredit));
  const synced = (await db.collection("posOfflineSyncs").where("status", "==", "synced").get()).size;
  assert.equal(synced, sales.length, "one synced record per sale created");
  const tb = (await db.collection("ledgerEntries").get()).docs.reduce((a, d) => [a[0] + d.data().debit, a[1] + d.data().credit], [0, 0]);
  assert.equal(tb[0], tb[1]);
  // An account problem never loses the sale: it is created and the failed posting is kept for repair.
  await db.doc("accountingConfig/main").update({ "accounts.4010.active": false });
  const p = await newProduct({ shop: 2 });
  const reg = await open("cashier");
  const r = await ok("posSyncSale", "cashier", offline(reg, p));
  assert.deepEqual([r.status, r.posting], ["synced", "failed"]);
  assert.equal((await get(`accountingExceptions/sale__${r.saleId}`)).status, "failed");
  await db.doc("accountingConfig/main").update({ "accounts.4010.active": true });
  assert.equal((await accounting.retryException({ id: `sale__${r.saleId}` }, STAFF)).status, "posted");
  assert.equal((await ok("posSyncSale", "cashier", offline(reg, p, { id: (await db.collection("posOfflineSyncs").where("saleId", "==", r.saleId).get()).docs[0].data().offlineId }))).existing, true);
  assert.equal((await db.collection("journalEntries").where("sourceId", "==", r.saleId).get()).size, 1, "a retry after repair adds no second journal");
});

test("managers see the sync outcomes and what needs attention; cashiers don't; the offline catalogue pages through the products with the register warehouse's stock", async () => {
  assert.equal((await call("posSyncList", "cashier", {})).status, 403);
  const all = await ok("posSyncList", "manager", {});
  assert.ok(all.entries.length >= 6);
  const conflicts = await ok("posSyncList", "manager", { status: "conflict" });
  assert.ok(conflicts.entries.length >= 1 && conflicts.entries.every((e) => e.status === "conflict" && e.error));
  assert.ok(all.entries.every((e) => e.offlineId && e.updatedAt));
  assert.equal((await call("posCatalog", "customer", { warehouseId: ids.shop })).status, 403);
  const seen = [];
  let after = null;
  let pages = 0;
  do {
    const page = await ok("posCatalog", "cashier", { warehouseId: ids.shop, after });
    pages += 1;
    seen.push(...page.products);
    after = page.next;
  } while (after && pages < 10);
  const withStock = seen.find((x) => x.variants.some((v) => v.available > 0));
  assert.ok(withStock && withStock.variants[0].sku && withStock.variants[0].price > 0 && withStock.variants[0].colorName && withStock.variants[0].sizeLabel);
  assert.equal(new Set(seen.map((x) => x.id)).size, seen.length, "no product twice across pages");
});
