import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv } from "../../functions/lib/csv.js";
import { updateOrderStatusInput, addShipmentInput, addOrderNoteInput, cancelMyOrderInput, quoteInput } from "../../shared/schemas/index.js";

test("CSV cells are quoted correctly and can't run as spreadsheet formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(1250.5), "1250.5");
  for (const f of ["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\tx", "\rx"]) assert.ok(csvCell(f).replace(/^"/, "").startsWith("'"), JSON.stringify(f));
  assert.equal(toCsv([["a", "b"], ["1", "=x"]]), "﻿a,b\r\n1,'=x\r\n");
});

test("staff order inputs", () => {
  assert.ok(updateOrderStatusInput.safeParse({ orderId: "o1", status: "confirmed" }).success);
  assert.equal(updateOrderStatusInput.safeParse({ orderId: "o1", status: "shipped" }).success, false);
  assert.equal(addOrderNoteInput.safeParse({ orderId: "o1", text: "   " }).success, false);
  assert.ok(addShipmentInput.safeParse({ orderId: "o1", courier: "TCS", trackingNumber: "ABC123" }).success);
  assert.equal(addShipmentInput.safeParse({ orderId: "o1", courier: "TCS", trackingNumber: "ABC123", trackingUrl: "javascript:alert(1)" }).success, false);
  assert.ok(addShipmentInput.safeParse({ orderId: "o1", courier: "TCS", trackingNumber: "ABC123", trackingUrl: "https://tcs.example/track/1" }).success);
  assert.equal(cancelMyOrderInput.parse({ orderId: "o1" }).reason, "");
});

test("quote input limits", () => {
  const ok = { items: [{ productId: "p", variantId: "v", qty: 2 }], city: " Lahore " };
  assert.equal(quoteInput.parse(ok).city, "Lahore");
  assert.equal(quoteInput.safeParse({ ...ok, items: [] }).success, false);
  assert.equal(quoteInput.safeParse({ ...ok, items: [{ productId: "p", variantId: "v", qty: 11 }] }).success, false);
});
