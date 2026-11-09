import { test } from "node:test";
import assert from "node:assert/strict";
import { saveSettingsSchema, publicSettingsSchema, privateSettingsSchema, httpsUrl } from "../../shared/schemas/index.js";
import { MODULES, visibleModules, moduleForPath } from "../../src/admin/modules.js";
import { DEFAULT_ROLES, effectivePermissions } from "../../shared/permissions.js";

const pub = { storeName: "Italian Shoes", phone: "0342-7530608", instagram: "https://www.instagram.com/italianshoesofficial/" };
const priv = { orderPrefix: "is", lowStockThreshold: 3 };

test("owner-entered links must be https (no javascript: or other unsafe links)", () => {
  assert.equal(httpsUrl.parse(" https://instagram.com/x "), "https://instagram.com/x");
  assert.equal(httpsUrl.parse(""), "");
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>", "http://instagram.com/x", "instagram.com/x", "//evil.example"]) {
    assert.equal(httpsUrl.safeParse(bad).success, false, bad);
  }
});

test("settings are cleaned and validated", () => {
  const s = saveSettingsSchema.parse({ public: pub, private: priv });
  assert.equal(s.private.orderPrefix, "IS");
  assert.equal(s.public.currency, "PKR");
  assert.equal(s.public.isOpen, true);
  assert.equal(s.private.taxEnabled, false, "tax is off unless the owner turns it on");
  assert.equal(publicSettingsSchema.safeParse({ ...pub, storeName: "" }).success, false);
  assert.equal(publicSettingsSchema.safeParse({ ...pub, phone: "call me" }).success, false);
  assert.equal(publicSettingsSchema.safeParse({ ...pub, email: "nope" }).success, false);
  assert.equal(publicSettingsSchema.safeParse({ ...pub, currency: "USD" }).success, false, "currency is PKR only");
  assert.equal(privateSettingsSchema.safeParse({ ...priv, orderPrefix: "IS-1" }).success, false);
  assert.equal(privateSettingsSchema.safeParse({ ...priv, lowStockThreshold: NaN }).success, false);
  assert.equal(privateSettingsSchema.safeParse({ ...priv, lowStockThreshold: 2.5 }).success, false);
  assert.equal(privateSettingsSchema.safeParse({ ...priv, taxRatePercent: 50 }).success, false);
  const extra = saveSettingsSchema.parse({ public: { ...pub, updatedBy: "attacker" }, private: { ...priv, ownerUid: "x" } });
  assert.equal("updatedBy" in extra.public || "ownerUid" in extra.private, false, "unknown fields dropped");
});

test("each role sees only its modules; unbuilt modules are marked, not linked", () => {
  const owner = visibleModules(DEFAULT_ROLES.owner.permissions).map((m) => m.key);
  assert.equal(owner.length, MODULES.length, "owner sees every module");

  const content = visibleModules(effectivePermissions(["content_manager"])).map((m) => m.key);
  assert.ok(content.includes("content") && content.includes("overview") && content.includes("notifications"));
  for (const hidden of ["settings", "activity", "staff", "orders", "payments"]) assert.ok(!content.includes(hidden), hidden);

  const orders = visibleModules(effectivePermissions(["order_manager"])).map((m) => m.key);
  assert.ok(orders.includes("orders") && !orders.includes("settings") && !orders.includes("activity"));

  for (const m of MODULES) assert.ok(Boolean(m.soon) !== Boolean(m.load), `${m.key}: either built (load) or marked soon`);
});

test("admin paths resolve to modules", () => {
  assert.equal(moduleForPath("/admin")?.key, "overview");
  assert.equal(moduleForPath("/admin/")?.key, "overview");
  assert.equal(moduleForPath("/admin/settings")?.key, "settings");
  assert.equal(moduleForPath("/admin/nope"), null);
});
