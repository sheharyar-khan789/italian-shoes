/**
 * Advanced inventory against the emulators (`npm run test:emulator`): adjustments with approval, cost revaluation,
 * transfers with partial receiving and damaged/missing pairs, physical counts, alerts, valuation reconciled to the
 * ledger, barcodes, the dashboard and reports, concurrency and permissions. All data is created in a throwaway "demo-"
 * database. Tests share state and run in order.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth, Timestamp } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const warehouses = await import("../../functions/services/warehouses.js");
const transfers = await import("../../functions/services/transfers.js");
const accounting = await import("../../functions/services/accounting.js");
const accReports = await import("../../functions/services/accountingReports.js");
const suppliers = await import("../../functions/services/suppliers.js");
const purchaseOrders = await import("../../functions/services/purchaseOrders.js");
const goods = await import("../../functions/services/goodsReceipts.js");
const pos = await import("../../functions/services/pos.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { isEan13 } = await import("../../functions/shared/inventory.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");
const TOKENS = {
  reader: { uid: "inv-r", name: "Reader", staff: true, perms: ["inventory.read"], auth_time: 9999999999 },
  clerk: { uid: "inv-c", name: "Clerk", staff: true, perms: ["inventory.read", "inventory.adjust"], auth_time: 9999999999 },
  counter: { uid: "inv-n", name: "Counter", staff: true, perms: ["inventory.read", "inventory.count"], auth_time: 9999999999 },
  approver: { uid: "inv-a", name: "Approver", staff: true, perms: ["inventory.read", "inventory.adjust", "inventory.count", "inventory.approve", "inventory.manage", "transfers.manage"], auth_time: 9999999999 },
  mover: { uid: "inv-t", name: "Mover", staff: true, perms: ["inventory.read", "transfers.manage"], auth_time: 9999999999 },
  customer: { uid: "cust-1" },
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
const onHand = async (p, wid) => ((await get(`inventory/${p.productId}__${p.variantId}`)).byWarehouse?.[wid]?.onHand ?? 0);
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const lines = async (jid) => (await get(`journalEntries/${jid}`))?.lines.map((l) => [l.accountCode, l.debit, l.credit]);

async function makeVariant(name, slug, sku) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price: 2000000, salePrice: null }), { actorUid: STAFF, canEditCost: false });
  await db.doc(`products/${productId}`).update({ status: "published" });
  return { productId, variantId: products.variantKey(ids.black, ids.s42) };
}
/** Stock that arrives the proper way (a goods receipt): it gets a cost and a journal. */
async function receiveStock(p, qty, unitCost, wid) {
  const poId = (await purchaseOrders.savePurchaseOrder(schemas.savePurchaseOrderInput.parse({ supplierId: ids.sup, warehouseId: wid, lines: [{ productId: p.productId, variantId: p.variantId, qty, unitCost, discount: 0 }] }), STAFF)).id;
  await purchaseOrders.approvePurchaseOrder({ id: poId }, STAFF);
  await goods.receiveGoods(schemas.receiveGoodsInput.parse({ idempotencyKey: key(), purchaseOrderId: poId, lines: [{ lineIndex: 0, acceptedQty: qty, rejectedQty: 0 }] }), STAFF);
}
const adjust = (token, p, over = {}) => call("createStockAdjustment", token, { idempotencyKey: key(), productId: p.productId, variantId: p.variantId, warehouseId: ids.shop, reason: "damaged", change: -2, description: "Soles split", ...over });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-1") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: false });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  ids.store = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Back store", code: "BACK", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  ids.sup = (await suppliers.saveSupplier(schemas.saveSupplierInput.parse({ name: "Stock Supplier" }), STAFF)).id;
  ids.p1 = await makeVariant("Oxford One", "oxford-one", "OX-1");
  ids.p2 = await makeVariant("Loafer Two", "loafer-two", "LF-2");
  ids.p3 = await makeVariant("No Cost Boot", "no-cost-boot", "NC-3");
  await receiveStock(ids.p1, 20, 100000, ids.shop);
  await receiveStock(ids.p2, 10, 50000, ids.shop);
  await inventory.adjustStock({ productId: ids.p3.productId, variantId: ids.p3.variantId, warehouseId: ids.shop, change: 4, reason: "initial", note: "" }, STAFF);
});

test("every advanced-inventory endpoint needs its own permission", async () => {
  const probes = [["inventoryDashboard", {}, "reader"], ["inventoryAlerts", {}, "reader"], ["inventoryItems", {}, "reader"], ["getInventorySettings", {}, "reader"], ["lookupBarcode", { code: "123456789012" }, "reader"]];
  for (const [name, data] of probes) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "reader", data)).status, 200, `${name} reader`);
  }
  assert.equal((await adjust("reader", ids.p1)).status, 403, "reading isn't adjusting");
  const pol = { productId: ids.p1.productId, variantId: ids.p1.variantId, minStock: 1, reorderLevel: 2, maxStock: 50, locations: {} };
  for (const t of ["reader", "clerk", "counter", "mover"]) assert.equal((await call("setStockPolicy", t, pol)).status, 403, `${t} can't set levels`);
  assert.equal((await call("startStockCount", "clerk", { idempotencyKey: key(), warehouseId: ids.shop })).status, 403, "adjusting isn't counting");
  assert.equal((await call("decideStockAdjustment", "clerk", { id: "x", decision: "approve" })).status, 403);
  assert.equal((await call("decideStockCount", "counter", { id: "x", decision: "approve" })).status, 403, "counting isn't approving");
  assert.equal((await call("applyStockCount", "counter", { id: "x" })).status, 403);
  assert.equal((await call("adjustVariantCost", "clerk", { idempotencyKey: key(), productId: "p", variantId: "v", newCost: 100, reason: "no" })).status, 403);
  assert.equal((await call("assignBarcode", "clerk", { productId: ids.p1.productId, variantId: ids.p1.variantId })).status, 403);
  assert.equal((await call("receiveTransferLines", "clerk", { idempotencyKey: key(), id: "x", lines: [{ lineIndex: 0, receivedQty: 1 }] })).status, 403);
  assert.equal((await call("saveInventorySettings", "clerk", { lowStock: 2, slowDays: 60, deadDays: 180, adjustApprovalUnits: 0, adjustApprovalValue: 0 })).status, 403);
});

test("a stock adjustment is a recorded change: previous, change and new quantity, who and why; losses are written off at cost; nothing is overwritten", async () => {
  const r = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "damaged", change: -2, description: "Soles split", seenOnHand: 20 });
  assert.deepEqual([r.status, r.previousQty, r.newQty], ["applied", 20, 18]);
  assert.equal(await onHand(ids.p1, ids.shop), 18);
  const a = await get(`stockAdjustments/${r.id}`);
  assert.deepEqual([a.number.startsWith("ADJ-"), a.reason, a.changeQty, a.previousQty, a.newQty, a.createdBy, a.value, a.unitCost], [true, "damaged", -2, 20, 18, "inv-c", 200000, 100000]);
  assert.deepEqual(await lines(`stockadjustment__${r.id}`), [["5030", 200000, 0], ["1200", 0, 200000]], "Dr inventory adjustments, Cr inventory");
  const mv = (await db.collection("stockMovements").where("sourceId", "==", r.id).get()).docs.map((d) => d.data());
  assert.deepEqual([mv.length, mv[0].change, mv[0].warehouseId, mv[0].sourceType, mv[0].onHandBefore, mv[0].onHandAfter], [1, -2, ids.shop, "stock_adjustment", 20, 18]);
  const k = key();
  const body = { idempotencyKey: k, productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "found", change: 1, description: "Behind the shelf" };
  const found = await ok("createStockAdjustment", "clerk", body);
  assert.equal((await ok("createStockAdjustment", "clerk", body)).existing, true, "the same request twice is one adjustment");
  assert.equal(await onHand(ids.p1, ids.shop), 19);
  assert.deepEqual(await lines(`stockadjustment__${found.id}`), [["1200", 100000, 0], ["5030", 0, 100000]], "a gain is the opposite");
  assert.equal((await adjust("clerk", ids.p1, { reason: "damaged", change: 3 })).status, 400, "a damaged-goods adjustment removes stock");
  assert.equal((await adjust("clerk", ids.p1, { reason: "found", change: -1 })).status, 400, "found stock adds stock");
  assert.equal((await adjust("clerk", ids.p1, { change: -999 })).status, 400, "never below zero");
  assert.equal((await adjust("clerk", ids.p1, { change: 0, reason: "correction" })).status, 400);
  assert.equal((await adjust("clerk", ids.p1, { reason: "correction", change: -1, seenOnHand: 3 })).status, 409, "stock changed since the person looked: refused, not overwritten");
  assert.equal(await onHand(ids.p1, ids.shop), 19);
  assert.equal((await adjust("clerk", ids.p1, { description: "ab" })).status, 400, "a description is required");
  const noCost = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p3.productId, variantId: ids.p3.variantId, warehouseId: ids.shop, reason: "lost", change: -1, description: "Left on a bus" });
  assert.equal(noCost.costMissing, true, "a variant with no recorded cost still adjusts; the write-off is flagged");
  assert.equal((await db.doc(`journalEntries/stockadjustment__${noCost.id}`).get()).exists, false);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data());
  assert.ok(audit.some((x) => x.action === "stock.adjustment_applied" && x.entityId === r.id && x.changes.previousQty === 20));
});

test("large adjustments wait for approval; nothing moves until another person approves, and the stock is re-checked then", async () => {
  await ok("saveInventorySettings", "approver", { lowStock: 3, slowDays: 60, deadDays: 180, adjustApprovalUnits: 5, adjustApprovalValue: 0 });
  const before = await onHand(ids.p1, ids.shop);
  const pend = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "lost", change: -6, description: "Whole box missing" });
  assert.deepEqual([pend.status, pend.newQty], ["pending", null]);
  assert.equal(await onHand(ids.p1, ids.shop), before, "no change yet");
  assert.equal((await db.doc(`journalEntries/stockadjustment__${pend.id}`).get()).exists, false);
  const small = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "lost", change: -4, description: "Under the limit" });
  assert.equal(small.status, "applied");
  const direct = await ok("createStockAdjustment", "approver", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "internal_use", change: -5, description: "Display pairs" });
  assert.equal(direct.status, "applied", "an approver enters a large adjustment directly");
  const left = await onHand(ids.p1, ids.shop);
  assert.equal(left, before - 9);
  assert.equal((await call("decideStockAdjustment", "clerk", { id: pend.id, decision: "approve" })).status, 403);
  const rej = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "lost", change: -5, description: "Second box" });
  assert.equal((await ok("decideStockAdjustment", "approver", { id: rej.id, decision: "reject", note: "Count first" })).status, "rejected");
  assert.equal(await onHand(ids.p1, ids.shop), left, "a rejected adjustment never moves stock");
  const done = await ok("decideStockAdjustment", "approver", { id: pend.id, decision: "approve", note: "Checked" });
  assert.equal(done.status, "applied");
  assert.equal(await onHand(ids.p1, ids.shop), left - 6);
  const a = await get(`stockAdjustments/${pend.id}`);
  assert.deepEqual([a.previousQty, a.newQty, a.decidedBy, a.status], [left, left - 6, "inv-a", "applied"], "previous quantity is the stock when it was applied");
  assert.equal((await ok("decideStockAdjustment", "approver", { id: pend.id, decision: "approve" })).existing, true, "deciding twice applies once");
  assert.equal((await journalCount(pend.id)), 1);
  // Approving re-checks the stock: if it is no longer there, the approval is refused.
  const late = await ok("createStockAdjustment", "clerk", { idempotencyKey: key(), productId: ids.p2.productId, variantId: ids.p2.variantId, warehouseId: ids.shop, reason: "lost", change: -6, description: "Late one" });
  await ok("createStockAdjustment", "approver", { idempotencyKey: key(), productId: ids.p2.productId, variantId: ids.p2.variantId, warehouseId: ids.shop, reason: "correction", change: -8, description: "Recount" });
  const refused = await call("decideStockAdjustment", "approver", { id: late.id, decision: "approve" });
  assert.equal(refused.status, 400, "only 2 left now");
  assert.equal(await onHand(ids.p2, ids.shop), 2);
  await ok("saveInventorySettings", "approver", { lowStock: 3, slowDays: 60, deadDays: 180, adjustApprovalUnits: 0, adjustApprovalValue: 0 });
});
const journalCount = async (id) => (await db.collection("journalEntries").where("sourceId", "==", id).get()).size;

test("cost revaluation changes the average cost, posts the difference on the pairs on hand once, and keeps the history", async () => {
  const onHandNow = (await get(`inventory/${ids.p2.productId}__${ids.p2.variantId}`)).totalOnHand;
  const inv0 = await net("1200");
  const body = { idempotencyKey: key(), productId: ids.p2.productId, variantId: ids.p2.variantId, newCost: 60000, reason: "Supplier invoice was Rs 600" };
  const r = await ok("adjustVariantCost", "approver", body);
  assert.equal((await ok("adjustVariantCost", "approver", body)).existing, true);
  assert.deepEqual([r.costBefore, r.costAfter, r.onHand, r.value], [50000, 60000, onHandNow, 10000 * onHandNow]);
  assert.equal((await get(`variantCosts/${ids.p2.productId}__${ids.p2.variantId}`)).costPrice, 60000);
  assert.deepEqual(await lines(`costrevaluation__${r.id}`), [["1200", 10000 * onHandNow, 0], ["5030", 0, 10000 * onHandNow]]);
  assert.equal((await net("1200")) - inv0, 10000 * onHandNow);
  const hist = await get(`variantCostHistory/${r.id}`);
  assert.deepEqual([hist.type, hist.costBefore, hist.costAfter, hist.reason], ["revaluation", 50000, 60000, "Supplier invoice was Rs 600"]);
  assert.equal((await call("adjustVariantCost", "approver", { ...body, idempotencyKey: key() })).status, 400, "already that cost");
});

test("transfers: request, dispatch, partial receiving with damaged and missing pairs; stock is never duplicated or lost; a shortfall is written off at cost", async () => {
  await receiveStock(ids.p1, 10, 100000, ids.shop);
  const total = async () => (await onHand(ids.p1, ids.shop)) + (await onHand(ids.p1, ids.store));
  const startTotal = await total();
  const t = await transfers.saveTransfer(schemas.saveTransferInput.parse({ fromWarehouseId: ids.shop, toWarehouseId: ids.store, note: "Restock the back", lines: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 6 }] }), STAFF);
  assert.equal((await ok("requestTransfer", "mover", { id: t.id })).status, "requested");
  assert.equal((await get(`stockTransfers/${t.id}`)).status, "requested");
  assert.equal(await total(), startTotal, "requesting moves nothing");
  assert.equal((await call("requestTransfer", "mover", { id: t.id })).status, 400, "requested twice");
  await transfers.sendTransfer({ id: t.id }, STAFF);
  assert.equal(await total(), startTotal - 6, "the pairs are on the transfer: in no warehouse");
  const k = key();
  const lineIn = (over) => ({ idempotencyKey: k, id: t.id, lines: [{ lineIndex: 0, receivedQty: 3, damagedQty: 1, missingQty: 0 }], ...over });
  assert.equal((await call("receiveTransferLines", "mover", lineIn({ lines: [{ lineIndex: 0, receivedQty: 7, damagedQty: 0, missingQty: 0 }] }))).status, 400, "more than was sent");
  const cost = (await get(`variantCosts/${ids.p1.productId}__${ids.p1.variantId}`)).costPrice;
  const part = await ok("receiveTransferLines", "mover", lineIn({}));
  assert.deepEqual([part.status, part.lossUnits, part.lossValue], ["partially_received", 1, cost]);
  assert.equal((await ok("receiveTransferLines", "mover", lineIn({}))).existing, true, "the same delivery sent twice counts once");
  assert.equal(await onHand(ids.p1, ids.store), 3);
  const tr = await get(`stockTransfers/${t.id}`);
  assert.deepEqual([tr.status, tr.lines[0].receivedQty, tr.lines[0].damagedQty, tr.lines[0].missingQty, tr.receipts.length], ["partially_received", 3, 1, 0, 1]);
  assert.deepEqual(await lines(`stockadjustment__${t.id}_${k}_0`), [["5030", cost, 0], ["1200", 0, cost]], "the damaged pair is written off at cost (the pairs had already left the source)");
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "stockadjustment").get()).docs.filter((d) => d.id.includes(t.id)).length, 1, "moving stock between warehouses itself posts nothing");
  assert.equal((await call("saveTransfer", "mover", {})).status, 400);
  const k2 = key();
  const rest = await ok("receiveTransferLines", "mover", { idempotencyKey: k2, id: t.id, lines: [{ lineIndex: 0, receivedQty: 1, damagedQty: 0, missingQty: 1 }] });
  assert.equal(rest.status, "received", "3 + 1 damaged + 1 + 1 missing = all 6 accounted for");
  assert.equal(await onHand(ids.p1, ids.store), 4);
  assert.equal(await total(), startTotal - 2, "nothing duplicated: what is missing is exactly the 2 written-off pairs");
  assert.equal((await call("receiveTransferLines", "mover", { idempotencyKey: key(), id: t.id, lines: [{ lineIndex: 0, receivedQty: 1, damagedQty: 0, missingQty: 0 }] })).status, 400, "nothing left to receive");
  assert.equal((await get(`stockTransfers/${t.id}`)).lossValue, 2 * cost);
  // The older all-at-once receive still works, once.
  const t2 = await transfers.saveTransfer(schemas.saveTransferInput.parse({ fromWarehouseId: ids.shop, toWarehouseId: ids.store, lines: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 2 }] }), STAFF);
  await transfers.sendTransfer({ id: t2.id }, STAFF);
  await transfers.receiveTransfer({ id: t2.id }, STAFF);
  await assert.rejects(transfers.receiveTransfer({ id: t2.id }, STAFF), /already received/);
  assert.equal(await onHand(ids.p1, ids.store), 6);
  assert.deepEqual((await get(`stockTransfers/${t2.id}`)).lines.map((l) => [l.receivedQty, l.damagedQty]), [[2, 0]]);
  // A request can be cancelled; once dispatched it can't.
  const t3 = await transfers.saveTransfer(schemas.saveTransferInput.parse({ fromWarehouseId: ids.shop, toWarehouseId: ids.store, lines: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }] }), STAFF);
  await transfers.requestTransfer({ id: t3.id }, STAFF);
  await transfers.cancelTransfer({ id: t3.id }, STAFF);
  assert.equal((await get(`stockTransfers/${t3.id}`)).status, "cancelled");
  ids.xfer = t.id;
});

test("physical counts: one open count per warehouse; applying changes stock by the counted difference so newer movements are kept; applied once; journals at cost", async () => {
  const start = await ok("startStockCount", "counter", { idempotencyKey: key(), warehouseId: ids.shop, name: "Monthly count" });
  assert.match(start.number, /^CNT-\d{6}$/);
  assert.ok(start.lines >= 3, "every variant the system says is in the warehouse is listed");
  assert.equal((await call("startStockCount", "counter", { idempotencyKey: key(), warehouseId: ids.shop })).status, 400, "a second count of the same warehouse can't open");
  const other = await ok("startStockCount", "counter", { idempotencyKey: key(), warehouseId: ids.store, prefill: false });
  assert.equal(other.lines, 0);
  const sys1 = await onHand(ids.p1, ids.shop);
  const sys2 = await onHand(ids.p2, ids.shop);
  const c1 = await ok("saveStockCountLine", "counter", { sessionId: start.id, productId: ids.p1.productId, variantId: ids.p1.variantId, countedQty: sys1 - 2 });
  assert.deepEqual([c1.systemQty, c1.variance], [sys1, -2]);
  const c2 = await ok("saveStockCountLine", "counter", { sessionId: start.id, productId: ids.p2.productId, variantId: ids.p2.variantId, countedQty: sys2 + 1 });
  assert.equal(c2.variance, 1);
  assert.equal((await call("saveStockCountLine", "counter", { sessionId: start.id, productId: ids.p1.productId, variantId: ids.p1.variantId, countedQty: -1 })).status, 400);
  assert.equal((await call("applyStockCount", "approver", { id: start.id })).status, 400, "not approved yet");
  // A sale-like movement happens AFTER p1 was counted.
  await ok("createStockAdjustment", "approver", { idempotencyKey: key(), productId: ids.p1.productId, variantId: ids.p1.variantId, warehouseId: ids.shop, reason: "lost", change: -3, description: "Went after the count" });
  const submitted = await ok("submitStockCount", "counter", { id: start.id });
  assert.deepEqual([submitted.summary.counted, submitted.summary.withVariance, submitted.summary.shortUnits, submitted.summary.overUnits], [2, 2, 2, 1]);
  assert.equal((await call("saveStockCountLine", "counter", { sessionId: start.id, productId: ids.p1.productId, variantId: ids.p1.variantId, countedQty: 1 })).status, 400, "no changes once submitted");
  assert.equal((await call("decideStockCount", "counter", { id: start.id, decision: "approve" })).status, 403);
  await ok("decideStockCount", "approver", { id: start.id, decision: "approve", note: "OK" });
  const inv1Before = await net("1200");
  const applied = await ok("applyStockCount", "approver", { id: start.id });
  assert.deepEqual([applied.status, applied.flagged], ["applied", 0]);
  assert.equal(await onHand(ids.p1, ids.shop), sys1 - 3 - 2, "the sale after the count is kept: stock = now (after the sale) + the counted difference");
  assert.equal(await onHand(ids.p2, ids.shop), sys2 + 1);
  const cost1 = (await get(`variantCosts/${ids.p1.productId}__${ids.p1.variantId}`)).costPrice;
  const cost2 = (await get(`variantCosts/${ids.p2.productId}__${ids.p2.variantId}`)).costPrice;
  assert.equal((await net("1200")) - inv1Before, -2 * cost1 + cost2, "a short count is written off and an over count is a gain, at cost");
  assert.equal((await ok("applyStockCount", "approver", { id: start.id })).applied, 0, "applying again changes nothing");
  assert.equal(await onHand(ids.p1, ids.shop), sys1 - 5);
  const s = await get(`stockCounts/${start.id}`);
  assert.deepEqual([s.status, s.selfApproved, s.history.map((h) => h.action)], ["applied", false, ["started", "submitted", "approved", "applied"]]);
  const mv = (await db.collection("stockMovements").where("sourceId", "==", start.id).get()).docs.map((d) => d.data());
  assert.deepEqual(mv.map((m) => [m.reason, m.sourceType]).sort(), [["count", "stock_count"], ["count", "stock_count"]]);
  assert.equal((await db.doc(`stockCountLocks/${ids.shop}`).get()).exists, false, "the warehouse can be counted again");
  // Rejected and cancelled counts release the warehouse and change nothing.
  const again = await ok("startStockCount", "counter", { idempotencyKey: key(), warehouseId: ids.shop });
  await ok("saveStockCountLine", "counter", { sessionId: again.id, productId: ids.p1.productId, variantId: ids.p1.variantId, countedQty: 0 });
  await ok("submitStockCount", "counter", { id: again.id });
  await ok("decideStockCount", "approver", { id: again.id, decision: "reject", note: "Count again" });
  assert.equal(await onHand(ids.p1, ids.shop), sys1 - 5);
  const third = await ok("startStockCount", "counter", { idempotencyKey: key(), warehouseId: ids.shop, prefill: false });
  assert.equal((await call("submitStockCount", "counter", { id: third.id })).status, 400, "an empty count can't be submitted");
  await ok("cancelStockCount", "counter", { id: third.id });
  assert.equal((await db.doc(`stockCountLocks/${ids.shop}`).get()).exists, false);
  await ok("applyStockCount", "approver", { id: start.id });
  ids.countId = start.id;
});

test("a counted line that can no longer be applied is flagged for a person instead of forcing stock negative", async () => {
  const p = ids.p3;
  const cnt = await ok("startStockCount", "approver", { idempotencyKey: key(), warehouseId: ids.shop, prefill: false });
  const sys = await onHand(p, ids.shop);
  await ok("saveStockCountLine", "approver", { sessionId: cnt.id, productId: p.productId, variantId: p.variantId, countedQty: 0 });
  await ok("createStockAdjustment", "approver", { idempotencyKey: key(), productId: p.productId, variantId: p.variantId, warehouseId: ids.shop, reason: "lost", change: -(sys - 1), description: "Went after the count" });
  await ok("submitStockCount", "approver", { id: cnt.id });
  await ok("decideStockCount", "approver", { id: cnt.id, decision: "approve" });
  const r = await ok("applyStockCount", "approver", { id: cnt.id });
  assert.deepEqual([r.status, r.flagged], ["applied", 1]);
  assert.equal(await onHand(p, ids.shop), 1, "left alone: counting 0 would have needed −" + sys + " but only 1 is there");
  assert.equal((await get(`stockCounts/${cnt.id}`)).flagged, 1);
  assert.equal((await get(`stockCounts/${cnt.id}`)).selfApproved, true, "an approver who ran the count is allowed, and it is recorded");
});

test("concurrent stock changes never go negative or double-apply", async () => {
  const p = await makeVariant("Racer", "racer", "RC-1");
  await receiveStock(p, 5, 80000, ids.shop);
  const results = await Promise.all(Array.from({ length: 4 }, () => adjust("approver", p, { reason: "lost", change: -3, description: "Race" })));
  const okCount = results.filter((x) => x.status === 200).length;
  assert.equal(okCount, 1, "only one −3 fits in 5");
  assert.equal(await onHand(p, ids.shop), 2);
  assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 400 || x.status === 409));
  assert.equal((await db.collection("stockAdjustments").where("productId", "==", p.productId).get()).size, 1, "refused adjustments leave no record");
  // Two simultaneous apply requests for the same count apply each line once.
  const cnt = await ok("startStockCount", "approver", { idempotencyKey: key(), warehouseId: ids.shop, prefill: false });
  await ok("saveStockCountLine", "approver", { sessionId: cnt.id, productId: p.productId, variantId: p.variantId, countedQty: 1 });
  await ok("submitStockCount", "approver", { id: cnt.id });
  await ok("decideStockCount", "approver", { id: cnt.id, decision: "approve" });
  await Promise.all([call("applyStockCount", "approver", { id: cnt.id }), call("applyStockCount", "approver", { id: cnt.id })]);
  assert.equal(await onHand(p, ids.shop), 1, "−1 applied once, not twice");
  assert.equal((await db.collection("stockMovements").where("sourceId", "==", cnt.id).get()).size, 1);
  ids.p4 = p;
});

test("alerts: out of stock, low stock, reorder level, overstock, slow-moving and dead stock, with configurable thresholds", async () => {
  await ok("setStockPolicy", "approver", { productId: ids.p2.productId, variantId: ids.p2.variantId, minStock: 2, reorderLevel: 20, maxStock: 2, locations: { [ids.shop]: "Shelf A-3" } });
  await ok("saveInventorySettings", "approver", { lowStock: 3, slowDays: 60, deadDays: 120, adjustApprovalUnits: 0, adjustApprovalValue: 0 });
  assert.equal((await call("saveInventorySettings", "approver", { lowStock: 3, slowDays: 60, deadDays: 30, adjustApprovalUnits: 0, adjustApprovalValue: 0 })).status, 400, "dead stock days must be more than slow days");
  assert.equal((await call("setStockPolicy", "approver", { productId: ids.p2.productId, variantId: ids.p2.variantId, minStock: 10, reorderLevel: 5, maxStock: null, locations: {} })).status, 400, "reorder level below the minimum");
  assert.equal((await call("setStockPolicy", "approver", { productId: ids.p2.productId, variantId: ids.p2.variantId, minStock: 1, reorderLevel: null, maxStock: null, locations: { ghost: "X" } })).status, 400, "unknown warehouse");
  const emptied = await makeVariant("Gone", "gone", "GN-1");
  await receiveStock(emptied, 1, 10000, ids.shop);
  await adjust("approver", emptied, { reason: "lost", change: -1, description: "Sold out" });
  const al = await ok("inventoryAlerts", "reader", {});
  const kinds = (variant) => al.alerts.filter((a) => a.variantId === variant.variantId && a.productId === variant.productId).map((a) => a.kind).sort();
  assert.deepEqual(kinds(emptied), ["out"]);
  const p2 = (await get(`inventory/${ids.p2.productId}__${ids.p2.variantId}`)).totalOnHand;
  assert.ok(p2 > 2, "p2 has several pairs");
  assert.ok(kinds(ids.p2).includes("reorder"), "20 is the reorder level");
  assert.ok(kinds(ids.p2).includes("over"), "more than the maximum of 2");
  assert.ok(!kinds(ids.p2).includes("low"));
  assert.ok(kinds(ids.p4).includes("low"), "1 left is at or under the global alert of 3");
  assert.ok(al.alerts.every((a) => a.detail));
  assert.deepEqual(al.counts.out >= 1 && al.counts.low >= 1 && al.counts.reorder >= 1 && al.counts.over >= 1, true);
  // Slow: stock on hand, recent receipt but no sale. Dead: no movement at all for the dead-stock period.
  assert.ok(kinds(ids.p2).includes("slow"), "p2 moved recently but hasn't sold in 60 days");
  assert.ok(!kinds(ids.p2).includes("dead"));
  const old = Date.now() - 200 * 86400000;
  for (const d of (await db.collection("stockMovements").where("inventoryId", "==", `${ids.p2.productId}__${ids.p2.variantId}`).get()).docs) await d.ref.update({ at: Timestamp.fromMillis(old) });
  const al2 = await ok("inventoryAlerts", "reader", {});
  assert.ok(al2.alerts.some((a) => a.variantId === ids.p2.variantId && a.kind === "dead"), "no movement for 200 days");
  await ok("saveInventorySettings", "approver", { lowStock: 100, slowDays: 60, deadDays: 120, adjustApprovalUnits: 0, adjustApprovalValue: 0 });
  assert.ok((await ok("inventoryAlerts", "reader", {})).alerts.some((a) => a.kind === "low" && a.variantId === ids.p1.variantId), "a higher threshold raises more alerts");
  await ok("saveInventorySettings", "approver", { lowStock: 3, slowDays: 60, deadDays: 120, adjustApprovalUnits: 0, adjustApprovalValue: 0 });
});

test("valuation at weighted average cost agrees with the inventory account in the books; by warehouse, product and variant", async () => {
  const v = await ok("inventoryValuation", "reader", { from: "2020-01-01", to: new Date().toISOString().slice(0, 10) });
  const rows = (await ok("inventoryItems", "reader", {})).items;
  assert.equal(v.total, rows.reduce((n, r) => n + (r.cost === null ? 0 : r.onHand * r.cost), 0));
  assert.equal(v.byWarehouse.reduce((n, w) => n + w.value, 0), v.total, "warehouses add up to the total");
  assert.equal(v.byWarehouse.reduce((n, w) => n + w.units, 0), v.units);
  assert.ok(v.unitsWithoutCost >= 1, "the boot with no recorded cost is listed, valued at zero");
  assert.equal(v.ledger.balanceNow, await net("1200"));
  assert.equal(v.ledger.difference, 0, "valuation = the inventory account: receipts, write-offs, counts, transfer losses and revaluations all posted consistently");
  const r = (name) => rows.find((x) => x.productName === name);
  assert.equal(r("Oxford One").value, r("Oxford One").onHand * 100000);
  assert.equal(r("Loafer Two").cost, 60000, "the revalued cost");
  const rep = await ok("inventoryReport", "reader", { report: "valuation", from: "2020-01-01", to: new Date().toISOString().slice(0, 10) });
  assert.equal(rep.tables[0].totals.value, v.total);
  assert.equal(rep.tables[1].rows.at(-1).amount, 0, "the report shows the reconciliation difference");
  const tb = await accReports.trialBalance({ from: "2000-01-01", to: new Date().toISOString().slice(0, 10) });
  assert.equal(tb.balanced, true);
});

test("barcodes: valid unique EAN-13 codes, one variant per code, lookup by scan, and the POS finds them", async () => {
  const a = await ok("assignBarcode", "approver", { productId: ids.p1.productId, variantId: ids.p1.variantId });
  assert.ok(isEan13(a.barcode) && a.barcode.startsWith("200"), a.barcode);
  const b = await ok("assignBarcode", "approver", { productId: ids.p2.productId, variantId: ids.p2.variantId });
  assert.notEqual(a.barcode, b.barcode);
  assert.equal((await call("assignBarcode", "approver", { productId: ids.p3.productId, variantId: ids.p3.variantId, barcode: a.barcode })).status, 409, "a duplicate barcode is refused");
  assert.equal((await call("assignBarcode", "approver", { productId: ids.p3.productId, variantId: ids.p3.variantId, barcode: "4006381333932" })).status, 400, "wrong check digit");
  const own = await ok("assignBarcode", "approver", { productId: ids.p3.productId, variantId: ids.p3.variantId, barcode: "4006381333931" });
  assert.equal(own.barcode, "4006381333931", "a manufacturer's own code is accepted");
  assert.equal((await ok("assignBarcode", "approver", { productId: ids.p1.productId, variantId: ids.p1.variantId, barcode: a.barcode })).barcode, a.barcode, "re-assigning the same code to the same variant is fine");
  const c = await ok("assignBarcode", "approver", { productId: ids.p1.productId, variantId: ids.p1.variantId, barcode: "12345670" });
  assert.equal(c.previous, a.barcode);
  assert.equal((await db.doc(`barcodes/${a.barcode}`).get()).exists, false, "the old code is released");
  assert.equal((await get(`products/${ids.p1.productId}/variants/${ids.p1.variantId}`)).barcode, "12345670");
  const hit = await ok("lookupBarcode", "reader", { code: b.barcode });
  assert.deepEqual([hit.found, hit.product, hit.productId, hit.via, hit.onHand > 0], [true, "Loafer Two", ids.p2.productId, "barcode", true]);
  assert.equal((await ok("lookupBarcode", "reader", { code: "OX-1-BLACK-42" })).via, "sku", "a scanned SKU still works");
  assert.equal((await ok("lookupBarcode", "reader", { code: "9999999999999" })).found, false);
  const hits = await pos.posSearch({ q: b.barcode, warehouseId: ids.shop, exact: true });
  assert.deepEqual([hits.match, hits.products[0].variants.length, hits.products[0].variants[0].barcode], ["sku", 1, b.barcode]);
  const bySku = await pos.posSearch({ q: "lf-2-black-42", warehouseId: ids.shop, exact: true });
  assert.equal(bySku.match, "sku", "SKU scanning in the POS is unchanged");
  assert.deepEqual((await Promise.all([ok("assignBarcode", "approver", { productId: ids.p4.productId, variantId: ids.p4.variantId }), ok("assignBarcode", "approver", { productId: ids.p4.productId, variantId: ids.p4.variantId })])).length, 2);
  const codes = (await db.collection("barcodes").get()).docs.map((d) => d.id);
  assert.equal(new Set(codes).size, codes.length);
});

test("the dashboard and reports add up the real records", async () => {
  const d = await ok("inventoryDashboard", "reader", {});
  const items = (await ok("inventoryItems", "reader", {})).items;
  assert.deepEqual([d.products, d.variants], [new Set(items.map((i) => i.productId)).size, items.length]);
  assert.equal(d.onHand, items.reduce((n, i) => n + i.onHand, 0));
  assert.equal(d.reserved, items.reduce((n, i) => n + i.reserved, 0));
  assert.equal(d.available, d.onHand - d.reserved);
  assert.equal(d.value, items.reduce((n, i) => n + (i.cost === null ? 0 : i.onHand * i.cost), 0));
  assert.equal(d.warehouses.reduce((n, w) => n + w.onHand, 0), d.onHand, "warehouse-wise stock adds up");
  assert.equal(d.warehouses.reduce((n, w) => n + w.value, 0), d.value);
  assert.equal(d.recentMovements.length, 10);
  const damaged = (await db.collection("stockAdjustments").where("reason", "==", "damaged").get()).docs.filter((x) => x.data().status === "applied").reduce((n, x) => n + Math.abs(x.data().changeQty), 0);
  assert.equal(d.damagedWrittenOff, damaged + 1, "damaged adjustments plus the pair that arrived damaged on a transfer");
  assert.equal(d.missingInTransfer, 1);
  assert.equal(d.outOfStock, (await ok("inventoryAlerts", "reader", {})).counts.out);
  const range = { from: "2020-01-01", to: new Date().toISOString().slice(0, 10) };
  const rep = (report, extra = {}) => ok("inventoryReport", "reader", { report, ...range, ...extra });
  const sum = await rep("summary");
  assert.equal(sum.tables[0].totals.onHand, d.onHand);
  assert.equal(sum.tables[0].totals.value, d.value);
  assert.equal(sum.tables[1].totals.onHand, d.onHand, "by product adds up to the same stock");
  const size = await rep("size");
  assert.equal(size.tables[0].totals.onHand, d.onHand);
  assert.ok(size.tables[0].rows.some((r) => r.name === "EU 42"));
  assert.equal((await rep("colour")).tables[0].rows[0].name, "Black");
  const prod = (await rep("product")).tables[0];
  assert.equal(prod.rows.length, items.length);
  assert.ok(prod.rows.some((r) => r.product === "Loafer Two" && r.location.includes("Shelf A-3")), "storage locations are reported");
  const whOnly = await rep("warehouse", { warehouseId: ids.store });
  assert.equal(whOnly.tables.length, 1);
  assert.equal(whOnly.tables[0].totals.onHand, await onHand(ids.p1, ids.store));
  const mv = (await rep("movements")).tables[0];
  assert.ok(mv.totals.in > 0 && mv.totals.out > 0);
  assert.equal(mv.rows.reduce((n, r) => n + r.in, 0), mv.totals.in);
  const adjRep = (await rep("adjustments")).tables[0];
  assert.equal(adjRep.rows.length, (await db.collection("stockAdjustments").get()).size);
  assert.ok(adjRep.rows.some((r) => r.status === "pending" || r.status === "rejected"));
  const trRep = (await rep("transfers")).tables[0];
  assert.ok(trRep.rows.some((r) => r.status === "Received" && r.damaged === 1 && r.missing === 1 && r.lossValue === 200000));
  const cnt = await rep("counts");
  assert.ok(cnt.tables[0].rows.some((r) => r.status === "applied" && r.variances === 2));
  assert.ok(cnt.tables[1].rows.some((r) => r.variance === -2 && r.applied === "Applied"));
  assert.ok((await rep("low")).tables[0].rows.length >= 1);
  assert.ok((await rep("slow")).tables[0].rows.some((r) => r.kind === "Dead stock"));
  assert.equal((await call("inventoryReport", "reader", { report: "summary", from: "2026-02-01", to: "2026-01-01" })).status, 400, "end before start");
  const empty = (await ok("inventoryReport", "reader", { report: "movements", from: "2001-01-01", to: "2001-01-31" })).tables[0];
  assert.equal(empty.rows.length, 0, "no invented rows for an empty period");
});

test("accounting: every stock journal is balanced and unique, and stock changes never post twice", async () => {
  const js = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(js.every((j) => j.totalDebit === j.totalCredit && j.status === "posted"));
  const stockJ = js.filter((j) => ["stockadjustment", "costrevaluation"].includes(j.sourceType));
  assert.ok(stockJ.length >= 8);
  assert.equal(new Set(stockJ.map((j) => j.id)).size, stockJ.length);
  for (const a of (await db.collection("stockAdjustments").get()).docs) {
    const d = a.data();
    const expected = d.status === "applied" && d.value > 0 ? 1 : 0;
    assert.equal(js.filter((j) => j.id === `stockadjustment__${a.id}`).length, expected, d.number);
  }
  assert.equal((await db.collection("accountingExceptions").get()).size, 0);
  // Moving stock between warehouses posts nothing: transfer 2 (all received) has no journal.
  const t2 = (await db.collection("stockTransfers").where("status", "==", "received").get()).docs.find((d) => d.data().lossValue === undefined || d.data().lossValue === 0);
  assert.equal(js.filter((j) => t2 && j.id.includes(t2.id)).length, 0);
});
