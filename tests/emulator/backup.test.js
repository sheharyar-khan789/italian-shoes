/**
 * Firestore backup / restore round trip against the emulator (`npm run test:emulator`).
 * Proves the recovery procedure in docs/OPERATIONS.md works: export, verify, wipe, restore, compare.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

// Same firebase-admin copy as the command-line tools use (the site's server code has its own copy in functions/).
const { initializeApp } = await import("firebase-admin/app");
const { getFirestore, Timestamp, GeoPoint } = await import("firebase-admin/firestore");
const db = getFirestore(initializeApp({ projectId: PROJECT }, "backup-test"));
const { exportAll, importAll, verifyBackup } = await import("../../scripts/lib/firestoreBackup.mjs");

const wipe = () => fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "is-backup-"));
const repo = path.resolve(import.meta.dirname, "../..");

/** Every document in the database as { path: data } with values normalised for comparison. */
async function snapshotAll() {
  const out = {};
  const walk = async (col) => {
    const refs = await col.listDocuments();
    for (const ref of refs) {
      const s = await ref.get();
      if (s.exists) out[ref.path] = JSON.stringify(s.data(), (k, v) => (v && v.constructor && v.constructor.name === "Timestamp" ? `ts:${v.seconds}.${v.nanoseconds}` : v));
      for (const sub of await ref.listCollections()) await walk(sub);
    }
  };
  for (const col of await db.listCollections()) await walk(col);
  return out;
}

before(async () => {
  await wipe();
  const batch = db.batch();
  batch.set(db.doc("products/p1"), {
    name: "Loafer", price: 450000, active: true, note: null, tags: ["a", "b"],
    created: Timestamp.fromDate(new Date("2026-11-01T10:20:30.123Z")), where: new GeoPoint(33.7, 73.1),
    buyer: db.doc("users/u1"), blob: Buffer.from([1, 2, 3, 250]), nested: { deep: { n: -5, list: [{ x: 1 }, { y: [] }] } },
    tricky: { __t: "ts", s: 1, n: 2 }, weird: "ünïcode — اردو",
  });
  batch.set(db.doc("users/u1"), { email: "a@example.test" });
  batch.set(db.doc("payments/s1/transactions/t1"), { amount: 100 });
  batch.set(db.doc("payments/s1/transactions/t2"), { amount: 200 });
  batch.set(db.doc("ghost/g1/kids/k1"), { ok: true }); // g1 itself has no fields
  await batch.commit();
  for (let i = 0; i < 4; i++) {
    const b = db.batch();
    for (let j = 0; j < 120; j++) b.set(db.doc(`journalEntries/j${String(i * 120 + j).padStart(4, "0")}`), { n: i * 120 + j });
    await b.commit();
  }
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("export, wipe, restore: every document and value comes back identical", async () => {
  const before_ = await snapshotAll();
  assert.ok(Object.keys(before_).length === 485, "fixture: 480 paged documents + 5 others");
  const dir = path.join(root, "b1");
  const manifest = await exportAll(db, dir, { projectId: PROJECT });
  assert.equal(manifest.counts.journalEntries, 480, "paging must not drop or repeat documents");
  assert.equal(manifest.counts.payments, 2, "sub-collection documents are counted");
  assert.equal(manifest.counts.ghost, 1, "documents under a parent that has no fields are exported");
  assert.equal(verifyBackup(dir).ok, true);

  await wipe();
  assert.equal(Object.keys(await snapshotAll()).length, 0);
  const r = await importAll(db, dir);
  assert.equal(r.written, manifest.total);
  assert.equal(r.skipped, 0);
  const after_ = await snapshotAll();
  // The "ghost" parent has no fields of its own so it is not a document; its child must exist.
  assert.deepEqual(Object.keys(after_).sort(), Object.keys(before_).sort());
  for (const k of Object.keys(before_)) assert.equal(after_[k], before_[k], `${k} differs after restore`);
  const p = (await db.doc("products/p1").get()).data();
  assert.ok(p.buyer.path === "users/u1" && Buffer.from(p.blob).equals(Buffer.from([1, 2, 3, 250])) && p.where.latitude === 33.7);
  assert.deepEqual(p.tricky, { __t: "ts", s: 1, n: 2 }, "a user field that looks like a tag must survive as plain data");
});

test("restore never overwrites existing documents unless asked", async () => {
  const dir = path.join(root, "b2");
  await exportAll(db, dir, { projectId: PROJECT });
  await db.doc("users/u1").set({ email: "changed@example.test" });
  const r = await importAll(db, dir);
  assert.equal(r.written, 0);
  assert.ok(r.skipped === 485);
  assert.equal((await db.doc("users/u1").get()).data().email, "changed@example.test", "existing data was kept");
  await importAll(db, dir, { overwrite: true });
  assert.equal((await db.doc("users/u1").get()).data().email, "a@example.test");
});

test("a damaged or incomplete backup is detected and nothing is written", async () => {
  const dir = path.join(root, "b3");
  await exportAll(db, dir, { projectId: PROJECT });
  const f = path.join(dir, "data", "users.ndjson");
  fs.appendFileSync(f, JSON.stringify({ path: "users/evil", data: { email: "x" } }) + "\n");
  const v = verifyBackup(dir);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /checksum mismatch/);
  await assert.rejects(importAll(db, dir), /failed verification/);
  assert.equal((await db.doc("users/evil").get()).exists, false);
  fs.rmSync(f);
  assert.match(verifyBackup(dir).problems.join(" "), /missing file/);
  await assert.rejects(exportAll(db, dir), /already exists/, "a backup is never merged into an existing folder");
});

test("the command-line tools refuse unsafe use", () => {
  const env = { ...process.env, FIREBASE_PROJECT_ID: "italianshoes" };
  delete env.FIRESTORE_EMULATOR_HOST;
  const dir = path.join(root, "b1");
  const run = (script, args, e = env) => spawnSync(process.execPath, [path.join(repo, "scripts", script), ...args], { env: e, encoding: "utf8" });
  const noFlag = run("restore-firestore.mjs", ["--from", dir]);
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /Refusing to touch a real project/);
  const wrongProject = run("restore-firestore.mjs", ["--from", dir, "--production", "--confirm-project", "italianshoes"]);
  assert.equal(wrongProject.status, 1, "backup came from the demo project, so it cannot be restored into the real one");
  const inRepo = run("backup-firestore.mjs", ["--out", path.join(repo, "backup-tmp")]);
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /outside this project and outside OneDrive/);
  assert.equal(fs.existsSync(path.join(repo, "backup-tmp")), false);
});
