/**
 * The daily scheduled run (`npm run test:emulator`): access control on the route, and the three real jobs on an empty
 * database. What each job does with data is covered where it lives (finance, CRM and analytics tests).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db } = await import("../../functions/lib/admin.js");
const { runCronJobs } = await import("../../functions/services/cron.js");
const handler = (await import("../../api/cron.js")).default;

const SECRET = "a-long-enough-test-secret-0123456789";
const run = async (req) => {
  const res = { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
};

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
});

test("the route does nothing without a configured secret, and refuses everyone but the scheduler", async () => {
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await run({ method: "GET", headers: { authorization: `Bearer ${SECRET}` } })).statusCode, 503);
    process.env.CRON_SECRET = "short";
    assert.equal((await run({ method: "GET", headers: { authorization: "Bearer short" } })).statusCode, 503, "a weak secret is treated as not configured");
    process.env.CRON_SECRET = SECRET;
    assert.equal((await run({ method: "GET", headers: {} })).statusCode, 401);
    assert.equal((await run({ method: "GET", headers: { authorization: "Bearer wrong-secret-of-another-length" } })).statusCode, 401);
    assert.equal((await run({ method: "GET", headers: { authorization: `Bearer ${SECRET.slice(0, -1)}x` } })).statusCode, 401, "same length, wrong value");
    assert.equal((await run({ method: "DELETE", headers: { authorization: `Bearer ${SECRET}` } })).statusCode, 405);
    assert.equal((await db.doc("system/cron").get()).exists, false, "refused calls ran nothing");
    const good = await run({ method: "GET", headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(good.statusCode, 200);
    assert.deepEqual(Object.keys(good.body.results).sort(), ["loyaltyExpiry", "recurringExpenses", "reportSchedules"]);
    assert.equal(good.headers["cache-control"], "no-store");
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
  }
});

test("the real jobs run cleanly on an empty database, can run again, and the result is kept for the admin", async () => {
  const first = await runCronJobs();
  assert.equal(first.ok, true, JSON.stringify(first.results));
  assert.deepEqual(first.results.recurringExpenses.summary, { created: [], failed: [] });
  assert.deepEqual(first.results.loyaltyExpiry.summary, { lots: 0, points: 0 });
  assert.deepEqual(first.results.reportSchedules.summary, { created: 0, failed: [] });
  assert.equal((await runCronJobs()).ok, true, "running twice is harmless");
  const saved = (await db.doc("system/cron").get()).data();
  assert.equal(saved.ok, true);
  assert.ok(saved.lastRunAt);
});

test("one failing job does not stop the others, and the failure is reported", async () => {
  const calls = [];
  const out = await runCronJobs({ jobs: { a: async () => { calls.push("a"); throw new Error("boom"); }, b: async () => { calls.push("b"); return { done: 1 }; } } });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(out.ok, false);
  assert.equal(out.results.a.ok, false);
  assert.match(out.results.a.error, /boom/);
  assert.deepEqual(out.results.b, { ok: true, summary: { done: 1 } });
  assert.equal((await db.doc("system/cron").get()).data().ok, false);
});
