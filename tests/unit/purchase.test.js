import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOrder, receiptValue, cumulativeValue, movingAverage, paymentStatusOf, divRound } from "../../shared/purchase.js";
import { receiveGoodsInput, supplierPaymentInput, purchaseReturnInput, savePurchaseOrderInput, saveSupplierInput } from "../../shared/schemas/index.js";

test("order pricing: line discounts, subtotal and total are exact whole paisa", () => {
  const r = priceOrder([{ qty: 10, unitCost: 120000, discount: 50000 }, { qty: 4, unitCost: 99950, discount: 0 }], 25000);
  assert.deepEqual(r.lines.map((l) => [l.gross, l.net]), [[1200000, 1150000], [399800, 399800]]);
  assert.equal(r.subtotal, 1549800);
  assert.equal(r.total, 1524800);
  assert.equal(r.lines.reduce((n, l) => n + l.effective, 0), r.total, "the lines add up to the total exactly");
  assert.equal(r.lines.reduce((n, l) => n + l.allocatedDiscount, 0), 25000, "the order discount is shared out with nothing lost");
});

test("an order discount that doesn't divide evenly is shared by largest remainder and still adds up", () => {
  const r = priceOrder([{ qty: 3, unitCost: 333 }, { qty: 2, unitCost: 500 }, { qty: 7, unitCost: 1 }], 101);
  assert.equal(r.lines.reduce((n, l) => n + l.allocatedDiscount, 0), 101);
  assert.equal(r.lines.reduce((n, l) => n + l.effective, 0), r.total);
  assert.ok(r.lines.every((l) => l.effective >= 0));
});

test("discounts bigger than the amount, bad quantities and empty orders are refused", () => {
  assert.throws(() => priceOrder([{ qty: 1, unitCost: 100, discount: 101 }]), /discount/);
  assert.throws(() => priceOrder([{ qty: 1, unitCost: 100 }], 101), /order discount/);
  assert.throws(() => priceOrder([{ qty: 0, unitCost: 100 }]), /Quantity/);
  assert.throws(() => priceOrder([{ qty: 1.5, unitCost: 100 }]), /Quantity/);
  assert.throws(() => priceOrder([{ qty: 1, unitCost: 10.5 }]));
  assert.throws(() => priceOrder([]));
});

test("receiving a line in parts adds up to exactly the line's amount (no rounding drift)", () => {
  for (const [effective, qty] of [[1000, 3], [999, 7], [1, 3], [123457, 11]]) {
    for (const split of [[1, 1, qty - 2], [qty], [qty - 1, 1]].filter((s) => s.every((x) => x > 0))) {
      let before = 0;
      let sum = 0;
      for (const part of split) {
        sum += receiptValue(effective, qty, before, part);
        before += part;
      }
      assert.equal(sum, effective, `effective ${effective}, qty ${qty}, parts ${split}`);
    }
  }
  assert.equal(cumulativeValue(1000, 3, 0), 0);
  assert.equal(cumulativeValue(1000, 3, 3), 1000);
  assert.equal(divRound(5, 2), 3, "half rounds up");
  assert.equal(divRound(4, 3), 1);
});

test("moving average cost", () => {
  // 10 pairs at Rs 1,000, then 10 more costing Rs 14,000 in total → Rs 1,200 average
  assert.equal(movingAverage({ onHandQty: 10, currentAvg: 100000, addQty: 10, addValue: 1400000 }), 120000);
  assert.equal(movingAverage({ onHandQty: 0, currentAvg: 100000, addQty: 4, addValue: 480000 }), 120000, "nothing on hand → the new cost");
  assert.equal(movingAverage({ onHandQty: 5, currentAvg: null, addQty: 5, addValue: 500000 }), 100000, "no cost on file → the new cost");
  assert.equal(movingAverage({ onHandQty: 3, currentAvg: 1000, addQty: 0, addValue: 0 }), 1000, "nothing added → unchanged");
  assert.equal(movingAverage({ onHandQty: 1, currentAvg: 100, addQty: 2, addValue: 201 }), 100, "(100 + 201) / 3 = 100.33 → 100");
  assert.equal(movingAverage({ onHandQty: 2, currentAvg: 100, addQty: 1, addValue: 103 }), 101, "(200 + 103) / 3 = 101");
});

test("payment status follows what was received, returned and paid", () => {
  assert.equal(paymentStatusOf({ receivedValue: 1000, paidTotal: 0 }), "unpaid");
  assert.equal(paymentStatusOf({ receivedValue: 1000, paidTotal: 400 }), "partial");
  assert.equal(paymentStatusOf({ receivedValue: 1000, paidTotal: 1000 }), "paid");
  assert.equal(paymentStatusOf({ receivedValue: 1000, returnedValue: 300, paidTotal: 700 }), "paid");
});

const ID = "p1";
test("purchasing inputs are validated", () => {
  const key = "abcdefgh12345678";
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 5000, method: "cash", paidAt: "2026-01-02" }).success, true);
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 5000, method: "jazzcash", paidAt: "2026-01-02" }).success, false, "non-cash needs a reference");
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 5000, method: "jazzcash", reference: "TX12345", paidAt: "2026-01-02" }).success, true);
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 0, method: "cash", paidAt: "2026-01-02" }).success, false, "zero");
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 5000, method: "card", paidAt: "2026-01-02" }).success, false, "unknown method");
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: key, supplierId: ID, amount: 5000, method: "cash", paidAt: "2999-01-01" }).success, false, "future date");
  assert.equal(supplierPaymentInput.safeParse({ idempotencyKey: "short", supplierId: ID, amount: 5000, method: "cash", paidAt: "2026-01-02" }).success, false, "key too short");

  const line = { lineIndex: 0, acceptedQty: 2, rejectedQty: 0 };
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [line] }).success, true);
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [{ ...line, acceptedQty: 0 }] }).success, false, "nothing received");
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [{ ...line, rejectedQty: 1 }] }).success, false, "rejection needs a reason");
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [{ ...line, rejectedQty: 1, rejectReason: "Sole came off" }] }).success, true);
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [line, line] }).success, false, "same line twice");
  assert.equal(receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: ID, lines: [{ ...line, acceptedQty: -1 }] }).success, false);

  assert.equal(purchaseReturnInput.safeParse({ idempotencyKey: key, grnId: ID, reason: "Wrong size", lines: [{ lineIndex: 0, qty: 1 }] }).success, true);
  assert.equal(purchaseReturnInput.safeParse({ idempotencyKey: key, grnId: ID, reason: "Wrong size", lines: [] }).success, false);
  assert.equal(purchaseReturnInput.safeParse({ idempotencyKey: key, grnId: ID, reason: "x", lines: [{ lineIndex: 0, qty: 1 }] }).success, false, "reason too short");

  const po = { supplierId: ID, warehouseId: ID, lines: [{ productId: "a", variantId: "b", qty: 2, unitCost: 100 }] };
  assert.equal(savePurchaseOrderInput.safeParse(po).success, true);
  assert.equal(savePurchaseOrderInput.safeParse({ ...po, lines: [po.lines[0], po.lines[0]] }).success, false, "duplicate variant");
  assert.equal(savePurchaseOrderInput.safeParse({ ...po, lines: [{ ...po.lines[0], unitCost: 0 }] }).success, false, "free goods need no purchase order cost of 0");
  assert.equal(savePurchaseOrderInput.safeParse({ ...po, lines: [{ ...po.lines[0], unitCost: 10.5 }] }).success, false, "paisa are whole numbers");

  assert.equal(saveSupplierInput.safeParse({ name: "Al-Noor Traders" }).data.openingBalance, 0, "no balance unless one is entered");
  assert.equal(saveSupplierInput.safeParse({ name: "A" }).success, false);
  assert.equal(saveSupplierInput.safeParse({ name: "Al-Noor", email: "nope" }).success, false);
  assert.equal(saveSupplierInput.safeParse({ name: "Al-Noor", openingBalance: -5 }).success, false);
});
