/**
 * Cloud Functions + migrations against the local emulators. Run with `npm run test:emulator`.
 * Uses the "demo-italianshoes" project, which cannot reach any real Firebase service.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { DEFAULT_ROLES } from "../../shared/permissions.js";

const run = promisify(execFile);
const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");

const db = getFirestore(initializeApp({ projectId: PROJECT }, "emulator-tests"));

before(async () => {
  // Start from an empty database.
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
});

const migrate = () => run(process.execPath, ["functions/scripts/migrate.mjs"], { env: { ...process.env, GCLOUD_PROJECT: PROJECT } });

test("migration 001 seeds exactly the four roles from shared/permissions.js", async () => {
  const { stdout } = await migrate();
  assert.match(stdout, /001-seed-roles: 4 role\(s\) created/);

  const roles = await db.collection("roles").get();
  assert.deepEqual(roles.docs.map((d) => d.id).sort(), Object.keys(DEFAULT_ROLES).sort());
  assert.deepEqual(roles.docs.find((d) => d.id === "owner").data().permissions, DEFAULT_ROLES.owner.permissions);
  assert.equal((await db.doc("_migrations/001-seed-roles").get()).data().status, "done");
});

test("running migrations again changes nothing and never overwrites the owner's edits", async () => {
  await db.doc("roles/content_manager").update({ permissions: ["content.manage"] });
  const { stdout } = await migrate();
  assert.match(stdout, /Applied: none\. Already applied: 1/);
  assert.deepEqual((await db.doc("roles/content_manager").get()).data().permissions, ["content.manage"]);
});

test("migrate script refuses to run without the emulator or explicit production flags", async () => {
  const env = { ...process.env };
  delete env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(run(process.execPath, ["functions/scripts/migrate.mjs"], { env }), /No emulator found/);
  await assert.rejects(run(process.execPath, ["functions/scripts/migrate.mjs", "--production"], { env }), /without --project/);
});

test("rate limiter allows up to the limit, then blocks with retry time; buckets are per action and per caller", async () => {
  const { consumeRateLimit } = await import("../../functions/lib/rateLimit.js");
  const rule = { limit: 3, windowSeconds: 60 };
  const now = Date.UTC(2026, 10, 4, 12, 0, 10);

  for (let i = 0; i < 3; i++) await consumeRateLimit("login", "ip:203.0.113.5", rule, { now });
  await assert.rejects(consumeRateLimit("login", "ip:203.0.113.5", rule, { now }), (e) => e.code === "resource-exhausted" && e.details.retryAfter === 50);

  await consumeRateLimit("login", "ip:198.51.100.7", rule, { now }); // another caller is unaffected
  await consumeRateLimit("signup", "ip:203.0.113.5", rule, { now }); // another action is unaffected
  await consumeRateLimit("login", "ip:203.0.113.5", rule, { now: now + 60_000 }); // next window is fresh

  // Stored bucket ids are hashes: no raw IP addresses in the database.
  const docs = (await db.collection("_rateLimits").get()).docs;
  assert.ok(docs.length >= 4);
  for (const d of docs) {
    assert.match(d.id, /^[0-9a-f]{40}$/, "bucket ids are hashes");
    assert.ok(!JSON.stringify(d.data()).includes("203.0.113.5") && !JSON.stringify(d.data()).includes("198.51.100.7"), "no raw IP stored in the document");
  }
});

test("rate limiter holds under parallel requests (transactions, no lost updates)", async () => {
  const { consumeRateLimit } = await import("../../functions/lib/rateLimit.js");
  const rule = { limit: 5, windowSeconds: 60 };
  const now = Date.UTC(2026, 10, 4, 13, 0, 0);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit("burst", "uid:abc", rule, { now })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5, "exactly 5 of 12 parallel calls allowed");
});
