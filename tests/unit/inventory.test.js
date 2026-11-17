import { test } from "node:test";
import assert from "node:assert/strict";
import { ean13CheckDigit, isEan13, internalEan13, ean13Bits, ean13Svg, ADJUST_REASONS, TRANSFER_STATUS_LABEL, ALERT_DEFAULTS } from "../../shared/inventory.js";
import { ALL_PERMISSIONS } from "../../shared/permissions.js";
import { DEFAULT_ACCOUNTS, ROLES } from "../../shared/accounting.js";
import { createAdjustmentInput, stockPolicyInput, inventorySettingsInput, receiveTransferLinesInput, assignBarcodeInput, inventoryReportInput, countLineInput, costAdjustInput } from "../../shared/schemas/index.js";
import { stockAdjustmentSpec, costRevaluationSpec } from "../../functions/services/accountingRules.js";
import { checkJournalLines } from "../../shared/accounting.js";
import { searchLocal } from "../../src/lib/offlineCatalog.js";

test("EAN-13: check digit, validation, in-store codes and bars", () => {
  assert.equal(ean13CheckDigit("400638133393"), 1);
  assert.ok(isEan13("4006381333931"));
  assert.ok(!isEan13("4006381333932"), "wrong check digit");
  assert.ok(!isEan13("123"));
  assert.ok(!isEan13("40063813339310"));
  const a = internalEan13(1);
  const b = internalEan13(2);
  assert.ok(isEan13(a) && isEan13(b) && a !== b && a.startsWith("200"), "in-store codes sit in the reserved 200 range");
  for (let i = 1; i < 500; i += 37) assert.ok(isEan13(internalEan13(i)));
  const bits = ean13Bits("4006381333931");
  assert.equal(bits.length, 95);
  assert.ok(bits.startsWith("101") && bits.endsWith("101") && bits.slice(45, 50) === "01010", "guard bars");
  assert.throws(() => ean13Bits("4006381333932"));
  const svg = ean13Svg("4006381333931");
  assert.ok(svg.startsWith("<svg") && svg.includes("4006381333931") && svg.includes("<rect"));
});

test("adjustment reasons cover the required cases; new permissions and the write-off account exist", () => {
  assert.deepEqual(Object.keys(ADJUST_REASONS).sort(), ["correction", "damaged", "found", "internal_use", "lost", "missing", "other"].sort());
  assert.equal(ADJUST_REASONS.damaged.dir, "out");
  assert.equal(ADJUST_REASONS.found.dir, "in");
  assert.deepEqual(Object.keys(TRANSFER_STATUS_LABEL), ["draft", "requested", "in_transit", "partially_received", "received", "cancelled"]);
  assert.equal(TRANSFER_STATUS_LABEL.in_transit, "Dispatched");
  assert.ok(ALERT_DEFAULTS.deadDays > ALERT_DEFAULTS.slowDays);
  for (const p of ["inventory.count", "inventory.approve", "inventory.manage"]) assert.ok(ALL_PERMISSIONS.includes(p), p);
  assert.equal(ROLES.inventory_adjustments.type, "expense");
  assert.ok(DEFAULT_ACCOUNTS.some((a) => a.role === "inventory_adjustments" && a.type === "expense" && !a.isGroup));
});

test("stock adjustments and revaluations post balanced journals to the inventory account", () => {
  const roles = Object.fromEntries(DEFAULT_ACCOUNTS.filter((a) => a.role).map((a) => [a.role, a.code]));
  const index = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, { name: a.name, type: a.type, contra: Boolean(a.contra), isGroup: Boolean(a.isGroup), parent: a.parent, active: true, control: null }]));
  const resolve = (spec) => spec.lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0).map((l) => ({ accountCode: roles[l.role], debit: l.debit ?? 0, credit: l.credit ?? 0 }));
  const base = { label: "Damaged", qty: 2, value: 200000, productName: "Oxford", variantLabel: "Black / EU 42", note: "x", when: new Date() };
  const loss = stockAdjustmentSpec("a1", { ...base, change: -2 });
  const gain = stockAdjustmentSpec("a2", { ...base, change: 2 });
  assert.deepEqual(resolve(loss).map((l) => [l.accountCode, l.debit, l.credit]), [["5030", 200000, 0], ["1200", 0, 200000]]);
  assert.deepEqual(resolve(gain).map((l) => [l.accountCode, l.debit, l.credit]), [["1200", 200000, 0], ["5030", 0, 200000]]);
  const up = costRevaluationSpec("r1", { value: 30000, productName: "O", variantLabel: "B", oldCost: 100, newCost: 200, onHand: 300, reason: "x", when: new Date() });
  const down = costRevaluationSpec("r2", { value: -30000, productName: "O", variantLabel: "B", oldCost: 200, newCost: 100, onHand: 300, reason: "x", when: new Date() });
  for (const s of [loss, gain, up, down]) assert.equal(checkJournalLines(resolve(s), index).ok, true);
  assert.deepEqual(resolve(up).map((l) => [l.accountCode, l.debit, l.credit]), [["1200", 30000, 0], ["5030", 0, 30000]]);
  assert.deepEqual(resolve(down).map((l) => [l.accountCode, l.debit, l.credit]), [["5030", 30000, 0], ["1200", 0, 30000]]);
});

test("schemas: adjustments need a reason and a non-zero whole change; levels, settings, transfers, barcodes, counts and reports are validated", () => {
  const adj = { idempotencyKey: "abcdefgh1234", productId: "p", variantId: "v", warehouseId: "w", reason: "damaged", change: -2, description: "Split sole" };
  assert.ok(createAdjustmentInput.safeParse(adj).success);
  assert.ok(!createAdjustmentInput.safeParse({ ...adj, change: 0 }).success);
  assert.ok(!createAdjustmentInput.safeParse({ ...adj, change: 1.5 }).success);
  assert.ok(!createAdjustmentInput.safeParse({ ...adj, reason: "whatever" }).success);
  assert.ok(!createAdjustmentInput.safeParse({ ...adj, description: "ab" }).success);
  const pol = { productId: "p", variantId: "v", minStock: 2, reorderLevel: 4, maxStock: 10, locations: { w: "A-1" } };
  assert.ok(stockPolicyInput.safeParse(pol).success);
  assert.ok(!stockPolicyInput.safeParse({ ...pol, maxStock: 1 }).success, "maximum below minimum");
  assert.ok(!stockPolicyInput.safeParse({ ...pol, reorderLevel: 1 }).success, "reorder below minimum");
  assert.ok(stockPolicyInput.safeParse({ productId: "p", variantId: "v" }).success, "levels are optional");
  assert.ok(inventorySettingsInput.safeParse({ lowStock: 3, slowDays: 60, deadDays: 180, adjustApprovalUnits: 0, adjustApprovalValue: 0 }).success);
  assert.ok(!inventorySettingsInput.safeParse({ lowStock: 3, slowDays: 60, deadDays: 60, adjustApprovalUnits: 0, adjustApprovalValue: 0 }).success);
  const rt = { idempotencyKey: "abcdefgh1234", id: "t1", lines: [{ lineIndex: 0, receivedQty: 3, damagedQty: 1, missingQty: 0 }] };
  assert.ok(receiveTransferLinesInput.safeParse(rt).success);
  assert.ok(!receiveTransferLinesInput.safeParse({ ...rt, lines: [{ lineIndex: 0, receivedQty: 0, damagedQty: 0, missingQty: 0 }] }).success, "enter at least one quantity");
  assert.ok(!receiveTransferLinesInput.safeParse({ ...rt, lines: [rt.lines[0], rt.lines[0]] }).success, "a line twice");
  assert.ok(!receiveTransferLinesInput.safeParse({ ...rt, lines: [{ lineIndex: 0, receivedQty: -1 }] }).success);
  assert.ok(assignBarcodeInput.safeParse({ productId: "p", variantId: "v" }).success, "generate one");
  assert.ok(assignBarcodeInput.safeParse({ productId: "p", variantId: "v", barcode: "4006381333931" }).success);
  assert.ok(!assignBarcodeInput.safeParse({ productId: "p", variantId: "v", barcode: "12ab" }).success);
  assert.ok(countLineInput.safeParse({ sessionId: "s", productId: "p", variantId: "v", countedQty: 0 }).success, "an empty shelf counts as 0");
  assert.ok(!countLineInput.safeParse({ sessionId: "s", productId: "p", variantId: "v", countedQty: -1 }).success);
  assert.ok(!costAdjustInput.safeParse({ idempotencyKey: "abcdefgh1234", productId: "p", variantId: "v", newCost: 0, reason: "fix" }).success);
  assert.ok(inventoryReportInput.safeParse({ report: "valuation", from: "2026-01-01", to: "2026-01-31" }).success);
  assert.ok(!inventoryReportInput.safeParse({ report: "secret", from: "2026-01-01", to: "2026-01-31" }).success);
  assert.ok(!inventoryReportInput.safeParse({ report: "summary", from: "2026-02-01", to: "2026-01-31" }).success);
});

test("the offline POS catalogue finds a scanned barcode as well as a SKU", () => {
  const cat = [{ id: "p1", name: "Oxford", variants: [{ id: "v1", sku: "OX-1-BLACK-42", barcode: "2000000000017", available: 3, price: 100, listPrice: 100, colorName: "Black", sizeLabel: "EU 42" }] }];
  assert.equal(searchLocal(cat, "2000000000017", { exact: true }).match, "sku");
  assert.equal(searchLocal(cat, "ox-1-black-42", { exact: true }).match, "sku");
  assert.equal(searchLocal(cat, "2000000000024", { exact: true }).match, "none");
});
