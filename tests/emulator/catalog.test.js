/**
 * Catalogue, products, variants and stock against the emulators (`npm run test:emulator`); photos are tested in images.test.js.
 * Catalogue entries below are test fixtures in a throwaway "demo-" database, not store data.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db } = await import("../../functions/lib/admin.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const ACTOR = "staff-test";
const ids = {};

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), ACTOR)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, ACTOR)).id;
  ids.brown = (await catalog.saveCatalogItem("color", { name: "Brown", hex: "#5a3a26" }, ACTOR)).id;
  ids.s41 = (await catalog.saveCatalogItem("size", { system: "EU", value: "41", sortOrder: 41 }, ACTOR)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, ACTOR)).id;
  await db.doc("settings/private").set({ lowStockThreshold: 2, notifyLowStock: true, orderPrefix: "IS" });
});

const productInput = (over = {}) => schemas.saveProductInput.parse({ name: "Test Oxford", slug: "test-oxford", categoryId: ids.cat, sku: "T-OX-1", ...over });

test("catalogue: duplicate slugs, colours and sizes are refused; nesting is one level", async () => {
  await assert.rejects(catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal 2", slug: "formal" }), ACTOR), (e) => e.code === "already-exists");
  await assert.rejects(catalog.saveCatalogItem("color", { name: "Black", hex: "#000000" }, ACTOR), (e) => e.code === "already-exists");
  await assert.rejects(catalog.saveCatalogItem("size", { system: "EU", value: "41", sortOrder: 1 }, ACTOR), (e) => e.code === "already-exists");
  const child = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Oxfords", slug: "oxfords", parentId: ids.cat }), ACTOR)).id;
  await assert.rejects(catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Deep", slug: "deep", parentId: child }), ACTOR), (e) => e.code === "invalid-argument");
  await assert.rejects(catalog.deleteCatalogItem("category", ids.cat, ACTOR), (e) => e.code === "failed-precondition", "has a sub-category");
});

test("products start as drafts with an empty summary; SKUs and slugs are unique", async () => {
  ids.p = (await products.saveProduct(productInput(), ACTOR)).id;
  const p = (await db.doc(`products/${ids.p}`).get()).data();
  assert.equal(p.status, "draft");
  assert.deepEqual(p.images, []);
  assert.equal(p.summary.inStock, false);
  assert.equal(p.summary.minPrice, null, "no invented price");
  await assert.rejects(products.saveProduct(productInput({ slug: "other" }), ACTOR), (e) => e.code === "already-exists" && /SKU/.test(e.message));
  await assert.rejects(products.saveProduct(productInput({ sku: "T-OX-2" }), ACTOR), (e) => e.code === "already-exists" && /web address/.test(e.message));
  // Renaming its own SKU frees the old one.
  await products.saveProduct(productInput({ id: ids.p, sku: "T-OX-9" }), ACTOR);
  assert.equal((await db.doc("skus/T-OX-1").get()).exists, false);
  assert.equal((await db.doc("skus/T-OX-9").get()).data().owner, `product:${ids.p}`);
});

test("variants: one per colour × size, generated SKUs, stock starts at 0, cost only with permission", async () => {
  const r = await products.createVariants(
    schemas.createVariantsInput.parse({ productId: ids.p, colorIds: [ids.black, ids.brown], sizeIds: [ids.s41, ids.s42], price: 1950000, costPrice: 1200000 }),
    { actorUid: ACTOR, canEditCost: false },
  );
  assert.deepEqual(r, { created: 4, skipped: 0 });
  const again = await products.createVariants(schemas.createVariantsInput.parse({ productId: ids.p, colorIds: [ids.black], sizeIds: [ids.s41], price: 100 }), { actorUid: ACTOR, canEditCost: false });
  assert.deepEqual(again, { created: 0, skipped: 1 }, "existing combinations are never duplicated");

  ids.v = products.variantKey(ids.black, ids.s41);
  const v = (await db.doc(`products/${ids.p}/variants/${ids.v}`).get()).data();
  assert.equal(v.sku, "T-OX-9-BLACK-41");
  assert.equal(v.available, 0);
  assert.equal(v.sizeLabel, "EU 41");
  assert.equal((await db.doc(`inventory/${ids.p}__${ids.v}`).get()).data().onHand, 0);
  assert.equal((await db.doc(`variantCosts/${ids.p}__${ids.v}`).get()).exists, false, "no cost written without costs.read");

  await products.saveVariant(
    schemas.saveVariantInput.parse({ productId: ids.p, variantId: ids.v, colorId: ids.black, sizeId: ids.s41, sku: v.sku, price: 1950000, salePrice: 1750000, costPrice: 1200000 }),
    { actorUid: ACTOR, canEditCost: true },
  );
  assert.equal((await db.doc(`variantCosts/${ids.p}__${ids.v}`).get()).data().costPrice, 1200000);

  const s = (await db.doc(`products/${ids.p}`).get()).data().summary;
  assert.equal(s.minPrice, 1750000, "sale price counts as the lowest price");
  assert.equal(s.maxPrice, 1950000);
  assert.equal(s.onSale, true);
  assert.equal(s.variantCount, 4);
  assert.equal(s.inStock, false, "no stock yet");
  assert.ok(s.keywords.includes("oxford") && s.keywords.includes("black"));
});

test("publishing needs a photo and an active variant", async () => {
  await assert.rejects(products.setProductStatus(ids.p, "published", ACTOR), (e) => e.code === "failed-precondition" && /photo/.test(e.message));
});

test("stock: initial stock, removals that would go negative are refused, every change is logged", async () => {
  const adj = (change, reason = "adjustment", note = "Counted shelf") => inventory.adjustStock({ productId: ids.p, variantId: ids.v, change, reason, note }, ACTOR);
  assert.deepEqual(await adj(5, "initial", ""), { onHand: 5, available: 5 });
  await assert.rejects(adj(-6), (e) => e.code === "failed-precondition" && /Only 5 in stock/.test(e.message));
  assert.deepEqual(await adj(-1, "damaged", "Sole split"), { onHand: 4, available: 4 });

  const moves = await db.collection("stockMovements").where("inventoryId", "==", `${ids.p}__${ids.v}`).get();
  assert.equal(moves.size, 2, "the refused change left no record");
  const damaged = moves.docs.map((d) => d.data()).find((m) => m.reason === "damaged");
  assert.deepEqual([damaged.onHandBefore, damaged.onHandAfter, damaged.actorUid, damaged.note], [5, 4, ACTOR, "Sole split"]);

  assert.equal((await db.doc(`products/${ids.p}/variants/${ids.v}`).get()).data().available, 4);
  const s = (await db.doc(`products/${ids.p}`).get()).data().summary;
  assert.equal(s.inStock, true);
  assert.deepEqual(s.sizeIds, [ids.s41], "only sizes with stock are listed for filtering");
});

test("stock never goes negative under parallel removals (transactions)", async () => {
  // 4 in stock; 12 staff remove 1 at the same moment → exactly 4 succeed.
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => inventory.adjustStock({ productId: ids.p, variantId: ids.v, change: -1, reason: "correction", note: "Parallel test" }, ACTOR)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
  assert.equal((await db.doc(`inventory/${ids.p}__${ids.v}`).get()).data().onHand, 0);
});

test("low-stock and sold-out alerts fire once when crossing the line", async () => {
  const notes = async (type) => (await db.collection("notifications").where("type", "==", type).get()).size;
  const soldOutBefore = await notes("stock.out");
  assert.ok(soldOutBefore >= 1, "selling out in the previous test raised an alert");

  await inventory.adjustStock({ productId: ids.p, variantId: ids.v, change: 5, reason: "found", note: "Back room" }, ACTOR);
  const lowBefore = await notes("stock.low");
  await inventory.adjustStock({ productId: ids.p, variantId: ids.v, change: -3, reason: "correction", note: "Recount" }, ACTOR); // 5 → 2 (threshold 2)
  assert.equal(await notes("stock.low"), lowBefore + 1);
  await inventory.adjustStock({ productId: ids.p, variantId: ids.v, change: -1, reason: "correction", note: "Recount" }, ACTOR); // 2 → 1: still low, no repeat
  assert.equal(await notes("stock.low"), lowBefore + 1);
});
