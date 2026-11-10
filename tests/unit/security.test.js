/**
 * Security regression tests: fail if a protection is weakened by accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hasPermission } from "../../functions/lib/callable.js";
import { callerIp } from "../../functions/lib/rateLimit.js";

const firebase = JSON.parse(readFileSync("firebase.json", "utf8"));
const headers = Object.fromEntries(firebase.hosting.headers.find((h) => h.source === "**").headers.map((h) => [h.key, h.value]));
const csp = Object.fromEntries(
  headers["Content-Security-Policy"].split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]),
);

test("Content Security Policy stays strict", () => {
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["script-src"], ["'self'"], "no inline or third-party scripts");
  for (const [name, values] of Object.entries(csp)) {
    assert.ok(!values.includes("'unsafe-eval'"), `${name} must not allow eval`);
    assert.ok(!values.includes("*"), `${name} must not allow everything`);
    if (name !== "style-src") assert.ok(!values.includes("'unsafe-inline'"), `${name} must not allow inline code`);
  }
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"], "no clickjacking");
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  assert.ok("upgrade-insecure-requests" in csp);
});

test("other security headers are present", () => {
  assert.match(headers["Strict-Transport-Security"], /max-age=\d{8,}/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.match(headers["Permissions-Policy"], /camera=\(\)/);
});

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const sources = ["index.html", ...walk("src").filter((f) => f.endsWith(".js"))];

test("no inline scripts or inline event handlers anywhere (the CSP would block them)", () => {
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(text), `${file}: inline <script>`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(text.replace(/\/\/.*$/gm, "")), `${file}: inline on…= handler`);
    assert.ok(!/javascript:/i.test(text), `${file}: javascript: URL`);
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(text), `${file}: eval / new Function`);
  }
});

test("every link opening a new tab cuts the opener and referrer", () => {
  for (const file of sources) {
    for (const m of readFileSync(file, "utf8").matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      assert.match(m[0], /rel="noopener noreferrer"/, `${file}: ${m[0].slice(0, 80)}`);
    }
  }
});

test("browser code never references an admin key or the Admin SDK", () => {
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/from\s+["']firebase-admin|import\(\s*["']firebase-admin/.test(text), `${file}: imports the Admin SDK`);
    assert.ok(!/"type"\s*:\s*"service_account"|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${file}: contains key material`);
  }
});

test("staff permission checks require a staff token carrying that exact permission", () => {
  assert.equal(hasPermission(null, "orders.read"), false);
  assert.equal(hasPermission({ uid: "x" }, "orders.read"), false, "plain customer");
  assert.equal(hasPermission({ staff: true }, "orders.read"), false, "staff without perms");
  assert.equal(hasPermission({ staff: "true", perms: ["orders.read"] }, "orders.read"), false, "string 'true' is not true");
  assert.equal(hasPermission({ staff: true, perms: "orders.read" }, "orders.read"), false, "perms must be a list");
  assert.equal(hasPermission({ staff: true, perms: ["orders.read"] }, "orders.update"), false);
  assert.equal(hasPermission({ staff: true, perms: ["orders.read"] }, "orders.read"), true);
});

test("rate-limit identity uses the first forwarded IP", () => {
  assert.equal(callerIp({ headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }), "203.0.113.5");
  assert.equal(callerIp({ headers: {}, ip: "198.51.100.7" }), "198.51.100.7");
  assert.equal(callerIp(undefined), "unknown");
});

test("security rules start from deny-all", () => {
  for (const file of ["firestore.rules"]) {
    const rules = readFileSync(file, "utf8");
    assert.match(rules, /allow read, write: if false;/, file);
    // The only unconditional allow anywhere: reading the public store settings.
    const open = [...rules.matchAll(/match\s+(\S+)\s*\{[^{}]*?allow ([a-z, ]+): if true;/g)].map((m) => `${m[1]} ${m[2]}`);
    // Public reference data, the owner-written home-page layout (content/home) only (photos are served by Vercel Blob, not Firestore). Anything else fails this test.
    const expected = {
      "firestore.rules": ["/settings/public read", "/categories/{id} read", "/brands/{id} read", "/colors/{id} read", "/sizes/{id} read", "/content/{doc} read"]
    }[file];
    assert.deepEqual(open, expected, `${file}: unexpected "if true"`);
    assert.ok(!/allow [a-z, ]*(write|create|update|delete)[a-z, ]*: if true/.test(rules), `${file}: no unconditional writes`);
  }
});

test("secret scanner blocks a key in an innocently named file", () => {
  const probe = "tests/unit/.tmp-secret-probe.txt";
  // Built at runtime so this test file itself never contains the pattern it scans for.
  writeFileSync(probe, `{"type": "${["service", "account"].join("_")}"}`);
  try {
    assert.throws(() => execFileSync(process.execPath, ["scripts/check-secrets.mjs"], { stdio: "pipe" }), /exit|status|Command failed/i);
  } finally {
    rmSync(probe, { force: true });
  }
  execFileSync(process.execPath, ["scripts/check-secrets.mjs"], { stdio: "pipe" }); // clean again → passes
});
