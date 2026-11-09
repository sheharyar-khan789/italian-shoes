import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordSchema, signUpSchema, signInSchema, profileSchema, setStaffRolesSchema, savedAddressSchema } from "../../shared/schemas/index.js";
import { safeNext } from "../../src/app/safeNext.js";
import { friendlyAuthError } from "../../src/app/authErrors.js";

test("password policy", () => {
  for (const ok of ["shoes2026store", "Sarai Alamgir 1", "ab12cd34ef56"]) assert.ok(passwordSchema.safeParse(ok).success, ok);
  for (const bad of ["short1", "onlyletterslong", "1234567890", "aaaaaaaaa1", "a".repeat(129) + "1"]) {
    assert.equal(passwordSchema.safeParse(bad).success, false, bad);
  }
});

test("sign-up input is cleaned and validated", () => {
  const r = signUpSchema.parse({ name: "  Test   Customer ", email: " Someone@Example.COM ", phone: "0300-1234567", password: "shoes2026store" });
  assert.equal(r.name, "Test Customer");
  assert.equal(r.email, "someone@example.com", "emails are lower-cased (must match the Auth token)");
  assert.equal(r.phone, "+92 300 1234567");
  assert.ok(signUpSchema.safeParse({ name: "Test Customer", email: "a@b.co", password: "shoes2026store" }).success, "phone is optional");
  assert.equal(signUpSchema.safeParse({ name: "Al", email: "a@b.co", password: "shoes2026store" }).success, false);
  assert.equal(signUpSchema.safeParse({ name: "Test Customer", email: "not-an-email", password: "shoes2026store" }).success, false);
  const extra = signUpSchema.parse({ name: "Test Customer", email: "a@b.co", password: "shoes2026store", isAdmin: true, roles: ["owner"] });
  assert.equal("isAdmin" in extra || "roles" in extra, false, "sign-up can never carry roles or admin flags");
});

test("sign-in and profile", () => {
  assert.equal(signInSchema.safeParse({ email: "a@b.co", password: "" }).success, false);
  assert.equal(profileSchema.parse({ name: "Test Customer", phone: "" }).phone, "");
  assert.equal(profileSchema.parse({ name: "Test Customer", phone: "03001234567" }).phone, "+92 300 1234567");
  assert.equal(profileSchema.safeParse({ name: "Test Customer", phone: "12345" }).success, false);
  const p = profileSchema.parse({ name: "Test Customer", phone: "", status: "active", email: "x@y.z" });
  assert.deepEqual(Object.keys(p).sort(), ["name", "phone"], "only name and phone are editable");
});

test("saved address matches the format the security rules require", () => {
  const a = savedAddressSchema.parse({ name: "Test Customer", phone: "0300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1, Street 2, near park" });
  assert.match(a.phone, /^\+92 3\d{2} \d{7}$/, "same regex as firestore.rules pkMobile()");
  assert.equal(a.label, "");
  assert.equal(a.isDefault, false);
});

test("staff role changes accept only known roles and exactly one target", () => {
  assert.ok(setStaffRolesSchema.safeParse({ email: "staff@example.com", roles: ["order_manager"] }).success);
  assert.ok(setStaffRolesSchema.safeParse({ uid: "abc", roles: [] }).success, "empty list removes access");
  assert.equal(setStaffRolesSchema.safeParse({ email: "s@e.com", roles: ["superadmin"] }).success, false);
  assert.equal(setStaffRolesSchema.safeParse({ roles: ["owner"] }).success, false, "needs a target");
  assert.equal(setStaffRolesSchema.safeParse({ uid: "a", email: "s@e.com", roles: [] }).success, false, "not both");
});

test("post-login redirects stay on this site (no open redirect)", () => {
  assert.equal(safeNext("/account/addresses"), "/account/addresses");
  assert.equal(safeNext("/shop?size=42#top"), "/shop?size=42#top");
  for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil.example", "", null]) {
    assert.equal(safeNext(evil), "/account", String(evil));
  }
  assert.equal(safeNext("//evil.example", "/"), "/");
});

test("sign-in errors never reveal whether an email has an account", () => {
  const a = friendlyAuthError({ code: "auth/user-not-found" });
  const b = friendlyAuthError({ code: "auth/wrong-password" });
  const c = friendlyAuthError({ code: "auth/invalid-credential" });
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(friendlyAuthError({ code: "auth/too-many-requests" }), /Too many attempts/);
  assert.equal(friendlyAuthError(new Error("socket hang up at 10.0.0.3")), "Something went wrong. Please try again.", "unknown errors are generic");
  assert.equal(friendlyAuthError({ code: "functions/already-exists", message: "This store already has an Owner." }), "This store already has an Owner.");
  assert.equal(friendlyAuthError({ code: "functions/internal", message: "stack trace…" }), "Something went wrong. Please try again.");
});
