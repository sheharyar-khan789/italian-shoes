import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOrder, allocateProportional } from "../../shared/purchase.js";
import { savePurchaseOrderInput, saveSupplierInput, supplierPaymentInput, supplierAdjustmentInput, supplierRefundInput, receiveGoodsInput, purchaseReportTablesInput } from "../../shared/schemas/index.js";

const L = (qty, unitCost, discount = 0) => ({ qty, unitCost, discount });

test("an order with no tax or charges is priced exactly as before", () => {
  const t = priceOrder([L(10, 100000, 5000), L(3, 250000)], 20000);
  assert.deepEqual([t.subtotal, t.orderDiscount, t.taxTotal, t.chargesTotal, t.total], [1745000, 20000, 0, 0, 1725000]);
  assert.equal(t.lines.reduce((n, l) => n + l.effective, 0), t.total);
  assert.ok(t.lines.every((l) => l.allocatedExtra === 0));
});

test("tax is a percentage of the order after discount; charges are added; the lines always add up to the total", () => {
  const t = priceOrder([L(10, 100000)], 100000, { taxPercent: 10, charges: 50000 });
  assert.deepEqual([t.subtotal, t.taxTotal, t.chargesTotal, t.total, t.lines[0].effective], [1000000, 90000, 50000, 1040000, 1040000]);
  const odd = priceOrder([L(3, 33333), L(7, 12345, 111), L(1, 99999)], 777, { taxPercent: 17.5, charges: 12345 });
  assert.equal(odd.lines.reduce((n, l) => n + l.effective, 0), odd.total, "no paisa lost or invented");
  assert.equal(odd.total, odd.subtotal - odd.orderDiscount + odd.taxTotal + odd.chargesTotal);
  assert.equal(odd.taxTotal, Math.round(((odd.subtotal - odd.orderDiscount) * 1750) / 10000), "half up");
  assert.ok(odd.lines.every((l) => l.allocatedExtra >= 0 && l.effective >= 0));
});

test("proportional sharing is exact for any amounts, including tiny and uneven weights", () => {
  assert.deepEqual(allocateProportional(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(allocateProportional(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocateProportional(7, [0, 0]), [0, 0], "nothing to share over");
  for (const [amount, weights] of [[1, [3, 3, 3, 3]], [999999, [1, 2, 3, 4, 5]], [123456789, [10 ** 9, 7, 13]]]) {
    const parts = allocateProportional(amount, weights);
    assert.equal(parts.reduce((n, p) => n + p, 0), amount);
    assert.ok(parts.every((p) => p >= 0));
  }
});

test("tax and charges are validated", () => {
  assert.throws(() => priceOrder([L(1, 1000)], 0, { taxPercent: 101 }), /Tax/);
  assert.throws(() => priceOrder([L(1, 1000)], 0, { taxPercent: -1 }), /Tax/);
  assert.throws(() => priceOrder([L(1, 1000)], 0, { charges: 1.5 }));
});

const base = { supplierId: "s1", warehouseId: "w1", lines: [{ productId: "p1", variantId: "v1", qty: 1, unitCost: 1000 }] };

test("order schema: tax up to 100% with two decimals, at most five charges each with an amount, five attachments", () => {
  assert.ok(savePurchaseOrderInput.safeParse({ ...base, taxPercent: 17.5, charges: [{ label: "Freight", amount: 500 }], purchaseDate: "2026-03-10" }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, taxPercent: 100.5 }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, taxPercent: 5.123 }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, taxPercent: -1 }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, charges: [{ label: "Freight", amount: 0 }] }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, charges: Array(6).fill({ label: "Fee", amount: 1 }) }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, purchaseDate: "2026-02-30" }).success);
  assert.ok(!savePurchaseOrderInput.safeParse({ ...base, attachments: [{ url: "https://example.com/a.pdf", name: "a", type: "application/pdf", size: 1 }] }).success);
});

test("supplier, receiving, payment, refund and adjustment schemas", () => {
  assert.ok(saveSupplierInput.safeParse({ name: "Al-Noor", whatsapp: "0300 1", taxNumber: "NTN-1" }).success);
  assert.ok(!saveSupplierInput.safeParse({ name: "Al-Noor", documents: Array(11).fill({ url: "receipts/u/a.pdf", name: "a", type: "application/pdf", size: 1 }) }).success);
  const line = { lineIndex: 0, acceptedQty: 1, rejectedQty: 1, rejectReason: "Split sole" };
  const g = receiveGoodsInput.parse({ idempotencyKey: "abcdefgh1234", purchaseOrderId: "po1", lines: [line] });
  assert.equal(g.lines[0].rejectKind, "damaged", "damaged is the default");
  assert.ok(receiveGoodsInput.safeParse({ idempotencyKey: "abcdefgh1234", purchaseOrderId: "po1", lines: [{ ...line, rejectKind: "missing" }] }).success);
  assert.ok(!receiveGoodsInput.safeParse({ idempotencyKey: "abcdefgh1234", purchaseOrderId: "po1", lines: [{ ...line, rejectKind: "lost" }] }).success);
  const pay = { idempotencyKey: "abcdefgh1234", supplierId: "s1", amount: 100, method: "cash", paidAt: "2026-01-02" };
  assert.equal(supplierPaymentInput.parse(pay).advance, false, "not an advance unless asked");
  assert.ok(supplierPaymentInput.safeParse({ ...pay, advance: true }).success);
  assert.ok(!supplierPaymentInput.safeParse({ ...pay, method: "bank_transfer" }).success, "a bank payment needs a reference");
  assert.ok(!supplierRefundInput.safeParse({ idempotencyKey: "abcdefgh1234", supplierId: "s1", amount: 100, method: "jazzcash", receivedAt: "2026-01-02" }).success);
  const adj = { idempotencyKey: "abcdefgh1234", supplierId: "s1", direction: "decrease", amount: 100, accountCode: "5020", reason: "Discount", date: "2026-01-02" };
  assert.ok(supplierAdjustmentInput.safeParse(adj).success);
  assert.ok(!supplierAdjustmentInput.safeParse({ ...adj, reason: "" }).success);
  assert.ok(!supplierAdjustmentInput.safeParse({ ...adj, direction: "sideways" }).success);
  assert.ok(!supplierAdjustmentInput.safeParse({ ...adj, amount: 0 }).success);
  assert.ok(!purchaseReportTablesInput.safeParse({ report: "ledger", from: "2026-01-01", to: "2026-01-31" }).success, "a ledger needs a supplier");
  assert.ok(purchaseReportTablesInput.safeParse({ report: "ledger", from: "2026-01-01", to: "2026-01-31", supplierId: "s1" }).success);
});
