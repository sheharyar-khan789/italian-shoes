/**
 * Warehouses, warehouse-aware stock, transfers, the migration, the catalog snapshot and the incremental summary,
 * against the Firestore emulator (`npm run test:emulator`). Everything below is a test fixture in a throwaway
 * "demo-" database, not store data.
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
const warehouses = await import("../../functions/services/warehouses.js");
const transfers = await import("../../functions/services/transfers.js");
const orders = await import("../../functions/services/orders.js");
const snapshot = await import("../../functions/services/catalogSnapshot.js");
const { runWarehouseMigration } = await import("../../functions/migrations/002-warehouse-inventory.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { effectivePermissions, DEFAULT_ROLES } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};

const TOKENS = {
  manager: { uid: "m-1", staff: true, perms: ["warehouses.manage", "transfers.manage", "inventory.read"], auth_time: 9999999999 },
  viewer: { uid: "v-1", staff: true, perms: ["inventory.read"], auth_time: 9999999999 },
  customer: { uid: "c-1", email: "c@example.com" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

const key = (p) => `${p.productId}__${p.variantId}`;
const inv = async (p) => (await db.doc(`inventory/${key(p)}`).get()).data();
const at = async (p, wid) => (await inv(p)).byWarehouse?.[wid]?.onHand ?? 0;
const movements = async (p) => (await db.collection("stockMovements").where("inventoryId", "==", key(p)).get()).docs.map((d) => d.data());

async function makeProduct(name, slug, sku, { stock = 0, status = "published", price = 1000000 } = {}) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null }), { actorUid: STAFF, canEditCost: false });
  const variantId = products.variantKey(ids.black, ids.s42);
  if (stock) await inventory.adjustStock({ productId, variantId, change: stock, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status, images: [{ id: "i1", isPrimary: true, alt: "", paths: { 400: `products/${productId}/images/i1-400.webp` } }] });
  return { productId, variantId };
}

const newWarehouse = async (name, code, over = {}) => (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name, code, ...over }), STAFF)).id;
const adjust = (p, change, warehouseId, reason = "adjustment") => inventory.adjustStock({ productId: p.productId, variantId: p.variantId, warehouseId, change, reason, note: "test count" }, STAFF);

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  // Staff checks look the account up (to catch disabled or revoked sessions), so the test staff are real emulator accounts.
  for (const uid of ["m-1", "v-1"]) await auth.createUser({ uid }).catch(() => {});
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 1, notifyNewOrders: true, notifyLowStock: true, taxEnabled: false });
  await db.doc("shippingMethods/std").set({ name: "Standard", description: "", estimateText: "", isActive: true });
  await db.collection("shippingRates").add({ methodId: "std", city: "*", charge: 10000, freeOver: null });
});

/* ───────── Permissions and validation ───────── */

test("warehouse and transfer endpoints need their permissions; input is validated on the server", async () => {
  for (const [name, data] of [["saveWarehouse", { name: "Shop", code: "SHOP" }], ["setWarehouseActive", { id: "x", isActive: false }], ["sendTransfer", { id: "x" }]]) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "viewer", data)).status, 403, `${name} staff without the permission`);
  }
  assert.equal((await call("saveWarehouse", "manager", { name: "Shop", code: "!!" })).status, 400, "bad code");
  assert.equal((await call("saveWarehouse", "manager", { name: "S", code: "SHOP" })).status, 400, "name too short");
  assert.equal((await call("saveTransfer", "manager", { fromWarehouseId: "a", toWarehouseId: "a", lines: [{ productId: "p", variantId: "v", qty: 1 }] })).status, 400, "same warehouse");
  assert.equal((await call("saveTransfer", "manager", { fromWarehouseId: "a", toWarehouseId: "b", lines: [] })).status, 400, "no lines");
  assert.equal((await call("saveTransfer", "manager", { fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: "p", variantId: "v", qty: 0 }] })).status, 400, "qty 0");
  const ok = await call("saveWarehouse", "manager", { name: "Back room", code: "back-1" });
  assert.equal(ok.status, 200);
  assert.equal((await db.doc(`warehouses/${ok.body.data.id}`).get()).data().code, "BACK-1", "code is stored in capitals");
  assert.equal((await call("saveWarehouse", "manager", { name: "Another", code: "BACK-1" })).status, 409, "codes are unique");
});

test("the new permissions reach existing roles without rewriting them (additive only)", async () => {
  const oldOwner = { owner: { permissions: DEFAULT_ROLES.owner.permissions.filter((p) => !p.includes("warehouses") && !p.includes("transfers")) } };
  assert.equal(effectivePermissions(["owner"], oldOwner).includes("transfers.manage"), false, "stored list is untouched by effectivePermissions");
  await db.doc("roles/owner").set({ name: "Owner", permissions: oldOwner.owner.permissions, system: true });
  const { loadRoles } = await import("../../functions/services/staff.js");
  const roles = await loadRoles();
  assert.ok(roles.owner.permissions.includes("warehouses.manage") && roles.owner.permissions.includes("transfers.manage"));
  assert.equal((await db.doc("roles/owner").get()).data().permissions.length, oldOwner.owner.permissions.length, "the stored role document is not rewritten");
  await db.doc("roles/owner").delete();
});

/* ───────── Warehouses ───────── */

test("the default warehouse exists in effect, can't be switched off or taken offline", async () => {
  await warehouses.ensureDefaultWarehouse();
  assert.deepEqual(await warehouses.ensureDefaultWarehouse(), { created: false }, "creating it again is harmless");
  await assert.rejects(warehouses.setWarehouseActive({ id: "main", isActive: false }, STAFF), (e) => /default warehouse/.test(e.message));
  await assert.rejects(warehouses.saveWarehouse({ id: "main", name: "Main", code: "MAIN", description: "", address: "", sellsOnline: false }, STAFF), (e) => e.code === "failed-precondition");
});

test("a warehouse can't be switched off while it holds stock or has an open transfer", async () => {
  const p = await makeProduct("Switch Off", "switch-off", "SW-1", { stock: 4 });
  const w = await newWarehouse("Overflow", "OVER");
  await adjust(p, 3, w);
  await assert.rejects(warehouses.setWarehouseActive({ id: w, isActive: false }, STAFF), (e) => /still holds stock/.test(e.message));
  const t = (await transfers.saveTransfer({ fromWarehouseId: w, toWarehouseId: "main", note: "", lines: [{ ...p, qty: 3 }] }, STAFF)).id;
  await transfers.sendTransfer({ id: t }, STAFF);
  await assert.rejects(warehouses.setWarehouseActive({ id: w, isActive: false }, STAFF), (e) => /isn't finished/.test(e.message), "in transit");
  await transfers.receiveTransfer({ id: t }, STAFF);
  assert.equal((await warehouses.setWarehouseActive({ id: w, isActive: false }, STAFF)).isActive, false, "empty and idle: allowed");
  await assert.rejects(adjust(p, 1, w), (e) => /switched off/.test(e.message), "an inactive warehouse takes no new stock");
});

/* ───────── Stock per warehouse ───────── */

test("stock is isolated per warehouse; negative stock is refused; every movement records warehouse and source", async () => {
  const p = await makeProduct("Isolated", "isolated", "ISO-1");
  const shop = await newWarehouse("Shop floor", "SHOP", { sellsOnline: false });
  await adjust(p, 10, "main", "initial");
  await adjust(p, 4, shop, "initial");
  assert.equal(await at(p, "main"), 10);
  assert.equal(await at(p, shop), 4);
  await assert.rejects(adjust(p, -5, shop), (e) => e.code === "failed-precondition" && /Only 4 in stock/.test(e.message), "can't go below zero in THIS warehouse");
  await adjust(p, -3, "main");
  assert.equal(await at(p, shop), 4, "the other warehouse is untouched");
  const d = await inv(p);
  assert.equal(d.totalOnHand, 11);
  assert.equal(d.onHand, 7, "only online-eligible warehouses are counted as available online");
  const m = (await movements(p)).filter((x) => x.warehouseId === shop);
  assert.equal(m.length, 1);
  assert.equal(m[0].quantity, 4);
  assert.equal(m[0].change, 4);
  assert.equal(m[0].sourceType, "adjustment");
  assert.ok(m[0].at && m[0].actorUid === STAFF && m[0].onHandBefore === 0 && m[0].onHandAfter === 4);
  assert.equal((await db.doc(`products/${p.productId}/variants/${p.variantId}`).get()).data().available, 7, "the variant's public count follows the online warehouses");
});

test("a legacy document (no warehouse breakdown) counts as default-warehouse stock and keeps working", async () => {
  const p = await makeProduct("Legacy", "legacy", "LEG-1");
  await db.doc(`inventory/${key(p)}`).update({ onHand: 6, reserved: 0, byWarehouse: FieldValue.delete(), available: FieldValue.delete(), totalOnHand: FieldValue.delete() });
  await db.doc(`products/${p.productId}/variants/${p.variantId}`).update({ available: 6 });
  await adjust(p, 2, "main");
  const d = await inv(p);
  assert.deepEqual(d.byWarehouse, { main: { onHand: 8, reserved: 0 } });
  assert.equal(d.onHand, 8);
});

/* ───────── Online checkout compatibility ───────── */

const draft = (p, qty = 1) =>
  schemas.placeOrderSchema.parse({
    idempotencyKey: randomUUID(),
    items: [{ productId: p.productId, variantId: p.variantId, qty }],
    customer: { name: "Test Customer", phone: "0300 1234567" },
    address: { name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near the park" },
    shippingMethodId: "std",
    paymentMethod: "cod",
    termsAccepted: true,
  });

test("online orders sell only from online warehouses, cancellations return to the same warehouse", async () => {
  const p = await makeProduct("Online", "online", "ON-1");
  const second = await newWarehouse("Second online", "ONL2");
  const shop = await newWarehouse("Counter", "CNTR", { sellsOnline: false });
  await adjust(p, 2, "main", "initial");
  await adjust(p, 3, second, "initial");
  await adjust(p, 9, shop, "initial");
  assert.equal((await inv(p)).onHand, 5, "the counter's 9 pairs are not for sale online");
  await assert.rejects(orders.placeOrder(draft(p, 6), { uid: "cust-1" }), (e) => /Only 5 left/.test(e.message), "can't oversell from the shop's stock");
  const o = await orders.placeOrder(draft(p, 4), { uid: "cust-1" });
  assert.equal(await at(p, "main"), 0, "default warehouse first");
  assert.equal(await at(p, second), 1);
  assert.equal(await at(p, shop), 9, "the counter is untouched");
  assert.deepEqual((await db.doc(`orders/${o.orderId}/stock/allocations`).get()).data().lines[0].allocations, [{ warehouseId: "main", qty: 2 }, { warehouseId: second, qty: 2 }], "allocation is kept privately for the order");
  await orders.updateOrderStatus({ orderId: o.orderId, status: "cancelled", note: "test" }, { actorUid: STAFF });
  assert.equal(await at(p, "main"), 2, "put back where it came from");
  assert.equal(await at(p, second), 3);
  assert.equal((await inv(p)).onHand, 5);
  const moves = (await movements(p)).filter((m) => m.orderId === o.orderId);
  assert.ok(moves.every((m) => m.sourceType === "order" && m.sourceId === o.orderId && m.warehouseId));
});

test("orders placed before warehouses existed still cancel back into the default warehouse", async () => {
  const p = await makeProduct("Old order", "old-order", "OLD-1", { stock: 3 });
  const o = await orders.placeOrder(draft(p, 2), { uid: "cust-2" });
  await db.doc(`orders/${o.orderId}/stock/allocations`).delete(); // an order from before this feature
  await orders.updateOrderStatus({ orderId: o.orderId, status: "cancelled", note: "" }, { actorUid: STAFF });
  assert.equal(await at(p, "main"), 3);
});

test("a quote prices every delivery option correctly (rates are read once and shared)", async () => {
  await db.doc("shippingMethods/express").set({ name: "Express", description: "", estimateText: "", isActive: true });
  await db.collection("shippingRates").add({ methodId: "express", city: "Lahore", charge: 50000, freeOver: null });
  const p = await makeProduct("Quote", "quote", "Q-1", { stock: 2 });
  const q = await orders.quote({ items: [{ productId: p.productId, variantId: p.variantId, qty: 1 }], city: "Lahore" });
  assert.deepEqual(q.shippingOptions.map((o) => [o.id, o.charge]).sort(), [["express", 50000], ["std", 10000]]);
  await db.doc("shippingMethods/express").delete();
});

/* ───────── Transfers ───────── */

test("transfer lifecycle: draft → send → receive; stock is conserved at every step", async () => {
  const p = await makeProduct("Move", "move", "MV-1", { stock: 10 });
  const w = await newWarehouse("Showroom", "SHOWRM", { sellsOnline: false });
  const created = await call("saveTransfer", "manager", { fromWarehouseId: "main", toWarehouseId: w, note: "restock", lines: [{ productId: p.productId, variantId: p.variantId, qty: 4 }] });
  assert.equal(created.status, 200);
  const id = created.body.data.id;
  const doc = async () => (await db.doc(`stockTransfers/${id}`).get()).data();
  assert.equal((await doc()).status, "draft");
  assert.match((await doc()).number, /^TR-\d{6}$/);
  assert.equal(await at(p, "main"), 10, "a draft moves nothing");

  await transfers.saveTransfer({ id, fromWarehouseId: "main", toWarehouseId: w, note: "edited", lines: [{ ...p, qty: 5 }] }, STAFF);
  assert.equal((await doc()).itemCount, 5, "a draft can be edited");

  assert.equal((await call("sendTransfer", "manager", { id })).status, 200);
  assert.equal((await doc()).status, "in_transit");
  assert.equal(await at(p, "main"), 5, "out of the source");
  assert.equal(await at(p, w), 0, "not in the destination yet");
  assert.equal((await inv(p)).totalOnHand, 5, "the 5 in transit are on the transfer, not in any warehouse");
  await assert.rejects(transfers.saveTransfer({ id, fromWarehouseId: "main", toWarehouseId: w, note: "", lines: [{ ...p, qty: 1 }] }, STAFF), (e) => /Only a draft/.test(e.message));
  await assert.rejects(transfers.cancelTransfer({ id }, STAFF), (e) => /hasn't been sent|was already sent/.test(e.message), "a sent transfer can't be cancelled");
  await assert.rejects(transfers.sendTransfer({ id }, STAFF), (e) => /already sent/.test(e.message), "sending twice is refused");

  assert.equal((await call("receiveTransfer", "manager", { id })).status, 200);
  assert.equal((await doc()).status, "received");
  assert.equal(await at(p, w), 5);
  assert.equal(await at(p, "main"), 5);
  assert.equal((await inv(p)).onHand, 5, "stock in a non-online warehouse isn't sold online");
  assert.equal((await inv(p)).totalOnHand, 10, "nothing lost, nothing duplicated");

  const out = (await movements(p)).filter((m) => m.sourceType === "transfer" && m.sourceId === id);
  assert.deepEqual(out.map((m) => [m.reason, m.warehouseId, m.change, m.quantity]).sort(), [["transfer_in", w, 5, 5], ["transfer_out", "main", -5, 5]].sort());
});

test("receiving twice (even at the same instant) applies the stock once", async () => {
  const p = await makeProduct("Twice", "twice", "TW-1", { stock: 6 });
  const w = await newWarehouse("Depot", "DEPOT");
  const id = (await transfers.saveTransfer({ fromWarehouseId: "main", toWarehouseId: w, note: "", lines: [{ ...p, qty: 6 }] }, STAFF)).id;
  await transfers.sendTransfer({ id }, STAFF);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => transfers.receiveTransfer({ id }, STAFF)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one receive wins");
  assert.equal(await at(p, w), 6);
  assert.equal((await inv(p)).totalOnHand, 6);
  await assert.rejects(transfers.receiveTransfer({ id }, STAFF), (e) => /already received/.test(e.message));
});

test("a transfer can't take more than the source holds, and a failed send moves nothing", async () => {
  const a = await makeProduct("Enough", "enough", "EN-1", { stock: 5 });
  const b = await makeProduct("Short", "short", "SH-1", { stock: 1 });
  const w = await newWarehouse("Annex", "ANNEX");
  const id = (await transfers.saveTransfer({ fromWarehouseId: "main", toWarehouseId: w, note: "", lines: [{ ...a, qty: 2 }, { ...b, qty: 3 }] }, STAFF)).id;
  await assert.rejects(transfers.sendTransfer({ id }, STAFF), (e) => e.code === "failed-precondition" && /Only 1 in stock/.test(e.message));
  assert.equal(await at(a, "main"), 5, "the first line was rolled back too");
  assert.equal((await db.doc(`stockTransfers/${id}`).get()).data().status, "draft");
  assert.equal((await movements(a)).filter((m) => m.sourceType === "transfer").length, 0);
});

test("only valid, different, active warehouses can be used; drafts can be cancelled", async () => {
  const p = await makeProduct("Rules", "rules", "RU-1", { stock: 2 });
  const w = await newWarehouse("Valid", "VALID");
  await assert.rejects(transfers.saveTransfer({ fromWarehouseId: "main", toWarehouseId: "ghost", note: "", lines: [{ ...p, qty: 1 }] }, STAFF), (e) => /exists/.test(e.message));
  await assert.rejects(transfers.saveTransfer({ fromWarehouseId: "main", toWarehouseId: w, note: "", lines: [{ productId: p.productId, variantId: "nope", qty: 1 }] }, STAFF), (e) => /doesn't exist/.test(e.message));
  const id = (await transfers.saveTransfer({ fromWarehouseId: "main", toWarehouseId: w, note: "", lines: [{ ...p, qty: 1 }] }, STAFF)).id;
  await transfers.cancelTransfer({ id }, STAFF);
  assert.equal((await db.doc(`stockTransfers/${id}`).get()).data().status, "cancelled");
  await assert.rejects(transfers.sendTransfer({ id }, STAFF), (e) => /cancelled/.test(e.message));
  assert.equal(await at(p, "main"), 2);
});

test("changing a warehouse's online setting is applied to the totals by the recalculation, quantities unchanged", async () => {
  const p = await makeProduct("Toggle", "toggle", "TG-1", { stock: 4 });
  const w = await newWarehouse("Toggle WH", "TOGGLE", { sellsOnline: false });
  await adjust(p, 3, w, "initial");
  assert.equal((await inv(p)).onHand, 4);
  const saved = await warehouses.saveWarehouse({ id: w, name: "Toggle WH", code: "TOGGLE", description: "", address: "", sellsOnline: true }, STAFF);
  assert.equal(saved.needsRebuild, true);
  assert.equal((await inv(p)).onHand, 4, "stale until recalculated");
  let cursor = null;
  let changed = 0;
  do {
    const r = await inventory.rebuildOnlineStock({ cursor });
    changed += r.changed;
    cursor = r.nextCursor;
  } while (cursor);
  assert.ok(changed >= 1);
  const d = await inv(p);
  assert.equal(d.onHand, 7);
  assert.equal(d.byWarehouse[w].onHand, 3, "quantities never change");
  assert.equal((await db.doc(`products/${p.productId}`).get()).data().summary.totalStock, 7);
});

/* ───────── Incremental summary ───────── */

test("the product summary kept up to date inside the transaction equals a full recompute", async () => {
  const p = await makeProduct("Summary", "summary", "SM-1", { stock: 8 });
  const w = await newWarehouse("Sum WH", "SUMWH", { sellsOnline: false });
  await adjust(p, 5, w, "initial");
  const o = await orders.placeOrder(draft(p, 3), { uid: "cust-3" });
  await adjust(p, -2, "main", "damaged");
  await orders.updateOrderStatus({ orderId: o.orderId, status: "cancelled", note: "" }, { actorUid: STAFF });
  const incremental = (await db.doc(`products/${p.productId}`).get()).data().summary;
  await products.recomputeSummary(p.productId);
  const full = (await db.doc(`products/${p.productId}`).get()).data().summary;
  for (const k of ["stock", "totalStock", "inStock", "sizeIds", "minPrice", "maxPrice", "colorIds", "variantCount"]) assert.deepEqual(incremental[k], full[k], `summary.${k}`);
  assert.equal(full.totalStock, 6);
});

test("selling the last pair marks the product out of stock in the summary without re-reading other products", async () => {
  const p = await makeProduct("Last pair", "last-pair", "LP-1", { stock: 1 });
  await orders.placeOrder(draft(p, 1), { uid: "cust-4" });
  const s = (await db.doc(`products/${p.productId}`).get()).data().summary;
  assert.equal(s.inStock, false);
  assert.equal(s.totalStock, 0);
  assert.deepEqual(s.sizeIds, []);
});

/* ───────── Catalog snapshot ───────── */

test("the public catalog is served from a stored snapshot and rebuilt only when something changed", async () => {
  const first = await snapshot.loadSnapshot();
  const meta1 = (await db.doc("catalogSnapshot/meta").get()).data();
  assert.ok(meta1.version && meta1.chunks >= 1);
  assert.ok(first.products.length > 0);
  assert.deepEqual(first.products.map((p) => p.id).sort(), (await db.collection("products").where("status", "==", "published").get()).docs.map((d) => d.id).sort(), "same products as the live read");

  await snapshot.loadSnapshot();
  assert.equal((await db.doc("catalogSnapshot/meta").get()).data().version, meta1.version, "unchanged data → no rebuild");

  // A real change (publishing a new product) marks the catalog dirty, so the next read rebuilds.
  const p = await makeProduct("Snapshot new", "snapshot-new", "SN-1", { stock: 2 });
  const after = await snapshot.loadSnapshot();
  assert.ok(after.products.some((x) => x.id === p.productId), "the new product is in the rebuilt snapshot");
  assert.notEqual((await db.doc("catalogSnapshot/meta").get()).data().version, meta1.version);

  // An order changes stock → dirty → the shop sees the new availability.
  await orders.placeOrder(draft(p, 2), { uid: "cust-5" });
  const sold = (await snapshot.loadSnapshot()).products.find((x) => x.id === p.productId);
  assert.equal(sold.summary.inStock, false);

  // Old versions are tidied away.
  const parts = (await db.collection("catalogSnapshot").get()).docs.map((d) => d.id).filter((id) => id !== "meta");
  const live = (await db.doc("catalogSnapshot/meta").get()).data();
  assert.ok(parts.every((id) => id.startsWith(`v${live.version}-`)), "no leftover parts of old versions");
});

test("a snapshot older than the safety limit is rebuilt even if nothing marked it dirty", async () => {
  const before = (await db.doc("catalogSnapshot/meta").get()).data().version;
  await snapshot.loadSnapshot({ now: Date.now() + snapshot.SNAPSHOT_TTL_MS + 1000 });
  assert.notEqual((await db.doc("catalogSnapshot/meta").get()).data().version, before);
});

test("products are split into parts that stay under the document size limit", () => {
  const big = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, text: "x".repeat(1000) }));
  const parts = snapshot.splitProducts(big, 3500);
  assert.ok(parts.length >= 3);
  assert.equal(parts.flat().length, 10, "no product lost");
  assert.ok(parts.every((part) => Buffer.byteLength(JSON.stringify(part)) <= 3500 + 1100));
});

test("the /api/catalog response is unchanged in shape and still lists only published products", async () => {
  const res = await handleApi({ method: "GET", name: "catalog", headers: {}, body: undefined });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["categories", "colors", "deliveryReady", "home", "products", "settings", "sizes"]);
  assert.ok(res.body.products.every((p) => p.status === "published"));
  assert.equal(res.body.settings.storeName, "Test Store");
});

/* ───────── Migration ───────── */

async function legacyProduct(name, slug, sku, onHand, reserved = 0) {
  const p = await makeProduct(name, slug, sku);
  await db.doc(`inventory/${key(p)}`).update({ onHand, reserved, byWarehouse: FieldValue.delete(), available: FieldValue.delete(), totalOnHand: FieldValue.delete() });
  await db.doc(`products/${p.productId}/variants/${p.variantId}`).update({ available: onHand - reserved });
  return p;
}

test("migration: a dry run writes nothing and reports; apply keeps quantities; a second run does nothing", async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  const a = await legacyProduct("Mig A", "mig-a", "MA-1", 12, 2);
  const b = await legacyProduct("Mig B", "mig-b", "MB-1", 0);
  const c = await legacyProduct("Mig C", "mig-c", "MC-1", 7);
  // Problems that must be reported and left alone.
  const bad = await legacyProduct("Mig Bad", "mig-bad", "MX-1", 5);
  await db.doc(`inventory/${key(bad)}`).update({ onHand: -3 });
  await db.doc("inventory/ghost__variant").set({ productId: "ghost", variantId: "variant", onHand: 2, reserved: 0 });
  const noInventory = await makeProduct("Mig None", "mig-none", "MN-1");
  await db.doc(`inventory/${key(noInventory)}`).delete();

  const snapshotOf = async () => Object.fromEntries((await db.collection("inventory").get()).docs.map((d) => [d.id, JSON.stringify(d.data())]));
  const before = await snapshotOf();
  const dry = await runWarehouseMigration(db, { apply: false });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.toMigrate, 3);
  assert.equal(dry.defaultWarehouse, "would-create");
  assert.deepEqual(dry.problems.invalidQuantities, [key(bad)]);
  assert.deepEqual(dry.problems.orphanInventory, ["ghost__variant"]);
  assert.deepEqual(dry.problems.variantsWithoutInventory, [key(noInventory)]);
  assert.deepEqual(await snapshotOf(), before, "a dry run changes nothing");
  assert.equal((await db.doc("warehouses/main").get()).exists, false, "…not even the default warehouse");

  const applied = await runWarehouseMigration(db, { apply: true });
  assert.equal(applied.migrated, 3);
  assert.equal(applied.skipped, 2, "the damaged and the orphan documents are left for review");
  assert.deepEqual(applied.verification.mismatches, []);
  assert.equal(applied.unitsOnHandBefore, applied.unitsOnHandAfter, "total units identical before and after");
  assert.equal((await db.doc("warehouses/main").get()).data().isDefault, true);
  for (const [p, onHand, reserved] of [[a, 12, 2], [b, 0, 0], [c, 7, 0]]) {
    const d = await inv(p);
    assert.equal(d.onHand, onHand, "quantity unchanged");
    assert.equal(d.reserved, reserved);
    assert.deepEqual(d.byWarehouse, { main: { onHand, reserved } });
    assert.equal(d.available, onHand - reserved);
    assert.equal(d.totalOnHand, onHand);
  }
  assert.equal((await inv(bad)).onHand, -3, "an inconsistent document is not touched");
  assert.equal((await inv(bad)).byWarehouse, undefined);

  const again = await runWarehouseMigration(db, { apply: true });
  assert.equal(again.migrated, 0, "idempotent: nothing left to do");
  assert.equal(again.alreadyMigrated, 3);
  assert.equal((await db.doc("_migrations/002-warehouse-inventory").get()).data().status, "done");
});
