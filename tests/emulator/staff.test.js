/**
 * Staff access service against the Auth + Firestore emulators (`npm run test:emulator`).
 * The people below are fixtures that exist only inside this test run's emulator and are deleted
 * at the end; nothing touches a real Firebase project ("demo-" project id).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

// Same Admin SDK instance as the service (both resolve from functions/node_modules).
const { auth, db } = await import("../../functions/lib/admin.js");
const staff = await import("../../functions/services/staff.js");

const fixtures = [];
async function person(email, { verified = true } = {}) {
  const user = await auth.createUser({ email, emailVerified: verified });
  fixtures.push(user.uid);
  return user;
}

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await promisify(execFile)(process.execPath, ["functions/scripts/migrate.mjs"], { env: { ...process.env, GCLOUD_PROJECT: PROJECT } });
});
after(async () => {
  await Promise.all(fixtures.map((uid) => auth.deleteUser(uid).catch(() => {})));
});

test("claimOwner refuses when the server has no OWNER_EMAIL, the wrong email, or an unverified email", async () => {
  const u = await person("owner@shop.test");
  await assert.rejects(staff.claimOwner({ uid: u.uid, email: u.email, emailVerified: true, ownerEmail: "" }), (e) => e.code === "failed-precondition");
  await assert.rejects(staff.claimOwner({ uid: u.uid, email: "intruder@shop.test", emailVerified: true, ownerEmail: "owner@shop.test" }), (e) => e.code === "permission-denied");
  await assert.rejects(staff.claimOwner({ uid: u.uid, email: u.email, emailVerified: false, ownerEmail: "owner@shop.test" }), (e) => e.code === "failed-precondition");
  assert.equal((await auth.getUser(u.uid)).customClaims?.staff, undefined, "no access granted by failed attempts");
});

test("the configured, verified owner email can claim once; nobody can claim after that", async () => {
  const owner = await person("store.owner@shop.test");
  const result = await staff.claimOwner({ uid: owner.uid, email: "Store.Owner@shop.test", emailVerified: true, ownerEmail: "store.owner@shop.test" });
  assert.deepEqual(result.roles, ["owner"]);

  const claims = (await auth.getUser(owner.uid)).customClaims;
  assert.equal(claims.staff, true);
  assert.deepEqual(claims.roles, ["owner"]);
  assert.ok(claims.perms.includes("staff.manage") && claims.perms.includes("settings.manage"));

  const record = (await db.doc(`staff/${owner.uid}`).get()).data();
  assert.equal(record.status, "active");
  assert.deepEqual(record.roles, ["owner"]);

  const second = await person("second@shop.test");
  await assert.rejects(staff.claimOwner({ uid: second.uid, email: "second@shop.test", emailVerified: true, ownerEmail: "second@shop.test" }), (e) => e.code === "already-exists");

  const audit = await db.collection("auditLogs").where("entityId", "==", owner.uid).get();
  assert.equal(audit.size, 1);
  assert.equal(audit.docs[0].data().action, "staff.roles_set");
});

test("roles map to exactly the role's permissions; owner-only permissions never leak", async () => {
  const s = await person("orders@shop.test");
  const r = await staff.setStaffRoles({ email: "orders@shop.test", roles: ["order_manager"], actorUid: "test" });
  assert.ok(r.perms.includes("orders.update"));
  assert.ok(!r.perms.includes("staff.manage") && !r.perms.includes("costs.read"));

  // Even if an Owner edits the role to include owner-only permissions…
  await db.doc("roles/order_manager").update({ permissions: [...r.perms, "staff.manage", "settings.manage"] });
  const again = await staff.setStaffRoles({ uid: s.uid, roles: ["order_manager"], actorUid: "test" });
  assert.ok(!again.perms.includes("staff.manage") && !again.perms.includes("settings.manage"));
});

test("removing a permission revokes the person's sessions; removing all roles removes staff access", async () => {
  const s = await person("stock@shop.test");
  await staff.setStaffRoles({ uid: s.uid, roles: ["inventory_manager", "content_manager"], actorUid: "test" });
  const before = (await auth.getUser(s.uid)).tokensValidAfterTime;

  await new Promise((r) => setTimeout(r, 1100)); // tokensValidAfterTime has 1-second resolution
  await staff.setStaffRoles({ uid: s.uid, roles: ["inventory_manager"], actorUid: "test" });
  const afterDowngrade = await auth.getUser(s.uid);
  assert.notEqual(afterDowngrade.tokensValidAfterTime, before, "sessions revoked on downgrade");
  assert.ok(!afterDowngrade.customClaims.perms.includes("content.manage"));

  await staff.setStaffRoles({ uid: s.uid, roles: [], actorUid: "test" });
  const removed = await auth.getUser(s.uid);
  assert.equal(removed.customClaims?.staff, undefined);
  assert.equal((await db.doc(`staff/${s.uid}`).get()).data().status, "removed");
});

test("the last Owner cannot be removed", async () => {
  const owners = await db.collection("staff").where("roles", "array-contains", "owner").where("status", "==", "active").get();
  assert.equal(owners.size, 1);
  await assert.rejects(staff.setStaffRoles({ uid: owners.docs[0].id, roles: [], actorUid: "test" }), (e) => e.code === "failed-precondition" && /at least one Owner/.test(e.message));
});

test("unknown people and unknown roles are refused", async () => {
  await assert.rejects(staff.setStaffRoles({ email: "nobody@shop.test", roles: ["owner"], actorUid: "test" }), (e) => e.code === "not-found");
  const s = await person("x@shop.test");
  await assert.rejects(staff.setStaffRoles({ uid: s.uid, roles: ["superuser"], actorUid: "test" }), (e) => e.code === "invalid-argument");
});
