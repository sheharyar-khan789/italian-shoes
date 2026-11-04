import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  placeOrderSchema,
  addressSchema,
  productSchema,
  variantSchema,
  stockAdjustmentSchema,
  couponSchema,
  shippingRateSchema,
  slug,
  fieldErrors,
} from "../../shared/schemas/index.js";

const address = { name: "Test Customer", phone: "0300-1234567", city: "Lahore", area: "Gulberg III", line1: "House 1, Street 2, near the park" };
const order = () => ({
  idempotencyKey: randomUUID(),
  items: [{ variantId: "v1", qty: 2 }],
  customer: { name: "Test Customer", phone: "0300 1234567" },
  address,
  shippingMethodId: "standard",
  paymentMethod: "cod",
  termsAccepted: true,
});

test("a valid order request passes and phone is normalised", () => {
  const r = placeOrderSchema.parse(order());
  assert.equal(r.customer.phone, "+92 300 1234567");
  assert.equal(r.address.phone, "+92 300 1234567");
});

test("order requests cannot carry prices, totals or payment status", () => {
  const r = placeOrderSchema.parse({ ...order(), total: 1, subtotal: 1, paymentStatus: "paid", items: [{ variantId: "v1", qty: 1, price: 1 }] });
  assert.equal("total" in r, false);
  assert.equal("paymentStatus" in r, false);
  assert.equal("price" in r.items[0], false, "unknown keys are stripped, never trusted");
});

test("order request rejections", () => {
  const bad = (patch, field) => {
    const r = placeOrderSchema.safeParse({ ...order(), ...patch });
    assert.equal(r.success, false, JSON.stringify(patch));
    if (field) assert.ok(Object.keys(fieldErrors(r.error)).some((k) => k.startsWith(field)), `expected error on ${field}: ${JSON.stringify(fieldErrors(r.error))}`);
  };
  bad({ items: [] }, "items");
  bad({ items: [{ variantId: "v1", qty: 0 }] }, "items");
  bad({ items: [{ variantId: "v1", qty: 11 }] }, "items");
  bad({ items: [{ variantId: "v1", qty: 1.5 }] }, "items");
  bad({ items: [{ variantId: "v1", qty: 1 }, { variantId: "v1", qty: 1 }] }, "items");
  bad({ items: [{ variantId: "a/b", qty: 1 }] }, "items");
  bad({ termsAccepted: false }, "termsAccepted");
  bad({ paymentMethod: "card" }, "paymentMethod");
  bad({ idempotencyKey: "not-a-uuid" }, "idempotencyKey");
  bad({ customer: { name: "Al", phone: "0300 1234567" } }, "customer.name");
  bad({ customer: { name: "Test Customer", phone: "12345" } }, "customer.phone");
  bad({ address: { ...address, line1: "short" } }, "address.line1");
});

test("address text is trimmed and collapsed", () => {
  const r = addressSchema.parse({ ...address, name: "  Test   Customer ", city: " Lahore " });
  assert.equal(r.name, "Test Customer");
  assert.equal(r.city, "Lahore");
});

test("products, variants and slugs", () => {
  assert.ok(slug.safeParse("cap-toe-oxford").success);
  for (const s of ["Cap Toe", "cap--toe", "-cap", "cap_toe", ""]) assert.equal(slug.safeParse(s).success, false, s);

  const p = productSchema.parse({ name: "Cap-Toe Oxford", slug: "cap-toe-oxford", categoryId: "formal", sku: " is-fo-001 " });
  assert.equal(p.sku, "IS-FO-001");
  assert.equal(p.status, "draft", "new products start as drafts, never auto-published");

  const v = { colorId: "black", sizeId: "eu-42", sku: "IS-FO-001-BLK-42", price: 1950000 };
  assert.ok(variantSchema.safeParse(v).success);
  assert.equal(variantSchema.safeParse({ ...v, price: 0 }).success, false, "zero price refused");
  assert.equal(variantSchema.safeParse({ ...v, price: 19500.5 }).success, false, "fractional paisa refused");
  assert.equal(variantSchema.safeParse({ ...v, salePrice: 1950000 }).success, false, "sale price must be lower");
  assert.ok(variantSchema.safeParse({ ...v, salePrice: 1750000 }).success);
});

test("stock adjustments need a reason, except initial stock", () => {
  assert.ok(stockAdjustmentSchema.safeParse({ variantId: "v1", change: 5, reason: "initial" }).success);
  assert.equal(stockAdjustmentSchema.safeParse({ variantId: "v1", change: -2, reason: "adjustment" }).success, false);
  assert.ok(stockAdjustmentSchema.safeParse({ variantId: "v1", change: -2, reason: "damaged", note: "Sole split" }).success);
  assert.equal(stockAdjustmentSchema.safeParse({ variantId: "v1", change: 0, reason: "initial" }).success, false);
  assert.equal(stockAdjustmentSchema.safeParse({ variantId: "v1", change: 2.5, reason: "initial" }).success, false);
});

test("coupons and shipping rates", () => {
  const c = { code: " eid10 ", type: "percent", value: 10 };
  assert.equal(couponSchema.parse(c).code, "EID10");
  assert.equal(couponSchema.safeParse({ ...c, value: 150 }).success, false);
  assert.equal(couponSchema.safeParse({ code: "FLAT", type: "fixed", value: 100.5 }).success, false);
  assert.equal(couponSchema.safeParse({ ...c, startsAt: "2026-12-10", endsAt: "2026-12-01" }).success, false);
  assert.ok(shippingRateSchema.safeParse({ methodId: "standard", city: "*", charge: 0 }).success);
  assert.equal(shippingRateSchema.safeParse({ methodId: "standard", city: "Lahore", charge: -1 }).success, false);
});
