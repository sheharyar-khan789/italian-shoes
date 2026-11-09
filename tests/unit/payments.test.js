import { test } from "node:test";
import assert from "node:assert/strict";
import { recordCollectionInput, recordRefundInput, setPaymentMethodInput, saveShippingMethodInput, saveShippingRateInput, deleteShippingInput } from "../../shared/schemas/index.js";
import { canTransitionPayment, PAYMENT_STATUSES } from "../../shared/orderStatus.js";
import { PAYMENT_LABEL } from "../../src/ui/orderLabels.js";
import { MODULES, visibleModules } from "../../src/admin/modules.js";
import { effectivePermissions } from "../../shared/permissions.js";

test("payment status paths: void and refunds", () => {
  assert.ok(canTransitionPayment("pending", "collected"));
  assert.ok(canTransitionPayment("pending", "void"));
  assert.equal(canTransitionPayment("void", "collected"), false, "a voided payment can't be collected");
  assert.equal(canTransitionPayment("pending", "refunded"), false, "can't refund what wasn't collected");
  assert.ok(canTransitionPayment("collected", "partially_refunded") && canTransitionPayment("partially_refunded", "refunded"));
  for (const s of PAYMENT_STATUSES) assert.ok(PAYMENT_LABEL[s], `label for ${s}`);
});

test("refund and collection inputs", () => {
  assert.ok(recordCollectionInput.safeParse({ orderId: "o1" }).success);
  assert.ok(recordRefundInput.safeParse({ orderId: "o1", amount: 30000, reason: "Wrong size" }).success);
  assert.equal(recordRefundInput.safeParse({ orderId: "o1", amount: 0, reason: "Wrong size" }).success, false);
  assert.equal(recordRefundInput.safeParse({ orderId: "o1", amount: 300.5, reason: "Wrong size" }).success, false);
  assert.equal(recordRefundInput.safeParse({ orderId: "o1", amount: 100, reason: "  " }).success, false, "a reason is required");
  assert.equal(recordRefundInput.safeParse({ orderId: "o1", amount: -5, reason: "x y z" }).success, false);
  assert.ok(setPaymentMethodInput.safeParse({ key: "cod", isEnabled: false }).success);
  assert.equal(setPaymentMethodInput.safeParse({ key: "jazzcash", isEnabled: true }).success, false, "no gateway can be switched on");
});

test("shipping inputs: charges are whole paisa, free delivery is optional, cities trimmed", () => {
  assert.equal(saveShippingMethodInput.parse({ name: "  Standard  " }).name, "Standard");
  assert.equal(saveShippingMethodInput.parse({ name: "Standard" }).estimateText, "", "no delivery promise unless the owner writes one");
  const r = saveShippingRateInput.parse({ methodId: "m", city: " Lahore ", charge: 25000 });
  assert.deepEqual([r.city, r.charge, r.freeOver], ["Lahore", 25000, null]);
  assert.ok(saveShippingRateInput.safeParse({ methodId: "m", city: "*", charge: 0 }).success, "free delivery is a valid charge");
  assert.equal(saveShippingRateInput.safeParse({ methodId: "m", city: "Lahore", charge: -1 }).success, false);
  assert.equal(saveShippingRateInput.safeParse({ methodId: "m", city: "Lahore", charge: 100.5 }).success, false);
  assert.equal(deleteShippingInput.safeParse({ kind: "city", id: "x" }).success, false);
});

test("payments and shipping modules are built and visible to the right roles only", () => {
  for (const key of ["payments", "shipping", "orders"]) assert.ok(MODULES.find((m) => m.key === key).load, `${key} is built`);
  const orderMgr = visibleModules(effectivePermissions(["order_manager"])).map((m) => m.key);
  assert.ok(orderMgr.includes("payments") && orderMgr.includes("shipping"));
  const inv = visibleModules(effectivePermissions(["inventory_manager"])).map((m) => m.key);
  assert.ok(!inv.includes("payments") && !inv.includes("shipping"));
});
