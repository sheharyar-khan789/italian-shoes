import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateByWeight, computeSaleLines, costTotals, salePaymentFields, SALE_PAYMENT_METHODS } from "../../shared/sales.js";
import { saleSchema, recordSalePaymentInput, reverseSalePaymentInput } from "../../shared/schemas/index.js";

test("a discount is shared over lines exactly, in proportion, never more than a line", () => {
  assert.deepEqual(allocateByWeight(0, [100, 200]), [0, 0]);
  assert.deepEqual(allocateByWeight(300, [100, 200]), [100, 200]);
  const shares = allocateByWeight(101, [333, 1000, 7]);
  assert.equal(shares.reduce((n, x) => n + x, 0), 101, "adds up exactly");
  assert.ok(shares.every((x, i) => x <= [333, 1000, 7][i]));
  assert.deepEqual(allocateByWeight(5, [0, 0]), [0, 0], "nothing to share over");
});

const item = (over = {}) => ({ productId: "p", variantId: "v", sku: "S-1", productName: "Oxford", variantLabel: "Black / EU 42", qty: 2, unitPrice: 90000, regularPrice: 100000, lineTotal: 180000, ...over });

test("sale lines snapshot prices, markdown, coupon share, cost and warehouses", () => {
  const { lines, costLines } = computeSaleLines([item(), item({ productId: "q", qty: 1, unitPrice: 50000, regularPrice: 50000, lineTotal: 50000 })], 23000, [60000, null], [[{ warehouseId: "main", qty: 1 }, { warehouseId: "shop", qty: 1 }], null], "main");
  assert.equal(lines[0].itemDiscount, 20000, "(1,000 − 900) × 2");
  assert.equal(lines[1].itemDiscount, 0);
  assert.equal(lines[0].couponShare + lines[1].couponShare, 23000);
  assert.equal(lines[0].lineNet, 180000 - lines[0].couponShare);
  assert.deepEqual(lines[0].allocations, [{ warehouseId: "main", qty: 1 }, { warehouseId: "shop", qty: 1 }]);
  assert.deepEqual(lines[1].allocations, [{ warehouseId: "main", qty: 1 }], "no record → the default warehouse");
  assert.equal(lines[0].colorName, "Black");
  assert.equal(lines[0].sizeLabel, "EU 42");
  assert.deepEqual([costLines[0].unitCost, costLines[0].lineCost, costLines[1].costKnown, costLines[1].lineCost], [60000, 120000, false, null]);
});

test("gross profit is only stated when every line's cost is known", () => {
  const known = [{ costKnown: true, lineCost: 120000, lineNet: 160000 }, { costKnown: true, lineCost: 30000, lineNet: 50000 }];
  assert.deepEqual(costTotals(known, 210000), { costComplete: true, costTotal: 150000, grossProfit: 60000 });
  const partial = [known[0], { costKnown: false, lineCost: null, lineNet: 50000 }];
  assert.deepEqual(costTotals(partial, 210000), { costComplete: false, costTotal: null, grossProfit: null });
  assert.equal(costTotals([], 0).costComplete, false);
});

test("payment summary from a payment record (old records without paidTotal included)", () => {
  assert.deepEqual(salePaymentFields({ amount: 1000, status: "pending" }), { paymentStatus: "pending", paidTotal: 0, refundedTotal: 0, amountDue: 1000 });
  assert.deepEqual(salePaymentFields({ amount: 1000, status: "collected" }), { paymentStatus: "collected", paidTotal: 1000, refundedTotal: 0, amountDue: 0 });
  assert.deepEqual(salePaymentFields({ amount: 1000, status: "partially_paid", paidTotal: 400 }), { paymentStatus: "partially_paid", paidTotal: 400, refundedTotal: 0, amountDue: 600 });
  assert.equal(salePaymentFields({ amount: 1000, status: "void" }).amountDue, 0, "a voided payment owes nothing");
  assert.equal(salePaymentFields({ amount: 1000, status: "partially_refunded", refundedTotal: 300 }).paidTotal, 1000);
});

const goodSale = () => {
  const { lines } = computeSaleLines([item()], 10000, [60000], [null], "main");
  return {
    number: "SL-000001", channel: "online", orderId: "o1", orderNumber: "IS-2026-000001", customerId: "u1", customer: { name: "A", phone: "0300", email: null }, customerPhone: "0300", address: null, shippingMethod: null,
    warehouseId: "main", warehouseIds: ["main"], lines, itemCount: 2, grossSales: 200000, itemDiscountTotal: 20000, subtotal: 180000, discountTotal: 10000, couponCode: "X", netSales: 170000, taxTotal: 0, shippingTotal: 20000, total: 190000,
    paymentMethod: "cod", paymentStatus: "pending", paidTotal: 0, refundedTotal: 0, amountDue: 190000, status: "pending", stockApplied: true, idempotencyKey: "k", createdBy: "u1",
  };
};

test("the sale schema accepts a consistent sale and refuses ones that don't add up", () => {
  assert.equal(saleSchema.safeParse(goodSale()).success, true);
  for (const [field, value] of [["total", 190001], ["subtotal", 180001], ["discountTotal", 9999], ["netSales", 1], ["grossSales", 5], ["itemCount", 3], ["shippingTotal", 20001]]) {
    assert.equal(saleSchema.safeParse({ ...goodSale(), [field]: value }).success, false, `a wrong ${field} is refused`);
  }
  assert.equal(saleSchema.safeParse({ ...goodSale(), total: 190000.5 }).success, false, "paisa are whole numbers");
  assert.equal(saleSchema.safeParse({ ...goodSale(), channel: "kiosk" }).success, false);
  assert.equal(saleSchema.safeParse({ ...goodSale(), orderId: null }).success, false, "an online sale needs its order");
  assert.equal(saleSchema.safeParse({ ...goodSale(), channel: "pos", orderId: null }).success, true, "a walk-in sale has no order");
  assert.equal(saleSchema.safeParse({ ...goodSale(), paymentMethod: "card" }).success, false);
  const bad = goodSale();
  bad.lines[0].allocations = [{ warehouseId: "main", qty: 1 }];
  assert.equal(saleSchema.safeParse(bad).success, false, "warehouses must add up to the quantity");
  assert.deepEqual([...SALE_PAYMENT_METHODS], ["cod", "cash", "bank_transfer", "jazzcash", "easypaisa"]);
});

test("payment inputs: reference needed for transfers and wallets; amounts are whole positive paisa", () => {
  const base = { idempotencyKey: "abcdefgh1234", saleId: "s1", amount: 5000 };
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "cash" }).success, true);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "cod" }).success, true);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "bank_transfer" }).success, false);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "easypaisa", reference: "EP123" }).success, true);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "cash", amount: 0 }).success, false);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "cash", amount: 10.5 }).success, false);
  assert.equal(recordSalePaymentInput.safeParse({ ...base, method: "visa" }).success, false);
  assert.equal(reverseSalePaymentInput.safeParse({ idempotencyKey: "abcdefgh1234", saleId: "s1", transactionId: "t1", reason: "Typed the wrong amount" }).success, true);
  assert.equal(reverseSalePaymentInput.safeParse({ idempotencyKey: "abcdefgh1234", saleId: "s1", transactionId: "t1", reason: "x" }).success, false);
});
