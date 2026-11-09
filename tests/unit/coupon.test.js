import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCoupon } from "../../shared/coupon.js";

const base = { code: "SAVE10", type: "percent", value: 10, minOrder: 0, maxDiscount: null, startsAtMs: null, endsAtMs: null, usageLimit: null, perCustomerLimit: null, usedCount: 0, productIds: [], categoryIds: [], isActive: true };
const lines = [
  { productId: "p1", categoryId: "c1", lineTotal: 1000000 },
  { productId: "p2", categoryId: "c2", lineTotal: 500000 },
];
const ctx = { nowMs: 1_000, customerUses: 0 };
const run = (over, c = ctx, l = lines) => evaluateCoupon({ ...base, ...over }, l, c);

test("percent discount is taken from the whole bag and rounded down", () => {
  assert.deepEqual(run({}), { ok: true, discount: 150000 });
  assert.deepEqual(run({ value: 33.33 }, ctx, [{ productId: "p", lineTotal: 999 }]), { ok: true, discount: 332 });
});

test("fixed discount can never exceed what it applies to; max discount caps a percentage", () => {
  assert.deepEqual(run({ type: "fixed", value: 9999999 }), { ok: true, discount: 1500000 });
  assert.deepEqual(run({ value: 50, maxDiscount: 100000 }), { ok: true, discount: 100000 });
});

test("restricted to products or categories: only matching lines count", () => {
  assert.deepEqual(run({ productIds: ["p2"] }), { ok: true, discount: 50000 });
  assert.deepEqual(run({ categoryIds: ["c1"] }), { ok: true, discount: 100000 });
  const none = run({ productIds: ["zzz"] });
  assert.equal(none.ok, false);
});

test("each rule can refuse the coupon", () => {
  assert.match(run({ isActive: false }).message, /isn't active/);
  assert.match(run({ startsAtMs: 5_000 }).message, /isn't valid yet/);
  assert.match(run({ endsAtMs: 500 }).message, /expired/);
  assert.match(run({ usageLimit: 3, usedCount: 3 }).message, /fully used/);
  assert.match(run({ perCustomerLimit: 1 }, { nowMs: 1_000, customerUses: 1 }).message, /already used/);
  assert.match(run({ minOrder: 2000000 }).message, /minimum/);
});

test("boundaries: the last allowed use and the exact minimum still work", () => {
  assert.equal(run({ usageLimit: 3, usedCount: 2 }).ok, true);
  assert.equal(run({ perCustomerLimit: 2 }, { nowMs: 1_000, customerUses: 1 }).ok, true);
  assert.equal(run({ minOrder: 1500000 }).ok, true);
  assert.equal(run({ endsAtMs: 1_000 }).ok, true);
});
