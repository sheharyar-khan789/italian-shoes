/**
 * The HTTP layer (functions/handler.js) against the Firestore emulator (`npm run test:emulator`).
 * Sign-in tokens are replaced by a fake verifier that returns claims; no accounts are created.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const { endpoints } = await import("../../functions/registry.js");

/** Claims by fake token. */
const TOKENS = {
  customer: { uid: "cust-1", email: "c@example.com" },
  staffNoPerm: { uid: "staff-0", staff: true, perms: ["orders.read"], auth_time: 9999999999 },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, { token, body = { data: {} }, method = "POST", headers = {} } = {}) =>
  handleApi({ method, name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body }, { verifyToken });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
});

test("every endpoint the screens call is registered", () => {
  for (const name of ["placeOrder", "quoteCheckout", "cancelMyOrder", "saveProduct", "adjustStock", "updateOrderStatus", "saveSettings", "setStaffRoles", "claimOwner", "saveCoupon", "salesReport", "submitReview", "recordCollection"]) {
    assert.ok(endpoints[name], name);
  }
});

test("unknown names, wrong methods and non-JSON are refused", async () => {
  assert.equal((await call("nope")).status, 404);
  assert.equal((await call("toString")).status, 404, "inherited object keys are not endpoints");
  assert.equal((await call("placeOrder", { method: "GET" })).status, 405);
  assert.equal((await call("placeOrder", { headers: { "content-type": "text/plain" } })).status, 415);
  const health = await call("healthCheck", { method: "GET" });
  assert.deepEqual([health.status, health.body.ok], [200, true]);
});

test("no token, a forged token and a customer token are told apart", async () => {
  assert.equal((await call("placeOrder")).status, 401, "signed out");
  const forged = await call("placeOrder", { token: "forged" });
  assert.equal(forged.status, 401);
  assert.match(forged.body.error.message, /expired|sign in/i);
  // Valid customer, but empty/invalid order data: validation error with field details, not a crash.
  const invalid = await call("placeOrder", { token: "customer" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "invalid-argument");
  assert.ok(invalid.body.error.details.fields);
});

test("staff endpoints check the permission inside the verified token", async () => {
  const denied = await call("saveCoupon", { token: "staffNoPerm" });
  assert.equal(denied.status, 403);
  assert.equal((await call("saveCoupon", { token: "customer" })).status, 403, "customers are not staff");
  assert.equal((await call("saveCoupon")).status, 401);
});

test("rate limits answer 429 with a safe message", async () => {
  let last;
  for (let i = 0; i < 7; i += 1) last = await call("claimOwner", { token: "customer" }); // limit is 5 per hour
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, "resource-exhausted");
  assert.ok((await db.collection("_rateLimits").get()).size >= 1);
});

test("responses are never cached", async () => {
  assert.equal((await call("placeOrder")).headers["Cache-Control"], "no-store");
});

test("the public catalog is cached, lists only published products, and has plain-JSON dates", async () => {
  await db.doc("settings/public").set({ storeName: "Test Store" });
  await db.doc("categories/c1").set({ name: "Formal", slug: "formal", isActive: true });
  const { Timestamp } = await import("../../functions/lib/admin.js");
  await db.doc("products/live").set({ name: "Live", slug: "live", status: "published", publishedAt: Timestamp.fromDate(new Date("2026-01-02T03:04:05Z")), summary: {} });
  await db.doc("products/hidden").set({ name: "Hidden", slug: "hidden", status: "draft", summary: {} });
  const res = await call("catalog", { method: "GET", body: undefined });
  assert.equal(res.status, 200);
  assert.match(res.headers["Cache-Control"], /s-maxage=30/);
  assert.equal(res.body.settings.storeName, "Test Store");
  assert.deepEqual(res.body.products.map((p) => p.slug), ["live"]);
  assert.equal(res.body.products[0].publishedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(JSON.parse(JSON.stringify(res.body)).categories[0].slug, "formal");
  assert.equal((await call("catalog", { method: "POST" })).status, 405);
});
