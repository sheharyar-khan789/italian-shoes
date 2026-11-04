import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  canTransition,
  customerCanCancel,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  canTransitionPayment,
} from "../../shared/orderStatus.js";
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLES, OWNER_ONLY, effectivePermissions } from "../../shared/permissions.js";

test("every status has a transition entry and only targets known statuses", () => {
  for (const s of ORDER_STATUSES) {
    assert.ok(Array.isArray(ORDER_TRANSITIONS[s]), s);
    for (const t of ORDER_TRANSITIONS[s]) assert.ok(ORDER_STATUSES.includes(t), `${s} → ${t}`);
  }
  for (const s of PAYMENT_STATUSES) {
    for (const t of PAYMENT_TRANSITIONS[s]) assert.ok(PAYMENT_STATUSES.includes(t), `${s} → ${t}`);
  }
});

test("allowed and forbidden order transitions", () => {
  assert.ok(canTransition("pending", "confirmed"));
  assert.ok(canTransition("processing", "cancelled"));
  assert.ok(canTransition("dispatched", "delivered"));
  assert.ok(canTransition("delivered", "returned"));
  assert.ok(canTransition("returned", "refunded"));
  assert.equal(canTransition("dispatched", "cancelled"), false, "cannot cancel after dispatch");
  assert.equal(canTransition("delivered", "pending"), false, "no going backwards");
  assert.equal(canTransition("refunded", "pending"), false, "refunded is final");
  assert.equal(canTransition("pending", "delivered"), false, "no skipping steps");
  assert.equal(canTransition("bogus", "pending"), false);
  assert.equal(canTransition("pending", "pending"), false);
});

test("customers can cancel only pending orders", () => {
  assert.equal(customerCanCancel("pending"), true);
  for (const s of ORDER_STATUSES.filter((x) => x !== "pending")) assert.equal(customerCanCancel(s), false, s);
});

test("COD payment cannot jump from pending straight to refunded", () => {
  assert.ok(canTransitionPayment("pending", "collected"));
  assert.equal(canTransitionPayment("pending", "refunded"), false);
  assert.equal(canTransitionPayment("refunded", "collected"), false);
});

test("roles only use known permissions; owner has all", () => {
  for (const [key, role] of Object.entries(DEFAULT_ROLES)) {
    for (const p of role.permissions) assert.ok(p in PERMISSIONS, `${key}: ${p}`);
  }
  assert.deepEqual([...DEFAULT_ROLES.owner.permissions].sort(), [...ALL_PERMISSIONS].sort());
});

test("owner-only permissions can never reach other roles, even if granted by mistake", () => {
  const tampered = { order_manager: { permissions: ["orders.read", "staff.manage", "settings.manage", "made.up"] } };
  assert.deepEqual(effectivePermissions(["order_manager"], tampered), ["orders.read"]);
  for (const p of OWNER_ONLY) assert.ok(effectivePermissions(["owner"]).includes(p));
});

test("effective permissions combine roles without duplicates", () => {
  const perms = effectivePermissions(["inventory_manager", "content_manager"]);
  assert.ok(perms.includes("inventory.adjust") && perms.includes("content.manage"));
  assert.equal(perms.length, new Set(perms).size);
  assert.deepEqual(effectivePermissions(["nope"]), []);
  assert.ok(effectivePermissions(["inventory_manager"]).includes("costs.read"), "inventory manager can see cost prices");
  assert.ok(!effectivePermissions(["order_manager"]).includes("costs.read"), "order manager cannot see cost prices");
});
