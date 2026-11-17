/**
 * Income, expenses, cash and bank management against the emulators (`npm run test:emulator`). Everything is created in a
 * throwaway "demo-" database; nothing real is involved. Tests share state and run in order.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const accounting = await import("../../functions/services/accounting.js");
const reports = await import("../../functions/services/accountingReports.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");
const { addDays } = await import("../../functions/shared/finance.js");

const key = () => randomUUID().replace(/-/g, "");
const TODAY = pktDateKey(new Date());
const D = (n) => addDays(TODAY, n);
const PERMS = {
  reader: ["finance.read"],
  clerk: ["finance.read", "finance.write"],
  approver: ["finance.read", "finance.write", "finance.approve"],
  owner: ["finance.read", "finance.write", "finance.void", "finance.approve", "finance.adjust", "finance.manage"],
};
const TOKENS = Object.fromEntries(Object.entries(PERMS).map(([k, perms]) => [k, { uid: `u-${k}`, name: k, staff: true, perms, auth_time: 9999999999 }]));
TOKENS.other = { uid: "u-other", name: "other", staff: true, perms: ["orders.read"], auth_time: 9999999999 };
TOKENS.customer = { uid: "cust-1" };
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });
const ok = async (name, token, data) => {
  const r = await call(name, token, data);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const get = async (path) => (await db.doc(path).get()).data();
const ledgerNet = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const journals = async (prefix) => (await db.collection("journalEntries").get()).docs.filter((d) => d.id.startsWith(prefix));
const ids = {};

const entryReq = (over = {}) => ({ idempotencyKey: key(), type: "expense", date: TODAY, amount: 250000, title: "Shop electricity", categoryId: ids.exp.electricity, method: "cash", ...over });
const incomeReq = (over = {}) => entryReq({ type: "income", title: "Commission received", categoryId: ids.inc.other, amount: 400000, ...over });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-1") await auth.createUser({ uid: t.uid }).catch(() => {});
  await accounting.initializeAccounting("seed");
});

test("every finance endpoint needs its own permission", async () => {
  const body = { from: TODAY, to: TODAY };
  const probes = [["financeDashboard", body, "reader"], ["financeReport", { report: "daily", ...body }, "reader"], ["listFinanceEntries", {}, "reader"], ["listFinanceCategories", {}, "reader"], ["listMoneyAccounts", {}, "reader"]];
  for (const [name, data] of probes) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "other", data)).status, 403, `${name} unrelated staff`);
  }
  assert.equal((await call("listFinanceEntries", "reader", {})).status, 200);
  const writes = [["saveFinanceEntry", { idempotencyKey: key(), type: "income", date: TODAY, amount: 100, title: "x1", categoryId: "c", method: "cash" }], ["createTransfer", { idempotencyKey: key(), date: TODAY, fromAccount: "1010", toAccount: "1021", amount: 100 }], ["recordCashCount", { idempotencyKey: key(), accountCode: "1010", date: TODAY, countedAmount: 0 }]];
  for (const [name, data] of writes) assert.equal((await call(name, "reader", data)).status, 403, `${name} read-only`);
  const manage = [["saveFinanceCategory", { kind: "expense", name: "Tea" }], ["addSuggestedCategories", { kind: "expense" }], ["saveFinanceSettings", { approvalThreshold: 100 }], ["addBankAccount", { idempotencyKey: key(), name: "HBL" }], ["runRecurring", {}], ["saveRecurring", { title: "Rent", amount: 100, categoryId: "c", method: "cash", frequency: "monthly", startDate: TODAY }]];
  for (const [name, data] of manage) assert.equal((await call(name, "approver", data)).status, 403, `${name} needs finance.manage`);
  assert.equal((await call("voidFinanceEntry", "clerk", { id: "x", reason: "nope" })).status, 403);
  assert.equal((await call("decideExpense", "clerk", { id: "x", decision: "approve" })).status, 403);
});

test("categories: suggested ones are added once, are configurable, and post through existing account roles", async () => {
  const first = await ok("addSuggestedCategories", "owner", { kind: "expense" });
  assert.equal(first.created.length, 9);
  assert.ok(["Shop Rent", "Salaries", "Electricity", "Internet", "Transportation", "Packaging", "Marketing", "Maintenance", "Other Expenses"].every((n) => first.created.includes(n)));
  assert.deepEqual((await ok("addSuggestedCategories", "owner", { kind: "expense" })).created, [], "nothing added twice");
  assert.deepEqual((await ok("addSuggestedCategories", "owner", { kind: "income" })).created, ["Other Income"]);
  const cats = (await ok("listFinanceCategories", "reader", {})).categories;
  ids.exp = Object.fromEntries(cats.filter((c) => c.kind === "expense").map((c) => [c.name.split(" ")[0].toLowerCase(), c.id]));
  ids.inc = { other: cats.find((c) => c.kind === "income").id };
  assert.equal((await call("saveFinanceCategory", "owner", { kind: "expense", name: "electricity" })).status, 409, "duplicate name");
  const own = await ok("saveFinanceCategory", "owner", { kind: "income", name: "Commission", accountCode: null });
  ids.inc.commission = own.id;
  assert.equal((await call("saveFinanceCategory", "owner", { kind: "income", name: "Bad", accountCode: "6010" })).status, 400, "an income category needs a revenue account");
  assert.equal((await call("saveFinanceCategory", "owner", { kind: "expense", name: "Bad2", accountCode: "4010" })).status, 400);
  const renamed = await ok("saveFinanceCategory", "owner", { id: ids.exp.maintenance, kind: "expense", name: "Repairs & Maintenance" });
  assert.equal(renamed.id, ids.exp.maintenance);
  await ok("setFinanceCategoryActive", "owner", { id: ids.exp.packaging, isActive: false });
  assert.equal((await call("saveFinanceEntry", "clerk", entryReq({ categoryId: ids.exp.packaging }))).status, 400, "a switched-off category can't be used");
  await ok("setFinanceCategoryActive", "owner", { id: ids.exp.packaging, isActive: true });
});

test("income: Dr money account / Cr income account; the same request twice is one entry and one journal; cash, bank and wallet each use their own account", async () => {
  const req = incomeReq({ reference: "COM-1", description: "Monthly commission" });
  const a = await ok("saveFinanceEntry", "clerk", req);
  const again = await ok("saveFinanceEntry", "clerk", req);
  assert.deepEqual([again.id, again.existing], [a.id, true]);
  assert.match(a.number, /^FN-\d{6}$/);
  assert.equal((await db.collection("financeEntries").get()).size, 1);
  const j = await get(`journalEntries/finance__${a.id}__v1`);
  assert.deepEqual(j.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1010", 400000, 0], ["4050", 0, 400000]]);
  assert.equal(j.totalDebit, j.totalCredit);
  assert.equal((await journals(`finance__${a.id}`)).length, 1, "one journal");
  const e = await get(`financeEntries/${a.id}`);
  assert.deepEqual([e.status, e.type, e.amount, e.method, e.accountCode, e.reference, e.version, e.history[0].action, e.createdBy], ["posted", "income", 400000, "cash", "1010", "COM-1", 1, "created", "u-clerk"]);
  const bank = await ok("saveFinanceEntry", "clerk", incomeReq({ method: "bank_transfer", amount: 100000 }));
  assert.equal((await get(`journalEntries/finance__${bank.id}__v1`)).lines[0].accountCode, "1021");
  const wallet = await ok("saveFinanceEntry", "clerk", incomeReq({ method: "easypaisa", amount: 50000 }));
  assert.equal((await get(`journalEntries/finance__${wallet.id}__v1`)).lines[0].accountCode, "1030", "wallet money lands in clearing, not the bank");
  assert.equal((await call("saveFinanceEntry", "clerk", incomeReq({ method: "cash", accountCode: "1021" }))).status, 400, "a cash payment can't go to a bank account");
  ids.income1 = a.id;
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data()).find((x) => x.action === "finance.income_created" && x.entityId === a.id);
  assert.ok(audit && audit.actorUid === "u-clerk" && audit.changes.amount === 400000);
});

test("expense: Dr expense account / Cr money account; Salaries use the salaries account; entries are validated on the server", async () => {
  const a = await ok("saveFinanceEntry", "clerk", entryReq({ vendorName: "LESCO", reference: "BILL-77" }));
  assert.deepEqual((await get(`journalEntries/finance__${a.id}__v1`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["6010", 250000, 0], ["1010", 0, 250000]]);
  const sal = await ok("saveFinanceEntry", "clerk", entryReq({ categoryId: ids.exp.salaries, title: "June salaries", amount: 900000, method: "bank_transfer" }));
  assert.deepEqual((await get(`journalEntries/finance__${sal.id}__v1`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["6020", 900000, 0], ["1021", 0, 900000]]);
  assert.deepEqual((await get(`financeEntries/${a.id}`)).vendor, { name: "LESCO", supplierId: null });
  const bad = (over) => call("saveFinanceEntry", "clerk", entryReq(over));
  assert.equal((await bad({ amount: 0 })).status, 400);
  assert.equal((await bad({ amount: 10.5 })).status, 400, "whole paisa only");
  assert.equal((await bad({ amount: -5 })).status, 400);
  assert.equal((await bad({ date: D(30) })).status, 400, "future date");
  assert.equal((await bad({ date: "2026-13-45" })).status, 400);
  assert.equal((await bad({ categoryId: ids.inc.other })).status, 400, "an expense needs an expense category");
  assert.equal((await bad({ categoryId: "nope" })).status, 400);
  assert.equal((await bad({ method: "card" })).status, 400);
  assert.equal((await bad({ attachments: [{ url: "https://evil.example/x.pdf", name: "x", type: "application/pdf", size: 10 }] })).status, 400, "attachments must come from the receipt uploader");
  const withFile = await ok("saveFinanceEntry", "clerk", entryReq({ title: "With receipt", attachments: [{ url: "receipts/u-clerk/bill-x.pdf", name: "bill.pdf", type: "application/pdf", size: 1200 }] }));
  assert.equal((await get(`financeEntries/${withFile.id}`)).attachments.length, 1);
  ids.expense1 = a.id;
});

test("editing reverses the old posting and posts the new one; posted journals are never changed; a stale edit is refused", async () => {
  const before = await get(`journalEntries/finance__${ids.income1}__v1`);
  const net0 = await ledgerNet("4050");
  const edit = await ok("saveFinanceEntry", "clerk", { ...incomeReq({ amount: 450000, title: "Commission (corrected)" }), idempotencyKey: undefined, id: ids.income1, expectedVersion: 1, date: D(-1) });
  assert.equal(edit.version, 2);
  assert.deepEqual((await get(`journalEntries/finance__${ids.income1}__v1`)).lines, before.lines, "the original journal is untouched");
  assert.equal((await get(`journalEntries/finance__${ids.income1}__v1`)).status, "posted");
  const rev = await get(`journalEntries/reversal__finance__${ids.income1}__v1`);
  assert.deepEqual(rev.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1010", 0, 400000], ["4050", 400000, 0]], "debits and credits swapped");
  assert.equal(rev.dateKey, TODAY, "reversed on the original date");
  const v2 = await get(`journalEntries/finance__${ids.income1}__v2`);
  assert.deepEqual([v2.dateKey, v2.totalDebit], [D(-1), 450000]);
  assert.equal((await ledgerNet("4050")) - net0, -50000, "net effect = the correction");
  const e = await get(`financeEntries/${ids.income1}`);
  assert.deepEqual([e.version, e.amount, e.journalId, e.history.map((h) => h.action)], [2, 450000, `finance__${ids.income1}__v2`, ["created", "edited"]]);
  const stale = await call("saveFinanceEntry", "clerk", { ...incomeReq(), idempotencyKey: undefined, id: ids.income1, expectedVersion: 1 });
  assert.equal(stale.status, 409, "someone else already changed it");
  assert.equal((await call("saveFinanceEntry", "clerk", { ...entryReq(), idempotencyKey: undefined, id: ids.income1, expectedVersion: 2 })).status, 400, "the type can't be changed");
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "finance.income_edited" && d.data().entityId === ids.income1 && d.data().changes.changed.amount.to === 450000));
});

test("deleting voids the entry and reverses its journal; deleting twice does nothing more; it needs finance.void", async () => {
  const x = await ok("saveFinanceEntry", "clerk", entryReq({ title: "To delete", amount: 33300 }));
  const net = await ledgerNet("6010");
  assert.equal((await call("voidFinanceEntry", "clerk", { id: x.id, reason: "Entered twice" })).status, 403);
  const v = await ok("voidFinanceEntry", "owner", { id: x.id, reason: "Entered twice" });
  assert.equal(v.status, "void");
  assert.equal((await ledgerNet("6010")) - net, -33300, "the books are corrected by a reversal");
  assert.ok((await get(`journalEntries/reversal__finance__${x.id}__v1`)));
  assert.equal((await get(`journalEntries/finance__${x.id}__v1`)).status, "posted", "the original stays posted and visible");
  assert.equal((await ok("voidFinanceEntry", "owner", { id: x.id, reason: "Entered twice" })).existing, true);
  assert.equal((await journals(`reversal__finance__${x.id}`)).length, 1, "one reversal");
  const e = await get(`financeEntries/${x.id}`);
  assert.deepEqual([e.status, e.voidReason, e.voidedBy], ["void", "Entered twice", "u-owner"]);
  assert.equal((await call("saveFinanceEntry", "clerk", { ...entryReq(), idempotencyKey: undefined, id: x.id, expectedVersion: 1 })).status, 400, "a void entry can't be edited");
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "finance.entry_voided" && d.data().entityId === x.id));
});

test("approval: large expenses wait for someone else; nothing is posted until approved; rejected ones never are", async () => {
  await ok("saveFinanceSettings", "owner", { approvalThreshold: 500000 });
  assert.equal((await ok("getFinanceSettings", "reader", {})).approvalThreshold, 500000);
  const net0 = await ledgerNet("6010");
  const small = await ok("saveFinanceEntry", "clerk", entryReq({ amount: 499999, title: "Just under" }));
  assert.equal(small.status, "posted");
  const big = await ok("saveFinanceEntry", "clerk", entryReq({ amount: 800000, title: "New signboard", categoryId: ids.exp.marketing }));
  assert.equal(big.status, "pending");
  assert.equal((await db.doc(`journalEntries/finance__${big.id}__v1`).get()).exists, false, "no journal yet");
  assert.equal((await ledgerNet("6010")) - net0, 499999);
  assert.equal((await call("decideExpense", "approver", { id: "nope", decision: "approve" })).status, 404);
  const ownerBypass = await ok("saveFinanceEntry", "approver", entryReq({ amount: 900000, title: "Approver's own" }));
  assert.equal(ownerBypass.status, "posted", "approvers enter large expenses directly");
  const self = await call("decideExpense", "approver", { id: ownerBypass.id, decision: "approve" });
  assert.equal(self.body.data.existing, true, "already posted: nothing to decide");
  const pendingByApprover = await ok("saveFinanceEntry", "clerk", entryReq({ amount: 700000, title: "Second", categoryId: ids.exp.shop }));
  const done = await ok("decideExpense", "approver", { id: big.id, decision: "approve", note: "OK" });
  assert.equal(done.status, "posted");
  assert.equal((await get(`journalEntries/finance__${big.id}__v1`)).totalDebit, 800000);
  assert.equal((await ok("decideExpense", "approver", { id: big.id, decision: "approve" })).existing, true, "deciding twice posts once");
  assert.equal((await journals(`finance__${big.id}`)).length, 1);
  const rej = await ok("decideExpense", "owner", { id: pendingByApprover.id, decision: "reject", note: "Not needed" });
  assert.equal(rej.status, "rejected");
  assert.equal((await db.doc(`journalEntries/finance__${pendingByApprover.id}__v1`).get()).exists, false);
  const clerkEdit = await call("saveFinanceEntry", "clerk", { ...entryReq({ amount: 900000 }), idempotencyKey: undefined, id: big.id, expectedVersion: 1 });
  assert.equal(clerkEdit.status, 403, "a clerk can't edit a large posted expense");
  const h = (await get(`financeEntries/${big.id}`)).history.map((x) => x.action);
  assert.deepEqual(h, ["submitted", "approved"]);
  // The person who entered it can't approve it themselves.
  await ok("saveFinanceSettings", "owner", { approvalThreshold: 100000 });
  const mine = await ok("saveFinanceEntry", "clerk", entryReq({ amount: 200000, title: "Mine" }));
  const tokenWithApprove = { ...TOKENS.approver, uid: "u-clerk" };
  TOKENS.clerkApprover = tokenWithApprove;
  assert.equal((await call("decideExpense", "clerkApprover", { id: mine.id, decision: "approve" })).status, 403, "maker-checker");
  await ok("decideExpense", "approver", { id: mine.id, decision: "approve" });
  await ok("saveFinanceSettings", "owner", { approvalThreshold: 0 });
});

test("transfers move money between your own accounts: balanced, not income or expense, never more than the account holds, once per request", async () => {
  await ok("saveFinanceEntry", "clerk", incomeReq({ amount: 5000000, title: "Cash takings banked later" }));
  const bank = await ok("addBankAccount", "owner", { idempotencyKey: "bank-key-0001", name: "HBL Current" });
  assert.equal(bank.code, "1022");
  assert.equal((await ok("addBankAccount", "owner", { idempotencyKey: "bank-key-0001", name: "HBL Current" })).existing, true);
  assert.equal((await call("addBankAccount", "owner", { idempotencyKey: key(), name: "hbl current" })).status, 409);
  const accts = (await ok("listMoneyAccounts", "reader", {})).accounts;
  assert.deepEqual(accts.map((a) => [a.code, a.kind]), [["1010", "cash"], ["1021", "bank"], ["1022", "bank"], ["1030", "wallet"]]);
  const pl0 = await reports.profitAndLoss({ from: D(-5), to: TODAY });
  const cash0 = accts.find((a) => a.code === "1010").balance;
  const t = { idempotencyKey: key(), date: TODAY, fromAccount: "1010", toAccount: "1022", amount: 100000, reference: "DEP-1" };
  const r = await ok("createTransfer", "clerk", t);
  assert.equal((await ok("createTransfer", "clerk", t)).existing, true);
  assert.equal((await db.collection("financeEntries").where("type", "==", "transfer").get()).size, 1);
  assert.deepEqual((await get(`journalEntries/finance__${r.id}__v1`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1022", 100000, 0], ["1010", 0, 100000]]);
  const pl1 = await reports.profitAndLoss({ from: D(-5), to: TODAY });
  assert.deepEqual([pl1.netRevenue, pl1.operatingExpensesTotal, pl1.netProfit], [pl0.netRevenue, pl0.operatingExpensesTotal, pl0.netProfit], "a transfer is not income or an expense");
  const after = (await ok("listMoneyAccounts", "reader", {})).accounts;
  assert.equal(after.find((a) => a.code === "1010").balance, cash0 - 100000);
  assert.equal(after.find((a) => a.code === "1022").balance, 100000);
  assert.equal((await call("createTransfer", "clerk", { ...t, idempotencyKey: key(), amount: 99999999999 })).status, 400, "more than the account holds");
  assert.equal((await call("createTransfer", "clerk", { ...t, idempotencyKey: key(), toAccount: "1010" })).status, 400, "same account");
  assert.equal((await call("createTransfer", "clerk", { ...t, idempotencyKey: key(), toAccount: "4010" })).status, 400, "not a money account");
  const bankToCash = await ok("createTransfer", "clerk", { idempotencyKey: key(), date: TODAY, fromAccount: "1022", toAccount: "1010", amount: 30000 });
  assert.equal((await get(`journalEntries/finance__${bankToCash.id}__v1`)).lines[0].accountCode, "1010");
  await ok("saveFinanceEntry", "clerk", incomeReq({ method: "bank_transfer", accountCode: "1022", amount: 20000, title: "To the new account" }));
  assert.equal((await get(`journalEntries/finance__${(await db.collection("financeEntries").where("title", "==", "To the new account").get()).docs[0].id}__v1`)).lines[0].accountCode, "1022", "a specific bank account can be chosen");
  const v = await ok("voidFinanceEntry", "owner", { id: r.id, reason: "Deposit slip was wrong" });
  assert.equal(v.status, "void");
  assert.equal((await ok("listMoneyAccounts", "reader", {})).accounts.find((a) => a.code === "1022").balance, 30000 * -1 + 20000, "the transfer was reversed (only the later movements remain)");
  ids.transfer = r.id;
});

test("cash reconciliation: expected comes from the books; a difference is recorded, and posted only by someone authorised", async () => {
  const exp = (await ok("listMoneyAccounts", "reader", {})).accounts.find((a) => a.code === "1010").balance;
  const exact = await ok("recordCashCount", "clerk", { idempotencyKey: key(), accountCode: "1010", date: TODAY, countedAmount: exp });
  assert.deepEqual([exact.expected, exact.variance, exact.status], [exp, 0, "reconciled"]);
  const net0 = await ledgerNet("6010");
  const diff = await ok("recordCashCount", "clerk", { idempotencyKey: key(), accountCode: "1010", date: TODAY, countedAmount: exp - 70000, note: "Drawer short" });
  assert.deepEqual([diff.variance, diff.status, diff.adjustmentId], [-70000, "difference", null]);
  assert.equal(await ledgerNet("6010"), net0, "recording a count posts nothing");
  assert.equal((await call("recordCashCount", "clerk", { idempotencyKey: key(), accountCode: "1010", date: TODAY, countedAmount: exp - 70000, adjust: true })).status, 403);
  const k = key();
  const adj = await ok("recordCashCount", "owner", { idempotencyKey: k, accountCode: "1010", date: TODAY, countedAmount: exp - 70000, note: "Authorised", adjust: true });
  assert.deepEqual([adj.status, adj.variance], ["adjusted", -70000]);
  assert.equal((await ok("recordCashCount", "owner", { idempotencyKey: k, accountCode: "1010", date: TODAY, countedAmount: exp - 70000, adjust: true })).existing, true);
  assert.equal((await ledgerNet("6010")) - net0, 70000, "a shortage is an expense");
  assert.deepEqual((await get(`journalEntries/finance__${adj.adjustmentId}__v1`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["6010", 70000, 0], ["1010", 0, 70000]]);
  const now = (await ok("listMoneyAccounts", "reader", {})).accounts.find((a) => a.code === "1010").balance;
  assert.equal(now, exp - 70000);
  const excess = await ok("recordCashCount", "owner", { idempotencyKey: key(), accountCode: "1010", date: TODAY, countedAmount: now + 5000, adjust: true });
  assert.deepEqual((await get(`journalEntries/finance__${excess.adjustmentId}__v1`)).lines.map((l) => [l.accountCode, l.debit, l.credit]), [["1010", 5000, 0], ["6010", 0, 5000]]);
  assert.equal((await call("recordCashCount", "owner", { idempotencyKey: key(), accountCode: "4010", date: TODAY, countedAmount: 1 })).status, 400);
  assert.equal((await call("voidFinanceEntry", "clerk", { id: adj.adjustmentId, reason: "no" })).status, 403);
});

test("recurring expenses create each due entry once, even when run twice or at the same time", async () => {
  const r = await ok("saveRecurring", "owner", { title: "Shop rent", amount: 3000000, categoryId: ids.exp.shop, method: "cash", frequency: "monthly", startDate: D(-70), vendorName: "Landlord" });
  assert.equal((await call("saveRecurring", "owner", { title: "Bad", amount: 100, categoryId: ids.inc.other, method: "cash", frequency: "monthly", startDate: TODAY })).status, 400);
  const runs = await Promise.all([call("runRecurring", "owner", {}), call("runRecurring", "owner", {})]);
  assert.ok(runs.every((x) => x.status === 200));
  const mine = (await db.collection("financeEntries").where("recurringId", "==", r.id).get()).docs.map((d) => d.data());
  assert.ok(mine.length >= 2 && mine.length <= 3, `generated ${mine.length}`);
  assert.equal(new Set(mine.map((e) => e.date)).size, mine.length, "one entry per due date");
  assert.ok(mine.every((e) => e.status === "posted" && e.amount === 3000000));
  assert.deepEqual((await ok("runRecurring", "owner", {})).created, [], "nothing new on a later run");
  const rec = (await ok("listRecurring", "reader", {})).recurring.find((x) => x.id === r.id);
  assert.ok(rec.nextDate > TODAY);
  for (const e of (await db.collection("financeEntries").where("recurringId", "==", r.id).get()).docs) assert.equal((await journals(`finance__${e.id}__v1`)).length, 1, "one journal each");
  await ok("setRecurringActive", "owner", { id: r.id, isActive: false });
});

test("the dashboard comes from the books: income, expenses, profit, cash, bank, receivables, payables, today and date filters", async () => {
  const from = D(-120);
  const dash = await ok("financeDashboard", "reader", { from, to: TODAY });
  const pl = await reports.profitAndLoss({ from, to: TODAY });
  const ov = await reports.overview();
  assert.deepEqual([dash.income.total, dash.grossProfit, dash.netProfit, dash.operatingExpenses, dash.costOfSales], [pl.netRevenue, pl.grossProfit, pl.netProfit, pl.operatingExpensesTotal, pl.costOfSalesTotal]);
  assert.equal(dash.totalExpenses, pl.costOfSalesTotal + pl.operatingExpensesTotal);
  assert.equal(dash.netProfit, dash.income.total - dash.totalExpenses, "net = income − expenses");
  assert.equal(dash.income.sales + dash.income.other, dash.income.total);
  assert.equal(dash.cash.inHand, await ledgerNet("1010"));
  assert.equal(dash.cash.bank, (await ledgerNet("1021")) + (await ledgerNet("1022")));
  assert.equal(dash.cash.wallet, await ledgerNet("1030"));
  assert.deepEqual([dash.receivables, dash.payables], [ov.receivables, ov.payables]);
  const todayOnly = await ok("financeDashboard", "reader", { from: TODAY, to: TODAY });
  assert.equal(dash.today.income, todayOnly.income.total);
  assert.equal(dash.today.expenses, todayOnly.totalExpenses);
  const future = await ok("financeDashboard", "reader", { from: D(5), to: D(9) });
  assert.deepEqual([future.income.total, future.totalExpenses, future.netProfit], [0, 0, 0], "a range with nothing in it shows zero, not invented numbers");
  const yesterday = await ok("financeDashboard", "reader", { from: D(-1), to: D(-1) });
  assert.equal(yesterday.income.total, (await reports.profitAndLoss({ from: D(-1), to: D(-1) })).netRevenue, "yesterday = the books for that day");
  assert.equal((await call("financeDashboard", "reader", { from: TODAY, to: D(-3) })).status, 400, "end before start");
  assert.equal((await call("financeDashboard", "reader", { from: "bad", to: TODAY })).status, 400);
});

test("reports: daily, monthly, cash flow, profit & loss, cash register, bank, categories and the ledger all agree with the books", async () => {
  const from = D(-120);
  const daily = await ok("financeReport", "reader", { report: "daily", from: D(-90), to: TODAY });
  const dt = daily.tables[0];
  assert.equal(dt.totals.net, dt.totals.income - dt.totals.cost - dt.totals.expenses);
  const plWindow = await reports.profitAndLoss({ from: D(-90), to: TODAY });
  assert.deepEqual([dt.totals.income, dt.totals.expenses, dt.totals.net], [plWindow.netRevenue, plWindow.operatingExpensesTotal, plWindow.netProfit]);
  assert.equal((await call("financeReport", "reader", { report: "daily", from: D(-200), to: TODAY })).status, 400, "too long a range for a daily report");
  const monthly = await ok("financeReport", "reader", { report: "monthly", from, to: TODAY });
  assert.equal(monthly.tables[0].totals.net, (await reports.profitAndLoss({ from: `${monthly.from}`, to: TODAY })).netProfit, "whole months add up to the same profit");
  const pnl = await ok("financeReport", "reader", { report: "pnl", from, to: TODAY });
  assert.equal(pnl.tables[0].rows.at(-1).amount, (await ok("financeDashboard", "reader", { from, to: TODAY })).netProfit);
  const cf = await ok("financeReport", "reader", { report: "cashflow", from, to: TODAY });
  const cft = cf.tables[0].totals;
  assert.equal(cf.tables[1].totals.opening + cft.in - cft.out, cf.tables[1].totals.closing, "closing = opening + in − out");
  const reg = await ok("financeReport", "reader", { report: "cashregister", from: D(-60), to: TODAY });
  const rt = reg.tables[0];
  assert.equal(rt.totals.opening + rt.totals.in - rt.totals.out, rt.totals.closing, "Closing Cash = Opening Cash + Cash In − Cash Out");
  assert.equal(rt.totals.closing, await ledgerNet("1010"));
  let running = rt.totals.opening;
  for (const r of rt.rows) {
    assert.equal(r.opening, running);
    running = r.opening + r.in - r.out;
    assert.equal(r.closing, running, `day ${r.date}`);
  }
  assert.ok(reg.tables[2].rows.some((r) => r.variance === -70000), "cash counts appear in the reconciliation table");
  const bank = await ok("financeReport", "reader", { report: "bank", from: D(-60), to: TODAY });
  assert.equal(bank.tables[0].totals.closing, (await ledgerNet("1021")) + (await ledgerNet("1022")) + (await ledgerNet("1030")));
  assert.ok(bank.tables[1].rows.some((r) => r.type === "transfer"), "transfers show on the bank report");
  const expcat = await ok("financeReport", "reader", { report: "expensecat", from, to: TODAY });
  const posted = (await db.collection("financeEntries").where("type", "==", "expense").get()).docs.map((d) => d.data()).filter((e) => e.status === "posted");
  assert.equal(expcat.tables[0].totals.amount, posted.reduce((n, e) => n + e.amount, 0), "category totals = the posted expense entries (void and rejected left out)");
  assert.ok(expcat.tables[0].rows.some((r) => r.category === "Salaries" && r.amount === 900000));
  const inccat = await ok("financeReport", "reader", { report: "incomecat", from, to: TODAY });
  assert.ok(inccat.tables[0].rows.some((r) => r.category === "Other Income"));
  assert.ok(inccat.tables[0].rows.some((r) => r.category.startsWith("Sales")));
  const ledger = await ok("financeReport", "reader", { report: "ledger", from, to: TODAY });
  assert.ok(ledger.tables[0].rows.every((r) => r.status !== "void"));
  assert.ok(ledger.tables[0].rows.length >= 10);
  const list = await ok("listFinanceEntries", "reader", { type: "expense", status: "posted", limit: 3 });
  assert.equal(list.entries.length, 3);
  const page2 = await ok("listFinanceEntries", "reader", { type: "expense", status: "posted", limit: 3, after: list.next });
  assert.ok(page2.entries.every((e) => !list.entries.some((x) => x.id === e.id)), "pages don't repeat");
  assert.ok((await ok("listFinanceEntries", "reader", { from: TODAY, to: TODAY })).entries.every((e) => e.date === TODAY));
  assert.ok((await ok("listFinanceEntries", "reader", { accountCode: "1022" })).entries.every((e) => e.accountCode === "1022" || e.toAccountCode === "1022"));
});

test("accounting integrity: every journal balances, finance journals are unique and immutable, and the trial balance balances", async () => {
  const all = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(all.every((j) => j.totalDebit === j.totalCredit && j.status === "posted"));
  const fin = all.filter((j) => j.sourceType === "finance");
  assert.ok(fin.length >= 12);
  assert.equal(new Set(fin.map((j) => j.id)).size, fin.length);
  for (const e of (await db.collection("financeEntries").get()).docs) {
    const d = e.data();
    if (d.status === "posted") assert.equal((await journals(`finance__${e.id}__v${d.version}`)).length, 1, `${d.number} has one current journal`);
    if (d.status === "pending" || d.status === "rejected") assert.equal((await journals(`finance__${e.id}`)).length, 0, `${d.number} has no journal`);
  }
  const tb = await reports.trialBalance({ from: D(-200), to: TODAY });
  assert.equal(tb.balanced, true);
  assert.equal((await db.collection("accountingExceptions").get()).size, 0, "no posting failed");
  assert.equal((await call("saveFinanceEntry", "clerk", incomeReq({ categoryId: ids.inc.commission }))).status, 200, "a category without its own account uses the other-income role");
  await db.doc("accountingConfig/main").update({ "accounts.4050.active": false });
  const blocked = await call("saveFinanceEntry", "clerk", incomeReq());
  assert.equal(blocked.status, 400, "an account problem blocks the entry with a clear message");
  assert.match(blocked.body.error.message, /can't be used|No account/);
  assert.equal((await db.collection("accountingExceptions").get()).size, 0, "and leaves nothing half-saved");
  await db.doc("accountingConfig/main").update({ "accounts.4050.active": true });
});

test("receipt uploads: only people who may record finance entries, only into their own receipts/ folder, PDF or image up to 5 MB; photo uploads still need products.write", async () => {
  const { authorizeBlobUpload } = await import("../../functions/services/images.js");
  const as = (name) => ({ verifyToken: async () => TOKENS[name] });
  const go = (name, pathname) => authorizeBlobUpload({ pathname, authorization: "Bearer x" }, as(name));
  const grant = await go("clerk", "receipts/u-clerk/bill.pdf");
  assert.deepEqual(grant.allowedContentTypes, ["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  assert.equal(grant.maximumSizeInBytes, 5 * 1024 * 1024);
  assert.equal(JSON.parse(grant.tokenPayload).uid, "u-clerk");
  await assert.rejects(go("reader", "receipts/u-reader/bill.pdf"), /permission/i);
  await assert.rejects(go("other", "receipts/u-other/bill.pdf"), /permission/i);
  await assert.rejects(go("clerk", "receipts/u-owner/bill.pdf"), /isn't allowed/, "someone else's folder");
  await assert.rejects(go("clerk", "receipts/u-clerk/../../x.pdf"), /isn't allowed/);
  await assert.rejects(go("clerk", "receipts/u-clerk/a/b.pdf"), /isn't allowed/);
  await assert.rejects(go("clerk", "uploads/p1/photo.jpg"), /permission/i, "a clerk can't upload product photos");
  await assert.rejects(authorizeBlobUpload({ pathname: "receipts/u-clerk/a.pdf" }, as("clerk")), /sign in/i);
});
