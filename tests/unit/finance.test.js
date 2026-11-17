import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeFor, nextOccurrence, closingCash, daysBetween, isReceiptUrl, FINANCE_METHODS, METHOD_KIND, SUGGESTED_EXPENSE_CATEGORIES } from "../../shared/finance.js";
import { ALL_PERMISSIONS } from "../../shared/permissions.js";
import { DEFAULT_ACCOUNTS, ROLES } from "../../shared/accounting.js";
import { financeEntryInput, transferInput, cashCountInput, financeReportInput, recurringInput, financeCategoryInput } from "../../shared/schemas/index.js";
import { moneyAccountsOf } from "../../functions/services/finance.js";
import { reportCsv, tableHtml } from "../../src/admin/financeUi.js";

const entry = { idempotencyKey: "abcdefgh1234", type: "expense", date: "2026-03-10", amount: 250000, title: "Electricity bill", categoryId: "cat1", method: "cash" };

test("date presets: today, yesterday, this week (Monday start), this month, this year", () => {
  const today = "2026-03-18"; // a Wednesday
  assert.deepEqual(rangeFor("today", today), { from: today, to: today });
  assert.deepEqual(rangeFor("yesterday", today), { from: "2026-03-17", to: "2026-03-17" });
  assert.deepEqual(rangeFor("week", today), { from: "2026-03-16", to: today });
  assert.deepEqual(rangeFor("week", "2026-03-15"), { from: "2026-03-09", to: "2026-03-15" }, "a Sunday belongs to the week that started Monday");
  assert.deepEqual(rangeFor("month", today), { from: "2026-03-01", to: today });
  assert.deepEqual(rangeFor("year", today), { from: "2026-01-01", to: today });
  assert.deepEqual(rangeFor("yesterday", "2026-01-01"), { from: "2025-12-31", to: "2025-12-31" }, "across a year end");
  assert.deepEqual(daysBetween("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("recurring dates: monthly keeps the day (or the month's last day), weekly adds seven days", () => {
  assert.equal(nextOccurrence("monthly", "2026-01-31", 31), "2026-02-28");
  assert.equal(nextOccurrence("monthly", "2026-02-28", 31), "2026-03-31");
  assert.equal(nextOccurrence("monthly", "2026-12-15", 15), "2027-01-15");
  assert.equal(nextOccurrence("weekly", "2026-03-30"), "2026-04-06");
});

test("closing cash = opening cash + cash in − cash out", () => {
  assert.equal(closingCash(500000, 250000, 100000), 650000);
  assert.equal(closingCash(0, 0, 0), 0);
});

test("income/expense schema: whole positive paisa, valid real dates, known methods; an edit needs the version it is based on", () => {
  assert.ok(financeEntryInput.safeParse(entry).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, amount: 0 }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, amount: 12.5 }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, amount: -1 }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, amount: "100" }).success, "no numbers as text");
  assert.ok(!financeEntryInput.safeParse({ ...entry, date: "2026-02-30" }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, method: "card" }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, type: "transfer" }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, idempotencyKey: undefined }).success, "a new entry needs a key");
  assert.ok(!financeEntryInput.safeParse({ ...entry, idempotencyKey: undefined, id: "e1" }).success, "an edit needs the expected version");
  assert.ok(financeEntryInput.safeParse({ ...entry, idempotencyKey: undefined, id: "e1", expectedVersion: 2 }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, attachments: [{ url: "https://example.com/a.pdf", name: "a", type: "application/pdf", size: 10 }] }).success, "only receipts uploaded through the uploader");
  assert.ok(financeEntryInput.safeParse({ ...entry, attachments: [{ url: "receipts/u1/a.pdf", name: "a.pdf", type: "application/pdf", size: 10 }] }).success);
  assert.ok(!financeEntryInput.safeParse({ ...entry, attachments: Array(6).fill({ url: "receipts/u1/a.pdf", name: "a", type: "application/pdf", size: 1 }) }).success, "at most five");
});

test("transfer, cash count, category, recurring and report schemas", () => {
  const t = { idempotencyKey: "abcdefgh1234", date: "2026-03-10", fromAccount: "1010", toAccount: "1021", amount: 1000 };
  assert.ok(transferInput.safeParse(t).success);
  assert.ok(!transferInput.safeParse({ ...t, toAccount: "1010" }).success, "two different accounts");
  assert.ok(!transferInput.safeParse({ ...t, amount: 0 }).success);
  assert.ok(!transferInput.safeParse({ ...t, fromAccount: "abc" }).success);
  const c = { idempotencyKey: "abcdefgh1234", accountCode: "1010", date: "2026-03-10", countedAmount: 0 };
  assert.ok(cashCountInput.safeParse(c).success, "an empty drawer counts as 0");
  assert.ok(!cashCountInput.safeParse({ ...c, countedAmount: -5 }).success);
  assert.ok(financeCategoryInput.safeParse({ kind: "expense", name: "Tea" }).success);
  assert.ok(!financeCategoryInput.safeParse({ kind: "other", name: "Tea" }).success);
  assert.ok(recurringInput.safeParse({ title: "Rent", amount: 100, categoryId: "c", method: "cash", frequency: "monthly", startDate: "2026-03-01" }).success);
  assert.ok(!recurringInput.safeParse({ title: "Rent", amount: 100, categoryId: "c", method: "cash", frequency: "daily", startDate: "2026-03-01" }).success);
  assert.ok(financeReportInput.safeParse({ report: "daily", from: "2026-03-01", to: "2026-03-10" }).success);
  assert.ok(!financeReportInput.safeParse({ report: "daily", from: "2026-03-10", to: "2026-03-01" }).success, "end before start");
  assert.ok(!financeReportInput.safeParse({ report: "secret", from: "2026-03-01", to: "2026-03-10" }).success);
});

test("finance permissions exist, the suggested categories are the nine asked for, and methods map to money kinds", () => {
  for (const p of ["finance.read", "finance.write", "finance.void", "finance.approve", "finance.adjust", "finance.manage"]) assert.ok(ALL_PERMISSIONS.includes(p), p);
  assert.deepEqual(SUGGESTED_EXPENSE_CATEGORIES.map((c) => c.name), ["Shop Rent", "Salaries", "Electricity", "Internet", "Transportation", "Packaging", "Marketing", "Maintenance", "Other Expenses"]);
  assert.deepEqual(FINANCE_METHODS.map((m) => METHOD_KIND[m]), ["cash", "bank", "wallet", "wallet"]);
  assert.equal(ROLES.other_income.type, "revenue");
  assert.ok(DEFAULT_ACCOUNTS.some((a) => a.role === "other_income" && a.type === "revenue" && !a.isGroup));
});

test("money accounts: cash, wallet clearing and every account under the bank heading — and nothing else", () => {
  const accounts = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, { name: a.name, type: a.type, parent: a.parent, isGroup: Boolean(a.isGroup), active: true }]));
  accounts["1022"] = { name: "HBL", type: "asset", parent: "1020", isGroup: false, active: true };
  const roles = Object.fromEntries(DEFAULT_ACCOUNTS.filter((a) => a.role).map((a) => [a.role, a.code]));
  const money = moneyAccountsOf({ accounts, roles });
  assert.deepEqual([...money.keys()].sort(), ["1010", "1021", "1022", "1030"]);
  assert.deepEqual([money.get("1010").kind, money.get("1021").kind, money.get("1030").kind], ["cash", "bank", "wallet"]);
  assert.ok(!money.has("1110") && !money.has("4010") && !money.has("1200"), "receivables, revenue and inventory are not money accounts");
});

test("receipts are private file paths under receipts/, never public links", () => {
  assert.ok(isReceiptUrl("receipts/u1/bill-x.pdf"));
  assert.ok(isReceiptUrl("receipts/u1/bill-AbC_123.final.pdf"));
  assert.ok(!isReceiptUrl("https://abc123.public.blob.vercel-storage.com/receipts/u1/bill.pdf"), "a public link is refused");
  assert.ok(!isReceiptUrl("https://evil.example.com/receipts/u1/a.pdf"));
  assert.ok(!isReceiptUrl("hr/u1/cnic.png"), "another kind of private file is not a receipt");
  assert.ok(!isReceiptUrl("uploads/p1/photo.jpg"));
  assert.ok(!isReceiptUrl("receipts/../hr/u1/cnic.png"));
  assert.ok(!isReceiptUrl("receipts/u1/"));
  assert.ok(!isReceiptUrl("javascript:alert(1)"));
});

const report = { title: "Daily", from: "2026-03-01", to: "2026-03-02", tables: [{ title: "By day", columns: [{ key: "date", label: "Date", type: "text" }, { key: "note", label: "Note", type: "text" }, { key: "amount", label: "Amount", type: "money" }], rows: [{ date: "2026-03-01", note: '=HYPERLINK("http://x")', amount: 123456 }, { date: "2026-03-02", note: "a, b", amount: -500 }], totals: { date: "Total", note: "", amount: 122956 } }] };

test("CSV export: rupees with two decimals, commas quoted, spreadsheet formulas neutralised", () => {
  const lines = reportCsv(report).split("\r\n");
  assert.equal(lines[0], "Daily");
  assert.equal(lines[5], '2026-03-01,"\'=HYPERLINK(""http://x"")",1234.56');
  assert.equal(lines[6], '2026-03-02,"a, b",-5.00');
  assert.equal(lines[7], "Total,,1229.56");
});

test("report tables escape their text and show empty periods honestly", () => {
  const html = tableHtml({ ...report.tables[0], rows: [{ date: "<img src=x>", note: "n", amount: 1 }] });
  assert.ok(!html.includes("<img") && html.includes("&lt;img"));
  assert.match(tableHtml({ title: "Empty", columns: [], rows: [] }), /Nothing in this period/);
});
