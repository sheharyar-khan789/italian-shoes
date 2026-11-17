/**
 * Security regression tests (`npm run test:emulator`): live session checks on every staff request,
 * authentication on every endpoint, and private-file access. Accounts exist only in the emulator.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const { endpoints } = await import("../../functions/registry.js");
const { authorizeBlobUpload } = await import("../../functions/services/images.js");
const files = await import("../../functions/services/privateFiles.js");
const P = await import("../../functions/shared/permissions.js");
const { privateFileKind, isPrivateFileRef } = await import("../../functions/shared/privateFiles.js");
const { employeeDocInput } = await import("../../functions/shared/schemas/hr.js");

const FAR = 9999999999;
const staff = (uid, perms, authTime = FAR) => ({ uid, staff: true, perms, auth_time: authTime });
const TOKENS = {
  customer: { uid: "sec-customer", email: "c@example.test" },
  everything: staff("sec-ok", ["*"]),
  disabled: staff("sec-disabled", ["*"]),
  revoked: staff("sec-revoked", ["*"], 1000),
  deleted: staff("sec-deleted", ["*"]),
  finance: staff("sec-ok", ["finance.read"]),
  hrRead: staff("sec-ok", ["hr.read"]),
  hrSensitive: staff("sec-ok", ["hr.sensitive"]),
  hrWriter: staff("sec-ok", ["hr.write"]),
  nobody: staff("sec-ok", ["products.read"]),
  self1: staff("sec-self1", ["hr.self"]),
  self2: staff("sec-self2", ["hr.self"]),
  finDisabled: staff("sec-disabled", ["finance.read"]),
  hrDisabled: staff("sec-disabled", ["hr.write"]),
  finRevoked: staff("sec-revoked", ["finance.read"], 1000),
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data = {}) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });
const bearer = (t) => `Bearer ${t}`;
const code = async (p) => p.then(() => "ok", (e) => e.code);

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const uid of ["sec-ok", "sec-self1", "sec-self2"]) await auth.createUser({ uid }).catch(() => {});
  await auth.createUser({ uid: "sec-disabled", disabled: true }).catch(() => {});
  await auth.createUser({ uid: "sec-revoked" }).catch(() => {});
  await auth.revokeRefreshTokens("sec-revoked");
  await db.doc("employees/emp1").set({ name: "A", photoUrl: "hrphoto/mgr/me-AbC.png", staffUid: "sec-self1" });
  await db.doc("employees/emp2").set({ name: "B", photoUrl: "hrphoto/mgr/other-XyZ.png", staffUid: "sec-self2" });
});
after(async () => {
  await Promise.all(["sec-ok", "sec-self1", "sec-self2", "sec-disabled", "sec-revoked"].map((uid) => auth.deleteUser(uid).catch(() => {})));
});

/* ───────── Live session checks ───────── */

test("a disabled, revoked or deleted staff account is refused on EVERY endpoint, including ones that check permission inside the handler", async () => {
  const names = Object.keys(endpoints);
  assert.ok(names.length >= 200, "registry loaded");
  // Found by the browser tests: two endpoints once shared the name "inventoryReport" and one silently replaced the other.
  assert.ok(endpoints.inventoryReport && endpoints.stockSummaryReport && endpoints.inventoryReport !== endpoints.stockSummaryReport);
  const noStatic = names.filter((n) => !endpoints[n].options.permission);
  assert.ok(noStatic.length >= 20, "there are endpoints without a static permission (reports, HR self-service, ...)");
  for (const [label, token, status] of [["disabled", "disabled", 403], ["revoked", "revoked", 401], ["deleted", "deleted", 401]]) {
    for (const name of names) {
      const r = await call(name, token, {});
      assert.equal(r.status, status, `${name} (${label} staff) answered ${r.status}`);
    }
  }
});

test("active staff and customers are not affected by the session check", async () => {
  const r = await call("hrMyProfile", "self1", {});
  assert.notEqual(r.status, 401, "an active staff session passes the live check");
  const c = await call("quoteCheckout", "customer", {});
  assert.notEqual(c.status, 401, "a customer needs no staff lookup");
});

test("every endpoint demands sign-in, and every permission-protected endpoint refuses customers and staff without it", async () => {
  for (const name of Object.keys(endpoints)) {
    assert.equal((await call(name, null, {})).status, 401, `${name} signed out`);
    assert.equal(endpoints[name].options.auth, "required", `${name} must require auth`);
    const perm = endpoints[name].options.permission;
    if (perm) {
      assert.equal((await call(name, "customer", {})).status, 403, `${name} customer`);
      assert.equal((await call(name, "nobody", {})).status, 403, `${name} staff without ${perm}`);
    }
  }
});

/* ───────── Private files ───────── */

test("only well-formed private paths are accepted; public links and traversal are not", () => {
  assert.equal(privateFileKind("hr/u1/cnic-AbC123.png"), "hr");
  assert.equal(privateFileKind("hrphoto/u1/me.webp"), "hrphoto");
  assert.equal(privateFileKind("receipts/u1/b.pdf"), "receipts");
  for (const bad of ["https://x.public.blob.vercel-storage.com/hr/u1/a.png", "hr/u1/../../etc", "hr//a.png", "hr/u1", "uploads/p1/a.jpg", "HR/u1/a.png", "hr/u1/a b.png", "", null, undefined, 5]) assert.equal(privateFileKind(bad), null, String(bad));
  assert.equal(isPrivateFileRef("hr/u1/a.png", "receipts"), false);
});

test("records refuse public links for CNIC documents and photos", () => {
  const doc = { employeeId: "e1", kind: "cnic", name: "Front", type: "image/png", size: 100 };
  assert.equal(employeeDocInput.safeParse({ ...doc, url: "hr/u1/a-1.png" }).success, true);
  assert.equal(employeeDocInput.safeParse({ ...doc, url: "https://abc.public.blob.vercel-storage.com/hr/u1/a.png" }).success, false);
  assert.equal(employeeDocInput.safeParse({ ...doc, url: "hrphoto/u1/a.png" }).success, false, "a photo path is not a document");
});

test("reading a private file: sign-in, staff access, permission, live session", async () => {
  const read = (path, token) => files.authorizePrivateRead({ path, authorization: token ? bearer(token) : undefined }, { verifyToken });
  assert.equal(await code(read("receipts/u/a.pdf", null)), "unauthenticated");
  assert.equal(await code(read("receipts/u/a.pdf", "bogus")), "unauthenticated");
  assert.equal(await code(read("receipts/u/a.pdf", "customer")), "permission-denied", "customers never read private files");
  assert.equal(await code(read("receipts/u/a.pdf", "nobody")), "permission-denied");
  assert.equal(await code(read("receipts/u/a.pdf", "finance")), "ok");
  assert.equal(await code(read("hr/u/cnic.png", "hrRead")), "permission-denied", "hr.read is not enough for CNIC copies and contracts");
  assert.equal(await code(read("hr/u/cnic.png", "finance")), "permission-denied");
  assert.equal(await code(read("hr/u/cnic.png", "hrSensitive")), "ok");
  assert.equal(await code(read("hr/u/cnic.png", "everything")), "ok", "the Owner's wildcard reaches it");
  assert.equal(await code(read("hrphoto/mgr/other-XyZ.png", "hrRead")), "ok");
  assert.equal(await code(read("hr/../etc/passwd", "everything")), "not-found");
  assert.equal(await code(read("https://x.public.blob.vercel-storage.com/hr/a.png", "everything")), "not-found");
  assert.equal(await code(read("receipts/u/a.pdf", "finDisabled")), "permission-denied", "a disabled account is refused");
  assert.equal(await code(read("receipts/u/a.pdf", "finRevoked")), "unauthenticated", "a revoked session is refused");
});

test("an employee sees only their own photo; opening a CNIC copy is logged", async () => {
  const read = (path, token) => files.authorizePrivateRead({ path, authorization: bearer(token) }, { verifyToken });
  assert.equal(await code(read("hrphoto/mgr/me-AbC.png", "self1")), "ok");
  assert.equal(await code(read("hrphoto/mgr/other-XyZ.png", "self1")), "permission-denied");
  assert.equal(await code(read("hrphoto/mgr/me-AbC.png", "self2")), "permission-denied");
  assert.equal(await code(read("hr/u/cnic.png", "self1")), "permission-denied", "documents are never self-service");
  await read("hr/u/cnic-logged.png", "hrSensitive");
  const log = await db.collection("auditLogs").where("action", "==", "file.viewed").get();
  assert.ok(log.docs.some((d) => d.data().entityId === "hr/u/cnic-logged.png" && d.data().actorUid === "sec-ok"));
});

test("the file is fetched only from the private store, and a missing store or file is reported plainly", async () => {
  const original = files.privateBlobIO.get;
  const savedToken = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  try {
    delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
    assert.equal(await code(files.readPrivateFile("hr/u/a.png")), "unavailable");
    process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "test-token";
    files.privateBlobIO.get = async () => null;
    assert.equal(await code(files.readPrivateFile("hr/u/a.png")), "not-found");
    let asked = "";
    files.privateBlobIO.get = async (p) => { asked = p; return { statusCode: 200, stream: Readable.toWeb(Readable.from([Buffer.from("x")])), blob: { contentType: "image/png" } }; };
    const r = await files.readPrivateFile("hr/u/a.png");
    assert.equal(asked, "hr/u/a.png");
    assert.equal(r.statusCode, 200);
  } finally {
    files.privateBlobIO.get = original;
    if (savedToken === undefined) delete process.env.BLOB_PRIVATE_READ_WRITE_TOKEN; else process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = savedToken;
  }
});

test("the download route answers with safe headers and JSON errors", async () => {
  const handler = (await import("../../api/privateFile.js")).default;
  const run = async (req) => {
    const res = { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler(req, res);
    return res;
  };
  const post = await run({ method: "POST", headers: {}, query: {} });
  assert.equal(post.statusCode, 405);
  const anon = await run({ method: "GET", headers: {}, query: { path: "hr/u/a.png" } });
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.headers["cache-control"], "private, no-store");
  assert.equal(anon.headers["x-content-type-options"], "nosniff");
});

test("upload permission: documents need hr.sensitive or hr.write, photos need hr.write; each person uploads only into their own folder", async () => {
  const ask = (pathname, token) => authorizeBlobUpload({ pathname, authorization: bearer(token) }, { verifyToken });
  assert.equal(await code(ask("hr/sec-ok/cnic", "hrSensitive")), "ok");
  assert.equal(await code(ask("hr/sec-ok/cnic", "hrWriter")), "ok");
  assert.equal(await code(ask("hr/sec-ok/cnic", "hrRead")), "permission-denied");
  assert.equal(await code(ask("hrphoto/sec-ok/me", "hrWriter")), "ok");
  assert.equal(await code(ask("hrphoto/sec-ok/me", "hrSensitive")), "permission-denied", "photos need hr.write");
  assert.equal(await code(ask("hrphoto/someone-else/me", "hrWriter")), "invalid-argument", "not into another person's folder");
  assert.equal(await code(ask("receipts/sec-ok/x", "nobody")), "permission-denied");
  assert.equal(await code(ask("hr/sec-ok/cnic", "hrDisabled")), "permission-denied", "a disabled account cannot get an upload token");
});

/* ───────── Role boundaries ───────── */

test("every default role can call exactly the endpoints its permissions name — Owner, staff, cashier, HR and employee", async () => {
  const roles = { ...P.DEFAULT_ROLES, ...P.POS_ROLES, ...P.HR_ROLES };
  const protectedEndpoints = Object.entries(endpoints).filter(([, e]) => e.options.permission);
  assert.ok(protectedEndpoints.length > 190);
  for (const key of Object.keys(roles)) {
    const uid = `sec-role-${key}`;
    await auth.createUser({ uid }).catch(() => {});
    const perms = P.effectivePermissions([key], roles);
    const claim = P.claimPerms(perms);
    TOKENS[uid] = staff(uid, claim);
    for (const [name, e] of protectedEndpoints) {
      const r = await call(name, uid, {});
      const allowed = perms.includes(e.options.permission);
      if (allowed) assert.ok(r.status !== 403 && r.status !== 401, `${key} should reach ${name} (needs ${e.options.permission}) but got ${r.status}`);
      else assert.equal(r.status, 403, `${key} must NOT reach ${name} (needs ${e.options.permission})`);
    }
    if (key !== "owner") for (const p of P.OWNER_ONLY) assert.equal(perms.includes(p), false, `${key} must not hold ${p}`);
    await auth.deleteUser(uid).catch(() => {});
  }
  assert.deepEqual(P.claimPerms(P.effectivePermissions(["owner"], roles)), ["*"], "the Owner carries the compact wildcard claim");
});
