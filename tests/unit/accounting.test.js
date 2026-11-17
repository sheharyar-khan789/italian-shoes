import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_TYPES, ROLES, DEFAULT_ACCOUNTS, normalBalanceOf, naturalBalance, checkJournalLines, paymentRoleOf, pktDateKey, dayBefore, monthOf, isDateKey } from "../../shared/accounting.js";
import { saleSpec, customerPaymentSpec, refundSpec, grnSpec, supplierPaymentSpec, purchaseReturnSpec, toDateKey } from "../../functions/services/accountingRules.js";
import { reversalSpec } from "../../functions/services/accounting.js";
import { createJournalInput, openingBalanceInput, saveAccountInput } from "../../shared/schemas/index.js";

/** The account index and role map the engine would hold after "create the chart of accounts". */
const roles = Object.fromEntries(DEFAULT_ACCOUNTS.filter((a) => a.role).map((a) => [a.role, a.code]));
const index = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, { name: a.name, type: a.type, contra: Boolean(a.contra), isGroup: Boolean(a.isGroup), parent: a.parent, active: true, control: a.role ? ROLES[a.role]?.control ?? null : null }]));
const resolve = (spec) => spec.lines.filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0).map((l) => ({ accountCode: roles[l.role], debit: l.debit ?? 0, credit: l.credit ?? 0, partyType: l.partyType ?? null, partyId: l.partyId ?? null }));
const check = (spec) => checkJournalLines(resolve(spec), index);

test("normal balances: assets and expenses by debit; liabilities, equity and revenue by credit; contra accounts flip", () => {
  assert.deepEqual(ACCOUNT_TYPES.map((t) => normalBalanceOf(t)), ["debit", "credit", "credit", "credit", "debit"]);
  assert.equal(normalBalanceOf("revenue", true), "debit", "sales discounts are a debit-balance revenue account");
  assert.equal(naturalBalance({ type: "asset" }, 700, 200), 500);
  assert.equal(naturalBalance({ type: "liability" }, 200, 900), 700);
  assert.equal(naturalBalance({ type: "revenue", contra: true }, 300, 0), 300);
});

test("the default chart: unique codes, parents exist and match, every posting role has an account of the right type", () => {
  const codes = DEFAULT_ACCOUNTS.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length, "unique codes");
  for (const a of DEFAULT_ACCOUNTS) {
    assert.match(a.code, /^\d{4}$/);
    if (a.parent) {
      const p = DEFAULT_ACCOUNTS.find((x) => x.code === a.parent);
      assert.ok(p?.isGroup && p.type === a.type, `${a.code}'s parent is a heading of the same type`);
    }
    if (a.isGroup) assert.equal(a.role, undefined, "headings can't be posting accounts");
  }
  for (const [role, spec] of Object.entries(ROLES)) {
    const a = DEFAULT_ACCOUNTS.find((x) => x.role === role);
    assert.ok(a, `an account for ${role}`);
    assert.equal(a.type, spec.type);
    assert.equal(Boolean(a.contra), Boolean(spec.contra));
  }
  for (const name of ["Cash in Hand", "Main Bank Account", "JazzCash / Easypaisa Clearing", "COD / Courier Receivable", "Accounts Receivable", "Inventory", "Accounts Payable", "Owner Capital", "Sales Revenue", "Sales Discounts", "Cost of Goods Sold", "Purchase Returns & Allowances", "General Operating Expenses", "Salaries", "Delivery / Shipping Income"]) assert.ok(DEFAULT_ACCOUNTS.some((a) => a.name === name), name);
  assert.ok(DEFAULT_ACCOUNTS.every((a) => !("balance" in a) && !("opening" in a)), "no invented balances");
});

test("journal lines: balanced entries pass; every kind of bad entry is named", () => {
  const ok = [{ accountCode: "1010", debit: 500, credit: 0 }, { accountCode: "4010", debit: 0, credit: 500 }];
  assert.deepEqual(checkJournalLines(ok, index), { ok: true, errors: [], totalDebit: 500, totalCredit: 500 });
  const bad = (lines, text) => {
    const r = checkJournalLines(lines, index);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => text.test(e)), `${text}: ${r.errors}`);
  };
  bad([{ accountCode: "1010", debit: 500, credit: 0 }, { accountCode: "4010", debit: 0, credit: 400 }], /Debits \(500\) don't equal credits \(400\)/);
  bad([{ accountCode: "1010", debit: 500, credit: 0 }], /at least two lines/);
  bad([{ accountCode: "1010", debit: 500, credit: 500 }, { accountCode: "4010", debit: 0, credit: 0 }], /debit OR credit/);
  bad([{ accountCode: "1010", debit: 50.5, credit: 0 }, { accountCode: "4010", debit: 0, credit: 50.5 }], /whole paisa/);
  bad([{ accountCode: "1010", debit: -5, credit: 0 }, { accountCode: "4010", debit: 0, credit: -5 }], /whole paisa/);
  bad([{ accountCode: "9999", debit: 5, credit: 0 }, { accountCode: "4010", debit: 0, credit: 5 }], /doesn't exist/);
  bad([{ accountCode: "1000", debit: 5, credit: 0 }, { accountCode: "4010", debit: 0, credit: 5 }], /heading/);
  bad([{ accountCode: "1010", debit: 5, credit: 0, partyType: "customer", partyId: "c" }, { accountCode: "4010", debit: 0, credit: 5 }], /customers can only be recorded on receivable/);
  bad([{ accountCode: "2010", debit: 5, credit: 0, partyType: "customer", partyId: "c" }, { accountCode: "4010", debit: 0, credit: 5 }], /customers can only be recorded on receivable/);
  bad([{ accountCode: "1010", debit: 0, credit: 0 }, { accountCode: "4010", debit: 0, credit: 0 }], /debit OR credit/);
  const off = { ...index, 1010: { ...index["1010"], active: false } };
  assert.ok(checkJournalLines(ok, off).errors.some((e) => /switched off/.test(e)), "inactive accounts take no postings");
  assert.equal(checkJournalLines([{ accountCode: "2010", debit: 5, credit: 0, partyType: "supplier", partyId: "s" }, { accountCode: "1010", debit: 0, credit: 5 }], index).ok, true, "a supplier belongs on a payable account");
});

test("dates are Pakistan time", () => {
  assert.equal(pktDateKey(new Date("2026-01-01T20:30:00Z")), "2026-01-02", "01:30 PKT the next morning");
  assert.equal(pktDateKey(new Date("2026-01-01T18:59:00Z")), "2026-01-01");
  assert.equal(dayBefore("2026-03-01"), "2026-02-28");
  assert.equal(monthOf("2026-03-17"), "2026-03");
  assert.equal(isDateKey("2026-02-30"), false);
  assert.equal(toDateKey({ toDate: () => new Date("2026-05-05T10:00:00Z") }), "2026-05-05");
});

const sale = (over = {}) => ({ number: "SL-000001", orderNumber: "IS-2026-000001", customerId: "u1", customer: { name: "Ayesha" }, paymentMethod: "cod", grossSales: 2000000, itemDiscountTotal: 200000, discountTotal: 180000, netSales: 1620000, taxTotal: 0, shippingTotal: 20000, total: 1640000, ...over });

test("a COD sale: receivable (not cash), discounts, delivery income, and cost of goods only when the cost is known", () => {
  const withCost = saleSpec("o1", sale(), { costComplete: true, costTotal: 1200000 }, new Date());
  const r = check(withCost);
  assert.equal(r.ok, true, r.errors.join());
  const by = (spec, role, side) => spec.lines.filter((l) => l.role === role).reduce((n, l) => n + (l[side] ?? 0), 0);
  assert.equal(by(withCost, "cod_receivable", "debit"), 1640000, "the whole total is owed, not received");
  assert.equal(by(withCost, "cash", "debit"), 0, "no cash on a COD sale");
  assert.equal(by(withCost, "sales_discounts", "debit"), 380000, "markdown + coupon");
  assert.equal(by(withCost, "sales_revenue", "credit"), 2000000, "revenue at list price");
  assert.equal(by(withCost, "delivery_income", "credit"), 20000);
  assert.equal(by(withCost, "cogs", "debit"), 1200000);
  assert.equal(by(withCost, "inventory", "credit"), 1200000);
  assert.deepEqual(withCost.lines[0].partyType, "customer");
  assert.equal(withCost.meta.costMissing, false);
  assert.equal(withCost.sourceType + "__" + withCost.sourceId, "sale__o1");

  const noCost = saleSpec("o2", sale(), { costComplete: false, costTotal: null }, new Date());
  assert.equal(check(noCost).ok, true);
  assert.equal(by(noCost, "cogs", "debit"), 0, "no cost invented");
  assert.equal(noCost.meta.costMissing, true);
  assert.equal(saleSpec("o3", sale(), null, new Date()).meta.costMissing, true);
});

test("sale postings balance for plain, taxed, free-delivery and non-COD sales", () => {
  for (const over of [
    { grossSales: 1000000, itemDiscountTotal: 0, discountTotal: 0, netSales: 1000000, shippingTotal: 0, total: 1000000 },
    { grossSales: 1000000, itemDiscountTotal: 0, discountTotal: 0, netSales: 1000000, taxTotal: 170000, shippingTotal: 20000, total: 1190000 },
    { paymentMethod: "bank_transfer" },
    { customerId: null, customer: null },
  ]) {
    const r = check(saleSpec("x", sale(over), { costComplete: true, costTotal: 100 }, new Date()));
    assert.equal(r.ok, true, `${JSON.stringify(over)}: ${r.errors}`);
  }
  assert.equal(saleSpec("x", sale({ paymentMethod: "bank_transfer" }), null, new Date()).lines[0].role, "accounts_receivable");
  assert.equal(saleSpec("x", sale({ customerId: null }), null, new Date()).lines[0].partyType, undefined, "a walk-in has no customer party");
  assert.equal(saleSpec("x", sale({ taxTotal: 170000, total: 1810000 }), null, new Date()).lines.find((l) => l.role === "sales_tax").credit, 170000);
});

test("payments land in the right account: cash, bank, and a CLEARING account for mobile wallets", () => {
  assert.deepEqual(["cod", "cash", "bank_transfer", "jazzcash", "easypaisa"].map(paymentRoleOf), ["cash", "cash", "bank", "wallet_clearing", "wallet_clearing"]);
  for (const method of ["cod", "cash", "bank_transfer", "jazzcash", "easypaisa"]) {
    const spec = customerPaymentSpec({ sale: sale(), txnId: "t1", amount: 500000, method, reference: "R1" });
    assert.equal(check(spec).ok, true);
    assert.equal(spec.lines[0].role, paymentRoleOf(method));
    assert.equal(spec.lines[1].role, "cod_receivable", "it settles the COD receivable");
    assert.equal(spec.lines[1].partyId, "u1");
    assert.equal(spec.sourceId, "t1");
  }
  const refund = refundSpec({ sale: sale(), txnId: "r1", amount: 300000, reason: "Wrong size" });
  assert.equal(check(refund).ok, true);
  assert.deepEqual([refund.lines[0].role, refund.lines[0].debit, refund.lines[1].role, refund.lines[1].credit], ["cod_receivable", 300000, "cash", 300000]);
});

test("purchases: inventory against payables; supplier payments and returns reduce payables; every posting balances", () => {
  const grn = grnSpec("g1", { number: "GRN-000001", supplierName: "Al-Noor", supplierId: "s1", purchaseOrderNumber: "PO-000001", receivedDate: new Date(), value: 1200000 });
  assert.equal(check(grn).ok, true);
  assert.deepEqual(grn.lines.map((l) => [l.role, l.debit ?? 0, l.credit ?? 0]), [["inventory", 1200000, 0], ["accounts_payable", 0, 1200000]]);
  assert.equal(grn.lines[1].partyType, "supplier");
  for (const method of ["cash", "bank_transfer", "jazzcash", "easypaisa"]) {
    const p = supplierPaymentSpec("p1", { number: "SP-000001", supplierName: "Al-Noor", supplierId: "s1", amount: 500000, method, methodLabel: method, reference: "R", paidAt: new Date() });
    assert.equal(check(p).ok, true);
    assert.deepEqual([p.lines[0].role, p.lines[1].role], ["accounts_payable", paymentRoleOf(method)]);
  }
  const ret = purchaseReturnSpec("r1", { number: "PR-000001", supplierName: "Al-Noor", supplierId: "s1", grnNumber: "GRN-000001", value: 240000, createdAt: new Date() });
  assert.equal(check(ret).ok, true);
  assert.deepEqual(ret.lines.map((l) => [l.role, l.debit ?? 0, l.credit ?? 0]), [["accounts_payable", 240000, 0], ["inventory", 0, 240000]]);
});

test("a reversal is the exact opposite of the original and points at it", () => {
  const original = { id: "sale__o1", number: "JE-000007", lines: [{ accountCode: "1100", debit: 100, credit: 0, partyType: "customer", partyId: "u1" }, { accountCode: "4010", debit: 0, credit: 100 }] };
  const rev = reversalSpec(original, "Order cancelled", "2026-02-02");
  assert.equal(rev.id, "reversal__sale__o1", "one reversal per journal, by construction");
  assert.equal(rev.reversalOf, "sale__o1");
  assert.deepEqual(rev.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1100", 0, 100], ["4010", 100, 0]]);
  assert.equal(rev.lines[0].partyId, "u1");
  assert.match(rev.memo, /JE-000007/);
  assert.equal(checkJournalLines(rev.lines, index).ok, true);
});

test("accounting inputs are validated", () => {
  const key = "abcdefgh1234";
  const lines = [{ accountCode: "1010", debit: 100 }, { accountCode: "4010", credit: 100 }];
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2026-01-02", memo: "Owner paid in cash", lines }).success, true);
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2999-01-01", memo: "Future", lines }).success, false, "no future dates");
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2026-01-02", memo: "x", lines }).success, false, "memo too short");
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2026-01-02", memo: "One line", lines: [lines[0]] }).success, false);
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2026-01-02", memo: "Bad amount", lines: [{ accountCode: "1010", debit: 1.5 }, lines[1]] }).success, false);
  assert.equal(createJournalInput.safeParse({ idempotencyKey: key, date: "2026-01-02", memo: "Bad code", lines: [{ accountCode: "cash", debit: 100 }, lines[1]] }).success, false);
  assert.equal(openingBalanceInput.safeParse({ idempotencyKey: key, date: "2026-01-02", lines }).success, true);
  assert.equal(saveAccountInput.safeParse({ code: "1022", name: "HBL Current Account", type: "asset", parentCode: "1020" }).success, true);
  assert.equal(saveAccountInput.safeParse({ code: "12", name: "Too short", type: "asset" }).success, false);
  assert.equal(saveAccountInput.safeParse({ code: "1022", name: "Odd", type: "income" }).success, false);
});
