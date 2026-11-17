/**
 * Why the books and the stock valuation differ before go-live, and the procedure that makes them agree
 * (`npm run test:emulator`). Throwaway "demo-" data only: these figures say nothing about the real shop.
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
const insights = await import("../../functions/services/inventoryInsights.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const key = () => randomUUID().replace(/-/g, "");
const ids = {};
const TOKENS = {
  owner: { uid: "own-1", name: "Owner", staff: true, perms: ["*"], auth_time: 9999999999 },
  manager: { uid: "mgr-1", name: "Manager", staff: true, perms: POS_ROLES.pos_manager.permissions, auth_time: 9999999999 },
};
const verifyToken = async (t) => TOKENS[t];
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: { data } }, { verifyToken });
const ok = async (name, token, data) => {
  const r = await call(name, token, data);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1 });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
});

async function product(slug, { stock, cost, price = 1000000 }) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: slug, slug, categoryId: ids.cat, sku: slug.toUpperCase() }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null, costPrice: cost }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
  return { productId, variantId };
}

test("root cause: stock entered on the Inventory screen (initial / damaged / found) is NOT posted to the books", async () => {
  await product("opening-a", { stock: 10, cost: 600000 }); // valued at 6,000,000
  await product("opening-b", { stock: 4, cost: 250000 }); // valued at 1,000,000
  const v = await insights.inventoryValuation();
  assert.equal(v.total, 7000000, "the valuation counts the stock on hand");
  assert.equal(v.ledger.balanceNow, 0, "the books know nothing about it");
  assert.equal(v.ledger.difference, -7000000);
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "stockadjustment").get()).size, 0);
});

test("without an opening entry a sale pushes the inventory account NEGATIVE (the figure seen in the audit)", async () => {
  const p = (ids.c = await product("opening-c", { stock: 2, cost: 500000 }));
  const manager = "manager";
  const reg = (await ok("openRegister", manager, { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).sessionId;
  await ok("posCheckout", manager, { idempotencyKey: key(), sessionId: reg, items: [{ productId: p.productId, variantId: p.variantId, qty: 1 }], tenders: [{ method: "cash", amount: 1000000 }] });
  const v = await insights.inventoryValuation();
  assert.equal(v.ledger.balanceNow, -500000, "cost of the pair sold left an account that never had a balance");
  assert.equal(v.total, 7000000 + 500000, "the valuation of what is still on the shelf");
  await ok("closeRegister", manager, { sessionId: reg, countedCash: 1000000 });
});

test("procedure: post the counted stock value as an opening entry, and the books and the valuation agree from then on", async () => {
  // Opening stock is what was valued BEFORE the sale above: 7,000,000 + 1,000,000 (opening-c, 2 pairs) = 8,000,000 at the cut-off date.
  const date = pktDateKey(new Date(Date.now() - 2 * 86400000));
  const openingValue = 8000000;
  const r = await ok("postOpeningBalances", "owner", { idempotencyKey: key(), date, memo: "Opening stock at cost", lines: [{ accountCode: "1200", debit: openingValue, credit: 0, memo: "Counted stock at weighted-average cost" }, { accountCode: "3010", debit: 0, credit: openingValue }] });
  assert.ok(r.id);
  const after = await insights.inventoryValuation();
  assert.equal(after.ledger.balanceNow, 7500000, "opening 8,000,000 less the 500,000 cost of the pair sold");
  assert.equal(after.total, 7500000, "the valuation of the stock still on the shelf");
  assert.equal(after.ledger.difference, 0, "books and valuation now agree");
});

test("after that, ordinary sales keep them in step", async () => {
  const manager = "manager";
  const reg = (await ok("openRegister", manager, { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).sessionId;
  await ok("posCheckout", manager, { idempotencyKey: key(), sessionId: reg, items: [{ productId: ids.c.productId, variantId: ids.c.variantId, qty: 1 }], tenders: [{ method: "cash", amount: 1000000 }] });
  const v = await insights.inventoryValuation();
  assert.equal(v.ledger.balanceNow, 7000000);
  assert.equal(v.total, 7000000);
  assert.equal(v.ledger.difference, 0, "still in step after another sale");
  await ok("closeRegister", manager, { sessionId: reg, countedCash: 1000000 });
});
