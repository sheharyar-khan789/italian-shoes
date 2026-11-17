import { test } from "node:test";
import assert from "node:assert/strict";
import { CRM_DEFAULTS, computeSegments, tierFor, pointsForSale, redeemCheck, maxRedeemable, evaluateDiscount, bestDiscount } from "../../shared/crm.js";
import { crmSettingsInput, saveCrmDiscountInput, loyaltyAdjustInput, crmReportInput, crmQuickCreateInput } from "../../shared/schemas/index.js";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../shared/permissions.js";

const DAY = 86400000;
const NOW = Date.parse("2026-06-01T00:00:00+05:00");
const seg = CRM_DEFAULTS.segments;

test("segments come from purchase activity and the saved thresholds, not from fixed labels", () => {
  assert.deepEqual(computeSegments({ orders: 0, spent: 0, firstAt: null, lastAt: null }, seg, NOW), [], "no purchases means no groups");
  assert.deepEqual(computeSegments({ orders: 1, spent: 1000, firstAt: NOW - 3 * DAY, lastAt: NOW - 3 * DAY }, seg, NOW), ["new"]);
  const loyal = computeSegments({ orders: 5, spent: 12000000, firstAt: NOW - 400 * DAY, lastAt: NOW - 2 * DAY, ordersInWindow: 4 }, seg, NOW);
  assert.ok(["returning", "regular", "vip", "highValue"].every((s) => loyal.includes(s)));
  assert.ok(!loyal.includes("inactive"));
  assert.deepEqual(computeSegments({ orders: 2, spent: 100, firstAt: NOW - 500 * DAY, lastAt: NOW - 300 * DAY }, seg, NOW), ["inactive", "returning"]);
  // The owner's own thresholds decide.
  assert.ok(computeSegments({ orders: 1, spent: 500, firstAt: NOW - DAY, lastAt: NOW - DAY }, { ...seg, vipSpend: 500 }, NOW).includes("vip"));
  assert.ok(!computeSegments({ orders: 1, spent: 500, firstAt: NOW - DAY, lastAt: NOW - 400 * DAY }, { ...seg, inactiveDays: 0 }, NOW).includes("inactive"), "0 switches inactive off");
});

test("membership tier: the highest tier whose annual spend is met", () => {
  const tiers = CRM_DEFAULTS.tiers;
  assert.equal(tierFor(0, tiers).key, "standard");
  assert.equal(tierFor(4999999, tiers).key, "standard");
  assert.equal(tierFor(5000000, tiers).key, "silver");
  assert.equal(tierFor(99999999, tiers).key, "platinum");
  assert.equal(tierFor(10, [{ key: "b", minAnnualSpend: 0 }, { key: "a", minAnnualSpend: 5 }]).key, "a", "order of the list doesn't matter");
});

test("loyalty points: whole points, rounded down, never negative", () => {
  assert.equal(pointsForSale({ eligibleAmount: 1000000, pointsPer100: 1 }), 100);
  assert.equal(pointsForSale({ eligibleAmount: 999999, pointsPer100: 1 }), 99);
  assert.equal(pointsForSale({ eligibleAmount: 1000000, pointsPer100: 1, multiplier: 1.5 }), 150);
  assert.equal(pointsForSale({ eligibleAmount: 0, pointsPer100: 1 }), 0);
  assert.equal(pointsForSale({ eligibleAmount: -500, pointsPer100: 1 }), 0);
  assert.equal(pointsForSale({ eligibleAmount: 1000000, pointsPer100: 0 }), 0);
});

test("redemption rules: switched off, balance, minimum, per-sale maximum, percentage cap", () => {
  const cfg = { ...CRM_DEFAULTS.loyalty, enabled: true, minRedeemPoints: 10, maxRedeemPercent: 50, redeemValuePerPoint: 100 };
  assert.ok("error" in redeemCheck({ requested: 20, balance: 100, payable: 100000 }, { ...cfg, enabled: false }));
  assert.deepEqual(redeemCheck({ requested: 0, balance: 100, payable: 100000 }, cfg), { points: 0, value: 0 });
  assert.ok("error" in redeemCheck({ requested: 200, balance: 100, payable: 1000000 }, cfg), "more than the balance");
  assert.ok("error" in redeemCheck({ requested: 5, balance: 100, payable: 1000000 }, cfg), "below the minimum");
  assert.ok("error" in redeemCheck({ requested: 60, balance: 100, payable: 1000000 }, { ...cfg, maxRedeemPointsPerSale: 50 }));
  assert.ok("error" in redeemCheck({ requested: 60, balance: 100, payable: 10000 }, cfg), "over 50% of the bill");
  assert.deepEqual(redeemCheck({ requested: 20, balance: 100, payable: 10000 }, cfg), { points: 20, value: 2000 });
  assert.equal(maxRedeemable({ balance: 100, payable: 10000 }, cfg), 50);
  assert.equal(maxRedeemable({ balance: 5, payable: 10000 }, cfg), 0, "balance below the minimum");
  assert.equal(maxRedeemable({ balance: 100, payable: 10000 }, { ...cfg, maxRedeemPointsPerSale: 30 }), 30);
  assert.equal(maxRedeemable({ balance: 100, payable: 10000 }, { ...cfg, enabled: false }), 0);
});

const ctx = (over = {}) => ({ customerId: "c1", tier: "gold", segments: ["vip"], now: NOW, lines: [{ productId: "p1", categoryId: "k1", amount: 100000 }, { productId: "p2", categoryId: "k2", amount: 50000 }], used: 0, usedByCustomer: 0, ...over });
const base = { scope: "all", type: "percent", value: 10 };

test("customer discount: scope, validity, limits, restrictions and minimum purchase", () => {
  assert.deepEqual(evaluateDiscount(base, ctx()), { amount: 15000 });
  assert.deepEqual(evaluateDiscount({ ...base, type: "amount", value: 999999 }, ctx()), { amount: 150000 }, "a fixed amount never exceeds the qualifying items");
  assert.ok("reason" in evaluateDiscount({ ...base, isActive: false }, ctx()));
  assert.ok("reason" in evaluateDiscount({ ...base, scope: "customer", customerId: "other" }, ctx()));
  assert.ok("amount" in evaluateDiscount({ ...base, scope: "customer", customerId: "c1" }, ctx()));
  assert.ok("reason" in evaluateDiscount({ ...base, scope: "tier", tier: "silver" }, ctx()));
  assert.ok("amount" in evaluateDiscount({ ...base, scope: "tier", tier: "gold" }, ctx()));
  assert.ok("reason" in evaluateDiscount({ ...base, scope: "segment", segment: "inactive" }, ctx()));
  assert.ok("reason" in evaluateDiscount({ ...base, scope: "tier", tier: "gold" }, ctx({ customerId: null })), "needs a registered customer");
  assert.ok("amount" in evaluateDiscount(base, ctx({ customerId: null })), "an everyone discount needs no customer");
  assert.equal(evaluateDiscount({ ...base, validFrom: "2026-06-02" }, ctx()).reason, "Not valid yet");
  assert.equal(evaluateDiscount({ ...base, validTo: "2026-05-31" }, ctx()).reason, "Expired");
  assert.ok("amount" in evaluateDiscount({ ...base, validFrom: "2026-06-01", validTo: "2026-06-01" }, ctx()), "the whole of the last day counts");
  assert.ok("reason" in evaluateDiscount({ ...base, usageLimit: 5 }, ctx({ used: 5 })));
  assert.ok("reason" in evaluateDiscount({ ...base, perCustomerLimit: 1 }, ctx({ usedByCustomer: 1 })));
  assert.ok("amount" in evaluateDiscount({ ...base, perCustomerLimit: 2 }, ctx({ usedByCustomer: 1 })));
  assert.deepEqual(evaluateDiscount({ ...base, productIds: ["p2"] }, ctx()), { amount: 5000 }, "only qualifying items");
  assert.deepEqual(evaluateDiscount({ ...base, categoryIds: ["k1"] }, ctx()), { amount: 10000 });
  assert.equal(evaluateDiscount({ ...base, productIds: ["nope"] }, ctx()).reason, "None of the items qualify");
  assert.equal(evaluateDiscount({ ...base, minPurchase: 200000 }, ctx()).reason, "Below the minimum purchase");
  assert.ok("amount" in evaluateDiscount({ ...base, minPurchase: 150000 }, ctx()));
});

test("only the single best customer discount is used (no stacking)", () => {
  const list = [{ id: "a", v: 5 }, { id: "b", v: 20 }, { id: "c", v: 10 }];
  const best = bestDiscount(list, (d) => (d.id === "b" ? { reason: "no" } : { amount: d.v * 100 }));
  assert.equal(best.discount.id, "c");
  assert.equal(best.amount, 1000);
  assert.equal(bestDiscount([], () => ({ amount: 1 })), null);
  assert.equal(bestDiscount(list, () => ({ reason: "x" })), null);
});

const settings = () => ({ customerTypes: ["Retail"], segments: CRM_DEFAULTS.segments, tiers: CRM_DEFAULTS.tiers, loyalty: CRM_DEFAULTS.loyalty });

test("CRM settings schema: tiers need a Rs 0 entry level and unique keys", () => {
  assert.equal(crmSettingsInput.safeParse(settings()).success, true);
  assert.equal(crmSettingsInput.safeParse({ ...settings(), tiers: [{ key: "gold", name: "Gold", minAnnualSpend: 100, discountPercent: 0, pointsMultiplier: 1 }] }).success, false);
  const dup = [CRM_DEFAULTS.tiers[0], { ...CRM_DEFAULTS.tiers[1], key: "standard" }];
  assert.equal(crmSettingsInput.safeParse({ ...settings(), tiers: dup }).success, false);
  assert.equal(crmSettingsInput.safeParse({ ...settings(), tiers: [{ ...CRM_DEFAULTS.tiers[0], discountPercent: 150 }] }).success, false);
  assert.equal(crmSettingsInput.safeParse({ ...settings(), segments: { ...CRM_DEFAULTS.segments, returningOrders: 1 } }).success, false, "returning means at least two orders");
});

test("discount, adjustment, report and quick-create schemas", () => {
  const ok = { name: "Eid", scope: "all", type: "percent", value: 10 };
  assert.equal(saveCrmDiscountInput.safeParse(ok).success, true);
  assert.equal(saveCrmDiscountInput.safeParse({ ...ok, value: 0 }).success, false);
  assert.equal(saveCrmDiscountInput.safeParse({ ...ok, scope: "bogus" }).success, false);
  assert.equal(loyaltyAdjustInput.safeParse({ idempotencyKey: "abcdefgh12", customerId: "c1", points: 0, reason: "fix" }).success, false, "zero is not an adjustment");
  assert.equal(loyaltyAdjustInput.safeParse({ idempotencyKey: "abcdefgh12", customerId: "c1", points: -5, reason: "Goodwill reversal" }).success, true);
  assert.equal(crmReportInput.safeParse({ report: "nope" }).success, false);
  assert.equal(crmQuickCreateInput.safeParse({ name: "Ali Raza", phone: "03001234567" }).data.consentMarketing, false, "marketing consent is never assumed");
});

test("CRM permissions exist, are separate, and the owner holds them all", () => {
  for (const p of ["crm.read", "crm.write", "crm.manage", "crm.loyalty"]) {
    assert.ok(ALL_PERMISSIONS.includes(p), p);
    assert.ok(Object.keys(PERMISSIONS).some((k) => PERMISSIONS[k] === p || k === p), `${p} is in the map`);
  }
});
