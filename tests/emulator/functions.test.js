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
const FUNCTIONS = `http://${process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001"}/${PROJECT}/asia-south1`;

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

test("healthCheck reports Firestore reachable, rejects other methods, exposes no data", async () => {
  const ok = await fetch(`${FUNCTIONS}/healthCheck`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ["firestore", "migrationsApplied", "ok"]);
  assert.equal(body.ok, true);
  assert.equal(body.migrationsApplied, 1);

  const post = await fetch(`${FUNCTIONS}/healthCheck`, { method: "POST" });
  assert.equal(post.status, 405);
});
