import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedCash, cashVariance, POS_TENDER_METHODS, CASH_IN_REASONS, CASH_OUT_REASONS } from "../../shared/pos.js";
import { DEFAULT_ACCOUNTS, ROLES, checkJournalLines } from "../../shared/accounting.js";
import { POS_ROLES, ALL_PERMISSIONS } from "../../shared/permissions.js";
import { tenderInput, posCheckoutInput, posDiscountInput, registerCashInput, openRegisterInput, closeRegisterInput } from "../../shared/schemas/index.js";
import { registerMoveSpec, registerVarianceSpec } from "../../functions/services/accountingRules.js";
import { receiptBody, receiptCss, receiptDocument } from "../../src/ui/posReceipt.js";

const roles = Object.fromEntries(DEFAULT_ACCOUNTS.filter((a) => a.role).map((a) => [a.role, a.code]));
const index = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, { name: a.name, type: a.type, contra: Boolean(a.contra), isGroup: Boolean(a.isGroup), parent: a.parent, active: true, control: a.role ? ROLES[a.role]?.control ?? null : null }]));
const resolve = (spec) => spec.lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0).map((l) => ({ accountCode: roles[l.role], debit: l.debit ?? 0, credit: l.credit ?? 0, partyType: l.partyType ?? null, partyId: l.partyId ?? null }));
const check = (spec) => checkJournalLines(resolve(spec), index);
const key = "abcdefgh1234";

test("expected cash = float + cash sales + cash in − cash out, and variance = counted − expected", () => {
  const s = { openingFloat: 200000, totals: { cash: 1000000, bank_transfer: 500000 }, cashIn: 50000, cashOut: 30000 };
  assert.equal(expectedCash(s), 1220000, "bank and wallet takings are not cash in the drawer");
  assert.equal(expectedCash({ openingFloat: 0 }), 0);
  assert.equal(cashVariance(1200000, 1220000), -20000);
  assert.equal(cashVariance(1230000, 1220000), 10000);
  assert.equal(cashVariance(5, 5), 0);
});

test("POS tender methods are exactly the four allowed; cash movement reasons don't overlap", () => {
  assert.deepEqual([...POS_TENDER_METHODS], ["cash", "bank_transfer", "jazzcash", "easypaisa"]);
  assert.ok(CASH_IN_REASONS.every((r) => !CASH_OUT_REASONS.includes(r)));
});

test("tender schema: bank and wallet need a reference; cash received can't be below the amount or used for other methods", () => {
  assert.ok(tenderInput.safeParse({ method: "cash", amount: 1000 }).success);
  assert.ok(!tenderInput.safeParse({ method: "bank_transfer", amount: 1000 }).success);
  assert.ok(!tenderInput.safeParse({ method: "easypaisa", amount: 1000, reference: "ab" }).success);
  assert.ok(tenderInput.safeParse({ method: "easypaisa", amount: 1000, reference: "EP-1" }).success);
  assert.ok(!tenderInput.safeParse({ method: "card", amount: 1000 }).success);
  assert.ok(!tenderInput.safeParse({ method: "cash", amount: 1000, cashReceived: 500 }).success);
  assert.ok(tenderInput.safeParse({ method: "cash", amount: 1000, cashReceived: 2000 }).success);
  assert.ok(!tenderInput.safeParse({ method: "jazzcash", amount: 1000, reference: "JC-1", cashReceived: 2000 }).success);
  assert.ok(!tenderInput.safeParse({ method: "cash", amount: 0 }).success);
  assert.ok(!tenderInput.safeParse({ method: "cash", amount: 10.5 }).success, "whole paisa only");
});

test("checkout schema: items required, whole quantities, no duplicate variant lines, bounded tenders", () => {
  const item = { productId: "p1", variantId: "v1", qty: 1 };
  const base = { idempotencyKey: key, sessionId: "s1", items: [item], tenders: [] };
  assert.ok(posCheckoutInput.safeParse(base).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, items: [] }).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, items: [{ ...item, qty: 0 }] }).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, items: [{ ...item, qty: 1.5 }] }).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, items: [item, item] }).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, idempotencyKey: "x" }).success);
  assert.ok(!posCheckoutInput.safeParse({ ...base, tenders: Array(7).fill({ method: "cash", amount: 1 }) }).success);
});

test("discount, cash movement and register schemas", () => {
  assert.ok(posDiscountInput.safeParse({ type: "percent", value: 10, reason: "Staff" }).success);
  assert.ok(!posDiscountInput.safeParse({ type: "percent", value: 101, reason: "Staff" }).success);
  assert.ok(!posDiscountInput.safeParse({ type: "amount", value: 100, reason: "" }).success);
  const mv = { idempotencyKey: key, sessionId: "s", type: "cash_in", reason: "owner_capital", amount: 100, note: "Capital in" };
  assert.ok(registerCashInput.safeParse(mv).success);
  assert.ok(!registerCashInput.safeParse({ ...mv, reason: "bank_deposit" }).success);
  assert.ok(!registerCashInput.safeParse({ ...mv, note: "x" }).success);
  assert.ok(!registerCashInput.safeParse({ ...mv, amount: 0 }).success);
  assert.ok(openRegisterInput.safeParse({ idempotencyKey: key, warehouseId: "w", openingFloat: 0 }).success);
  assert.ok(!openRegisterInput.safeParse({ idempotencyKey: key, warehouseId: "w", openingFloat: -1 }).success);
  assert.ok(!closeRegisterInput.safeParse({ sessionId: "s", countedCash: -1 }).success);
});

test("POS permissions exist; cashiers get only sell/register access; managers get all eight (including taking goods back)", () => {
  const all = ["pos.access", "pos.sell", "pos.register", "pos.cash", "pos.override", "pos.sessions.read", "pos.reports", "pos.return"];
  for (const p of all) assert.ok(ALL_PERMISSIONS.includes(p), p);
  assert.deepEqual(POS_ROLES.cashier.permissions, ["pos.access", "pos.sell", "pos.register"]);
  assert.deepEqual([...POS_ROLES.pos_manager.permissions].sort(), [...all].sort());
});

test("register cash movements and variances post balanced journals to existing roles only", () => {
  const session = { number: "RS-000001" };
  const at = (type, reason, amount) => registerMoveSpec({ movementId: "m1", type, reason, amount, session, when: "2026-01-02" });
  for (const [type, reason] of [["cash_in", "owner_capital"], ["cash_in", "bank_withdrawal"], ["cash_out", "bank_deposit"], ["cash_out", "operating_expense"]]) {
    const spec = at(type, reason, 5000);
    assert.equal(check(spec).ok, true, `${type}/${reason} balances`);
    assert.ok(spec.lines.every((l) => roles[l.role]), "every line uses a role in the default chart");
  }
  const shortage = registerVarianceSpec({ sessionId: "s1", session, variance: -700, when: "2026-01-02" });
  const excess = registerVarianceSpec({ sessionId: "s1", session, variance: 300, when: "2026-01-02" });
  assert.equal(check(shortage).ok, true);
  assert.equal(check(excess).ok, true);
  assert.deepEqual(resolve(shortage).map((l) => [l.accountCode, l.debit, l.credit]), [[roles.operating_expenses, 700, 0], [roles.cash, 0, 700]]);
  assert.deepEqual(resolve(excess).map((l) => [l.accountCode, l.debit, l.credit]), [[roles.cash, 300, 0], [roles.operating_expenses, 0, 300]]);
});

const sale = {
  number: "SL-000007", createdAt: "2026-05-01T09:30:00.000Z", cashierName: "Cashier <b>One</b>", customer: { name: "Ayesha" },
  subtotal: 2000000, itemDiscountTotal: 200000, discountTotal: 100000, taxTotal: 0, total: 1900000, paidTotal: 1500000, amountDue: 400000,
  lines: [{ productName: "Oxford <script>x</script>", colorName: "Black", sizeLabel: "EU 42", sku: "OX-BLACK-42", qty: 2, unitPrice: 1000000, regularPrice: 1100000, lineTotal: 2000000 }],
  pos: { tenders: [{ method: "cash", amount: 1000000, cashReceived: 1200000 }, { method: "easypaisa", amount: 500000 }] },
};
const payments = [{ type: "collection", method: "cash", amount: 1000000 }, { type: "collection", method: "easypaisa", amount: 500000, reference: "EP-77" }];

test("receipt shows only real saved data, escapes everything, and lists payments and balance due", () => {
  const html = receiptBody({ sale, payments }, { storeName: "Italian Shoes", phone: "0300", address: "Mall Road" }, "80mm");
  for (const t of ["Italian Shoes", "SL-000007", "Cashier &lt;b&gt;One&lt;/b&gt;", "Ayesha", "OX-BLACK-42", "EU 42", "Black", "Easypaisa EP-77", "BALANCE DUE", "Change", "0300", "Mall Road"]) assert.ok(html.includes(t), t);
  assert.ok(!html.includes("<script>") && !html.includes("<b>One"), "no unescaped markup");
  assert.ok(!html.includes("Return policy"), "nothing invented");
  const paid = receiptBody({ sale: { ...sale, paidTotal: 1900000, amountDue: 0 }, payments }, {}, "80mm");
  assert.ok(!paid.includes("BALANCE DUE"), "no balance line when fully paid");
});

test("receipt logo only from https; optional store details are left out when not configured", () => {
  assert.ok(!receiptBody({ sale, payments }, { storeName: "S", logoUrl: "javascript:alert(1)" }).includes("<img"));
  assert.ok(!receiptBody({ sale, payments }, { storeName: "S", logoUrl: "http://x/y.png" }).includes("<img"));
  assert.ok(receiptBody({ sale, payments }, { storeName: "S", logoUrl: "https://x/y.png" }).includes("<img"));
  const bare = receiptBody({ sale, payments }, {});
  assert.ok(!bare.includes("undefined") && !bare.includes("null"));
});

test("print layouts: 58 mm and 80 mm thermal pages and a standard page", () => {
  assert.match(receiptCss("58mm"), /@page \{ size: 58mm auto/);
  assert.match(receiptCss("58mm"), /width:54mm/);
  assert.match(receiptCss("80mm"), /@page \{ size: 80mm auto/);
  assert.match(receiptCss("80mm"), /width:72mm/);
  assert.ok(!/size: standard/.test(receiptCss("standard")) && /max-width:640px/.test(receiptCss("standard")));
  const doc = receiptDocument({ sale, payments }, { storeName: "S" }, "58mm");
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /Receipt SL-000007/);
  assert.match(doc, /data-width="58mm"/);
});
