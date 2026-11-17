import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, openIdbStore } from "../../src/lib/offlineStore.js";
import { createSyncEngine, backoffDelay, DEFAULTS } from "../../src/lib/offlineSync.js";
import { searchLocal, pendingQuantities } from "../../src/lib/offlineCatalog.js";

const entry = (id, over = {}) => ({ offlineId: id, createdAt: Number(id.replace(/\D/g, "")) || 1, payload: { sale: { idempotencyKey: id, items: [{ productId: "p1", variantId: "v1", qty: 1 }] }, offlineId: id, expectedTotal: 1000 }, ...over });
const netErr = () => Object.assign(new Error("offline"), { code: "unavailable" });
const synced = (id) => ({ status: "synced", saleId: `sale-${id}`, number: "SL-1", total: 1000, paidTotal: 1000 });

function setup({ handler, uid = "u1", options } = {}) {
  const store = memoryStore();
  const sent = [];
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const call = async (name, data) => {
    sent.push([name, data]);
    return handler(name, data);
  };
  const engine = () => createSyncEngine({ store, call, uid: () => uid, now: clock.now, random: () => 0.5, options });
  return { store, sent, clock, engine: engine(), newEngine: engine };
}

test("a queued sale is written to storage before anything is sent, and the same sale is never queued twice", async () => {
  const s = setup({ handler: async () => synced("x") });
  await s.engine.enqueue(entry("off1"));
  assert.equal((await s.store.getQueue("off1")).status, "pending", "stored before any send");
  assert.equal(s.sent.length, 0);
  await s.engine.enqueue(entry("off1"));
  assert.equal((await s.store.allQueue()).length, 1);
});

test("a queue survives a restart: a new engine over the same storage sends what the old one saved", async () => {
  const s = setup({ handler: async () => { throw netErr(); } });
  await s.engine.enqueue(entry("off1"));
  await s.engine.syncOnce();
  const revived = s.newEngine();
  assert.equal((await revived.counts()).unsent, 1, "still there");
  s.clock.advance(DEFAULTS.maxMs + 1);
  const ok = createSyncEngine({ store: s.store, call: async () => synced("off1"), uid: () => "u1", now: s.clock.now });
  assert.equal((await ok.syncOnce()).synced, 1);
  assert.equal((await s.store.getQueue("off1")).status, "synced");
});

test("success: marked synced with the server's sale number, last-sync time recorded", async () => {
  const s = setup({ handler: async () => ({ ...synced("a"), number: "SL-000042" }) });
  await s.engine.enqueue(entry("off1"));
  assert.deepEqual(await s.engine.syncOnce(), { sent: 1, synced: 1, held: 0, failed: 0, offline: false });
  const q = await s.store.getQueue("off1");
  assert.deepEqual([q.status, q.result.number, q.attempts], ["synced", "SL-000042", 1]);
  assert.equal((await s.engine.counts()).lastSyncAt, s.clock.now());
  assert.equal((await s.engine.syncOnce()).sent, 0, "a synced sale is never sent again");
});

test("no connection: the sale stays pending (never dropped), waits with growing backoff, and the rest of the queue waits too", async () => {
  const s = setup({ handler: async () => { throw netErr(); } });
  await s.engine.enqueue(entry("off1"));
  await s.engine.enqueue(entry("off2"));
  const r = await s.engine.syncOnce();
  assert.deepEqual([r.offline, r.sent], [true, 1], "stops after the first network failure");
  let q = await s.store.getQueue("off1");
  assert.deepEqual([q.status, q.attempts], ["pending", 1]);
  const first = q.nextAttemptAt - s.clock.now();
  assert.equal((await s.engine.syncOnce()).sent, 0, "not before the backoff has passed");
  s.clock.advance(first + 1);
  await s.engine.syncOnce();
  q = await s.store.getQueue("off1");
  assert.equal(q.attempts, 2);
  assert.ok(q.nextAttemptAt - s.clock.now() > first, "backoff grew");
  for (let i = 0; i < 40; i += 1) {
    s.clock.advance(DEFAULTS.maxMs + 1);
    await s.engine.syncOnce();
  }
  q = await s.store.getQueue("off1");
  assert.equal(q.status, "pending", "a long outage never turns into a failure");
  assert.ok(q.nextAttemptAt - s.clock.now() <= DEFAULTS.maxMs);
  assert.equal((await s.store.getQueue("off2")).status, "pending");
});

test("backoff is exponential, capped, and jittered", () => {
  const d = (n, r = 1) => backoffDelay(n, () => r);
  assert.equal(d(0), 2000);
  assert.equal(d(1), 4000);
  assert.equal(d(3), 16000);
  assert.equal(d(30), DEFAULTS.maxMs);
  assert.equal(backoffDelay(2, () => 0), 4000, "jitter is between half and full delay");
  assert.ok(backoffDelay(5, Math.random) >= 32000 && backoffDelay(5, Math.random) <= 64000);
});

test("partial failure: the first sale syncs, the connection drops on the second, the rest wait; later everything completes in order", async () => {
  let calls = 0;
  const order = [];
  const s = setup({ handler: async (_n, d) => { calls += 1; if (calls === 2) throw netErr(); order.push(d.offlineId); return synced(d.offlineId); } });
  for (const id of ["off3", "off1", "off2"]) await s.engine.enqueue(entry(id));
  const r = await s.engine.syncOnce();
  assert.deepEqual([r.synced, r.offline], [1, true]);
  assert.deepEqual(order, ["off1"], "oldest first");
  assert.deepEqual((await s.engine.list()).map((q) => q.status), ["synced", "pending", "pending"]);
  s.clock.advance(DEFAULTS.maxMs + 1);
  await s.engine.syncOnce();
  assert.deepEqual(order, ["off1", "off2", "off3"]);
  assert.deepEqual((await s.engine.counts()).unsent, 0);
});

test("a refusal is kept with its reason and is not retried automatically; a retry after the cause is fixed goes through once", async () => {
  let stock = false;
  const s = setup({ handler: async (_n, d) => (stock ? synced(d.offlineId) : { status: "conflict", conflict: "stock", message: "Only 0 of Oxford in Shop floor.", details: { available: 0 } }) });
  await s.engine.enqueue(entry("off1"));
  assert.equal((await s.engine.syncOnce()).held, 1);
  let q = await s.store.getQueue("off1");
  assert.deepEqual([q.status, q.conflict, q.lastError, q.details.available], ["conflict", "stock", "Only 0 of Oxford in Shop floor.", 0]);
  s.clock.advance(DEFAULTS.maxMs * 4);
  assert.equal((await s.engine.syncOnce()).sent, 0, "held sales wait for a person");
  stock = true;
  assert.equal((await s.engine.retry("off1")).synced, 1);
  q = await s.store.getQueue("off1");
  assert.deepEqual([q.status, q.conflict, q.lastError], ["synced", null, null]);
  await assert.rejects(s.engine.retry("off1"), /can't be retried/);
});

test("accepting the server's price sends the resolution, and only for a price conflict", async () => {
  const s = setup({ handler: async (_n, d) => (d.resolution ? synced(d.offlineId) : { status: "conflict", conflict: "price_changed", message: "Prices changed", details: { offlineTotal: 1000, serverTotal: 900 } }) });
  await s.engine.enqueue(entry("off1"));
  await s.engine.syncOnce();
  assert.equal((await s.engine.acceptServerPrice("off1")).synced, 1);
  assert.equal(s.sent.at(-1)[1].resolution, "accept_server_price");
  const t = setup({ handler: async () => ({ status: "conflict", conflict: "stock", message: "x" }) });
  await t.engine.enqueue(entry("off1"));
  await t.engine.syncOnce();
  await assert.rejects(t.engine.acceptServerPrice("off1"), /isn't waiting on a price/);
});

test("server errors are retried a limited number of times, then reported as failed with the reason; validation refusals fail at once", async () => {
  const s = setup({ handler: async () => { throw Object.assign(new Error("Server problem"), { code: "internal" }); }, options: { maxServerErrors: 3 } });
  await s.engine.enqueue(entry("off1"));
  for (let i = 0; i < 3; i += 1) {
    s.clock.advance(DEFAULTS.maxMs + 1);
    await s.engine.syncOnce();
  }
  const q = await s.store.getQueue("off1");
  assert.deepEqual([q.status, q.lastError], ["failed", "Server problem"]);
  const v = setup({ handler: async () => { throw Object.assign(new Error("Only fully cash-paid sales can be made offline."), { code: "invalid-argument" }); } });
  await v.engine.enqueue(entry("off1"));
  await v.engine.syncOnce();
  assert.equal((await v.store.getQueue("off1")).status, "failed");
  assert.equal((await v.engine.syncOnce()).sent, 0, "not retried");
});

test("only one sync runs at a time: simultaneous triggers send each sale once", async () => {
  let inFlight = 0;
  let max = 0;
  const s = setup({ handler: async (_n, d) => { inFlight += 1; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return synced(d.offlineId); } });
  for (const id of ["off1", "off2", "off3"]) await s.engine.enqueue(entry(id));
  await Promise.all([s.engine.syncOnce(), s.engine.syncOnce(), s.engine.syncOnce({ force: true })]);
  assert.equal(max, 1);
  assert.equal(s.sent.length, 3, "each sale sent once");
});

test("a sale interrupted mid-send (tab closed) is picked up again; only the signed-in cashier's sales are sent", async () => {
  const s = setup({ handler: async (_n, d) => synced(d.offlineId) });
  await s.store.putQueue({ ...entry("off1"), uid: "u1", status: "syncing", syncStartedAt: s.clock.now() - DEFAULTS.staleSyncingMs - 1, attempts: 0 });
  await s.store.putQueue({ ...entry("off2"), uid: "someone-else", status: "pending", attempts: 0, nextAttemptAt: 0 });
  const r = await s.engine.syncOnce();
  assert.equal(r.synced, 1);
  assert.equal((await s.store.getQueue("off1")).status, "synced");
  assert.equal((await s.store.getQueue("off2")).status, "pending", "another cashier's sale is left alone");
});

test("discarding needs the server's agreement and is refused for a sale the server already has", async () => {
  const s = setup({ handler: async (name) => { if (name === "posSyncDiscard") throw Object.assign(new Error("already recorded"), { code: "failed-precondition" }); return { status: "conflict", conflict: "register", message: "Open a register" }; } });
  await s.engine.enqueue(entry("off1"));
  await s.engine.syncOnce();
  await assert.rejects(s.engine.discard("off1", "Customer left"), /already recorded/);
  assert.equal((await s.store.getQueue("off1")).status, "conflict", "unchanged when the server says no");
  const t = setup({ handler: async (name) => (name === "posSyncDiscard" ? { status: "discarded" } : { status: "conflict", conflict: "register", message: "x" }) });
  await t.engine.enqueue(entry("off1"));
  await t.engine.syncOnce();
  await t.engine.discard("off1", "Customer left");
  assert.equal((await t.store.getQueue("off1")).status, "discarded");
  assert.equal(t.sent.at(-1)[1].reason, "Customer left");
});

test("synced records are tidied after a week; unsent sales are never tidied away", async () => {
  const s = setup({ handler: async (_n, d) => synced(d.offlineId) });
  await s.engine.enqueue(entry("off1"));
  await s.engine.enqueue(entry("off2", { payload: { ...entry("off2").payload } }));
  await s.engine.syncOnce();
  await s.store.putQueue({ ...entry("off9"), uid: "u1", status: "conflict", attempts: 1, createdAt: 1 });
  s.clock.advance(DEFAULTS.keepSyncedMs + 1);
  await s.engine.syncOnce();
  assert.deepEqual((await s.store.allQueue()).map((q) => q.offlineId), ["off9"]);
});

const catalog = [
  { id: "p1", name: "Milano Oxford", variants: [{ id: "v1", sku: "MO-1-BLACK-42", colorName: "Black", sizeLabel: "EU 42", price: 1500000, listPrice: 1500000, available: 3 }, { id: "v2", sku: "MO-1-BROWN-42", colorName: "Brown", sizeLabel: "EU 42", price: 1500000, listPrice: 1500000, available: 1 }] },
  { id: "p2", name: "Roma Loafer", variants: [{ id: "v3", sku: "RL-1-BLACK-42", colorName: "Black", sizeLabel: "EU 42", price: 1000000, listPrice: 1200000, available: 2 }] },
];

test("offline search: a scanned SKU finds exactly its variant; names match whole words; unsent sales reduce the stock shown", () => {
  const sku = searchLocal(catalog, "mo-1-black-42", { exact: true });
  assert.deepEqual([sku.match, sku.products.length, sku.products[0].variants.length, sku.products[0].variants[0].id], ["sku", 1, 1, "v1"]);
  assert.equal(searchLocal(catalog, "nonsense-sku", { exact: true }).match, "none");
  assert.deepEqual(searchLocal(catalog, "roma").products.map((p) => p.id), ["p2"]);
  assert.deepEqual(searchLocal(catalog, "oxford milano").products.map((p) => p.id), ["p1"]);
  assert.equal(searchLocal(catalog, "xyz").match, "none");
  const held = pendingQuantities([
    { status: "pending", payload: { sale: { items: [{ productId: "p1", variantId: "v1", qty: 2 }] } } },
    { status: "conflict", payload: { sale: { items: [{ productId: "p1", variantId: "v1", qty: 1 }] } } },
    { status: "synced", payload: { sale: { items: [{ productId: "p1", variantId: "v1", qty: 5 }] } } },
  ]);
  assert.equal(held.get("p1/v1"), 3, "synced and discarded sales aren't held");
  assert.equal(searchLocal(catalog, "MO-1-BLACK-42", { exact: true, held }).products[0].variants[0].available, 0, "never below zero");
  assert.equal(catalog[0].variants[0].available, 3, "the cache itself is not changed");
});

test("storage without IndexedDB is reported clearly instead of silently losing sales", async () => {
  await assert.rejects(openIdbStore(undefined), /can't store offline sales/);
});

test("the error the real api layer raises when the network is down (functions/unavailable) is treated as offline, not as a failed sale", async () => {
  // Found by the browser test: the engine used to recognise only the bare "unavailable", which callApi never produces.
  const real = () => Object.assign(new Error("Couldn't reach the store."), { code: "functions/unavailable" });
  const s = setup({ handler: async () => { throw real(); } });
  await s.engine.enqueue(entry("off7"));
  const r = await s.engine.syncOnce();
  assert.equal(r.offline, true);
  const q = await s.store.getQueue("off7");
  assert.equal(q.status, "pending", "kept, to be retried when the connection returns");
  assert.equal(q.attempts, 1);
});
