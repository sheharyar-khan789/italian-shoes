/**
 * Income, expenses, transfers and cash counts. Every money movement is posted to the existing double-entry
 * accounting engine (accounting.js) in the same transaction that saves the record, so a record can never exist
 * without its journal, and a retry can never post a second one:
 *
 *   financeEntries/{id}     the business record (income | expense | transfer | adjustment) with its history
 *   journal  finance__{id}__v{n}   the posted journal for version n (immutable)
 *   an edit REVERSES version n (reversal__finance__{id}__v{n}, on the entry's original date) and posts version n+1;
 *   a delete REVERSES the current version and marks the entry void. Nothing posted is ever changed or removed.
 *
 *   Income    Dr money account (cash / bank / wallet clearing)   Cr the category's income account
 *   Expense   Dr the category's expense account                  Cr money account
 *   Transfer  Dr receiving money account                         Cr paying money account   (not income, not expense)
 *   Cash count difference (authorised)  shortage: Dr operating expenses, Cr account; excess: the opposite
 *
 * Categories post through an account ROLE (operating expenses, salaries, other income) unless the owner points a
 * category at a specific account; no account is invented. Amounts are integer paisa and are checked here.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey } from "../shared/accounting.js";
import { DEFAULT_ROLE, METHOD_KIND, SUGGESTED_EXPENSE_CATEGORIES, SUGGESTED_INCOME_CATEGORIES, nextOccurrence, addDays } from "../shared/finance.js";
import { readAccounting, postInTx, reverseInTx, finishAccounting, buildJournal, AccountingError, configRef, saveAccount } from "./accounting.js";
import { balancesAsOf } from "./accountingReports.js";
import { naturalBalance } from "../shared/accounting.js";

const entries = () => db.collection("financeEntries");
const counterRef = () => db.collection("counters").doc("finance");
const settingsRef = () => db.collection("settings").doc("finance");
const journalIdFor = (id, version) => `finance__${id}__v${version}`;
const reversalFor = (id, version) => `reversal__${journalIdFor(id, version)}`;
const today = () => pktDateKey(new Date());
const money = (n) => `Rs. ${(n / 100).toLocaleString("en-PK")}`;
const nowIso = () => new Date().toISOString();

/** @typedef {{ uid: string, name: string }} Actor */

/* ───────── Money accounts (from the chart of accounts) ───────── */

/** Cash, mobile-wallet clearing and every bank account (children of the bank account's heading). @param {Record<string, any>} config */
export function moneyAccountsOf(config) {
  const bankParent = config.accounts[config.roles.bank]?.parent;
  /** @type {Map<string, { code: string, name: string, kind: "cash" | "bank" | "wallet", active: boolean }>} */
  const out = new Map();
  for (const [code, a] of Object.entries(config.accounts)) {
    if (a.isGroup) continue;
    const kind = code === config.roles.cash ? "cash" : code === config.roles.wallet_clearing ? "wallet" : bankParent && a.parent === bankParent ? "bank" : null;
    if (kind) out.set(code, { code, name: a.name, kind, active: a.active !== false });
  }
  return out;
}

function moneyAccountFor(config, method, accountCode) {
  const all = moneyAccountsOf(config);
  const kind = METHOD_KIND[method];
  if (accountCode) {
    const a = all.get(accountCode);
    if (!a || !a.active) throw new AppError("invalid-argument", "That isn't an active cash, bank or wallet account.", { fields: { accountCode: "Choose a cash, bank or wallet account" } });
    if (a.kind !== kind) throw new AppError("invalid-argument", `A ${method.replace("_", " ")} payment can't go to a ${a.kind} account.`, { fields: { accountCode: "Doesn't match the payment method" } });
    return a;
  }
  const code = { cash: config.roles.cash, bank: config.roles.bank, wallet: config.roles.wallet_clearing }[kind];
  const a = code ? all.get(code) : null;
  if (!a || !a.active) throw new AppError("failed-precondition", `No ${kind} account is set up. Choose one in the Chart of Accounts.`);
  return a;
}

function categoryAccount(config, cat) {
  const code = cat.accountCode ?? config.roles[cat.role ?? DEFAULT_ROLE[cat.kind]];
  const a = code ? config.accounts[code] : null;
  const label = cat.kind === "income" ? "Other income" : "Operating expenses";
  if (!a) throw new AppError("failed-precondition", `"${cat.name}" has no account to post to. ${cat.accountCode ? "Choose another account for this category" : `Set an account for "${label}" in the Chart of Accounts (or choose an account for the category)`}.`);
  if (a.isGroup || a.active === false || a.type !== (cat.kind === "income" ? "revenue" : "expense")) throw new AppError("failed-precondition", `The account for "${cat.name}" (${code}) can't be used: it must be an active ${cat.kind === "income" ? "revenue" : "expense"} account.`);
  return code;
}

const assertDate = (date) => {
  if (date > addDays(today(), 1)) throw new AppError("invalid-argument", "The date can't be in the future.", { fields: { date: "In the future" } });
  if (date < "2000-01-01") throw new AppError("invalid-argument", "That date is too far back.", { fields: { date: "Too early" } });
};

function specOf(e, config) {
  const base = { sourceType: "finance", sourceId: `${e.id}__v${e.version}`, dateKey: e.date, meta: { entryNumber: e.number, entryType: e.type } };
  if (e.type === "income") return { ...base, memo: `${e.number} income: ${e.title}`, lines: [{ accountCode: e.accountCode, debit: e.amount, memo: e.title }, { accountCode: e.categoryAccount, credit: e.amount, memo: e.categoryName }] };
  if (e.type === "expense") return { ...base, memo: `${e.number} expense: ${e.title}`, lines: [{ accountCode: e.categoryAccount, debit: e.amount, memo: e.title }, { accountCode: e.accountCode, credit: e.amount, memo: e.categoryName }] };
  if (e.type === "transfer") return { ...base, memo: `${e.number} transfer: ${e.title}`, lines: [{ accountCode: e.toAccountCode, debit: e.amount }, { accountCode: e.accountCode, credit: e.amount }] };
  const opex = config.roles.operating_expenses;
  return { ...base, memo: `${e.number} cash adjustment: ${e.title}`, lines: e.direction === "shortage" ? [{ accountCode: opex, debit: e.amount }, { accountCode: e.accountCode, credit: e.amount }] : [{ accountCode: e.accountCode, debit: e.amount }, { accountCode: opex, credit: e.amount }] };
}

/** Post a journal or stop the whole transaction with the engine's own explanation. Posted journals are never touched. */
function postOrThrow(tx, acc, spec, actorUid) {
  if (!acc.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet. Create the chart of accounts first (Accounting → Chart of Accounts).");
  try {
    buildJournal(acc.config, spec);
  } catch (error) {
    if (error instanceof AccountingError) throw new AppError("failed-precondition", error.message);
    throw error;
  }
  const r = postInTx(tx, acc, spec, actorUid);
  if (r.status !== "posted") throw new AppError("failed-precondition", "This couldn't be posted to the books. Nothing was saved.");
  return r;
}

const entryHistory = (entry, action, actor, note = "") => [...(entry?.history ?? []), { at: nowIso(), byUid: actor.uid, byName: actor.name, action, note }].slice(-60);
const view = (id, e) => ({ id, ...e, createdAt: e.createdAt?.toDate?.().toISOString() ?? null, updatedAt: e.updatedAt?.toDate?.().toISOString() ?? null });

/* ───────── Income and expenses ───────── */

/**
 * Create or edit an income/expense entry.
 * @param {Record<string, any>} input validated financeEntryInput @param {Actor} actor @param {{ canApprove: boolean, fixedId?: string }} opts
 */
export async function saveFinanceEntry(input, actor, { canApprove, fixedId }) {
  return input.id ? editEntry(input, actor, { canApprove }) : createEntry(input, actor, { canApprove, fixedId });
}

async function loadCategory(tx, categoryId, kind) {
  const snap = await tx.get(db.collection("financeCategories").doc(categoryId));
  if (!snap.exists || snap.data().kind !== kind) throw new AppError("invalid-argument", `Choose an ${kind} category.`, { fields: { categoryId: "Not found" } });
  if (snap.data().isActive === false) throw new AppError("invalid-argument", "That category is switched off.", { fields: { categoryId: "Switched off" } });
  return { id: snap.id, ...snap.data() };
}

async function createEntry(input, actor, { canApprove, fixedId }) {
  assertDate(input.date);
  const idemRef = db.collection("idempotency").doc(`finance__${actor.uid}__${input.idempotencyKey ?? fixedId}`);
  const id = fixedId ?? entries().doc().id;
  return db.runTransaction(async (tx) => {
    const [idem, existing, acc, settings, counter] = await Promise.all([tx.get(idemRef), tx.get(entries().doc(id)), readAccounting(tx), tx.get(settingsRef()), tx.get(counterRef())]);
    if (fixedId ? existing.exists : idem.exists) return { ...(fixedId ? { id, number: existing.data().number, status: existing.data().status } : idem.data().result), existing: true };
    if (!acc.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet. Create the chart of accounts first (Accounting → Chart of Accounts).");
    if (acc.config?.closedThrough && input.date <= acc.config.closedThrough) throw new AppError("failed-precondition", `The books are closed through ${acc.config.closedThrough}. Date this entry after that day, or ask the Owner to reopen the period.`, { fields: { date: "Period is closed" } });
    const cat = await loadCategory(tx, input.categoryId, input.type);
    const account = moneyAccountFor(acc.config, input.method, input.accountCode);
    const number = `FN-${String(counter.exists ? counter.data().next ?? 1 : 1).padStart(6, "0")}`;
    const threshold = settings.exists ? settings.data().approvalThreshold ?? 0 : 0;
    const pending = input.type === "expense" && !canApprove && threshold > 0 && input.amount >= threshold;
    const entry = {
      type: input.type, number, version: 1, status: pending ? "pending" : "posted", date: input.date, amount: input.amount, title: input.title, description: input.description,
      categoryId: cat.id, categoryName: cat.name, categoryAccount: categoryAccount(acc.config, cat), method: input.method, accountCode: account.code, accountName: account.name, reference: input.reference,
      vendor: { name: input.vendorName, supplierId: input.supplierId ?? null }, attachments: input.attachments, recurringId: input.recurringId ?? null,
      createdBy: actor.uid, createdByName: actor.name,
    };
    if (!pending) postOrThrow(tx, acc, specOf({ id, ...entry }, acc.config), actor.uid);
    finishAccounting(tx, acc);
    tx.set(counterRef(), { next: (counter.exists ? counter.data().next ?? 1 : 1) + 1 });
    tx.create(entries().doc(id), { ...entry, journalId: pending ? null : journalIdFor(id, 1), history: entryHistory(null, pending ? "submitted" : "created", actor, pending ? `Needs approval (${money(input.amount)})` : ""), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: `finance.${input.type}_created`, entityType: "financeEntry", entityId: id, changes: { number, amount: input.amount, date: input.date, category: cat.name, method: input.method, status: entry.status } }, tx);
    const result = { id, number, status: entry.status };
    if (!fixedId) tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

async function editEntry(input, actor, { canApprove }) {
  assertDate(input.date);
  const ref = entries().doc(input.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || !["income", "expense"].includes(snap.data().type)) throw new AppError("not-found", "That entry doesn't exist.");
    const old = snap.data();
    const nextVersion = old.version + 1;
    const [acc, settings] = await Promise.all([readAccounting(tx, { journals: [journalIdFor(input.id, old.version), reversalFor(input.id, old.version)] }), tx.get(settingsRef())]);
    if (old.version !== input.expectedVersion) throw new AppError("aborted", "Someone else changed this entry. Reload it and try again.");
    if (!["posted", "pending"].includes(old.status)) throw new AppError("failed-precondition", `A ${old.status} entry can't be edited.`);
    if (old.type !== input.type) throw new AppError("invalid-argument", "The type of an entry can't be changed. Delete it and enter a new one.");
    const cat = await loadCategory(tx, input.categoryId, input.type);
    const account = moneyAccountFor(acc.config, input.method, input.accountCode);
    const threshold = settings.exists ? settings.data().approvalThreshold ?? 0 : 0;
    if (old.status === "posted" && input.type === "expense" && !canApprove && threshold > 0 && input.amount >= threshold) throw new AppError("permission-denied", `Expenses of ${money(threshold)} or more need an approver to edit.`);
    const next = { ...old, version: nextVersion, date: input.date, amount: input.amount, title: input.title, description: input.description, categoryId: cat.id, categoryName: cat.name, categoryAccount: categoryAccount(acc.config, cat), method: input.method, accountCode: account.code, accountName: account.name, reference: input.reference, vendor: { name: input.vendorName, supplierId: input.supplierId ?? null }, attachments: input.attachments };
    if (old.status === "posted") {
      const rev = reverseInTx(tx, acc, journalIdFor(input.id, old.version), "edited", old.date, actor.uid);
      if (rev.status !== "posted") throw new AppError("failed-precondition", "The earlier posting couldn't be reversed. Nothing was changed.");
      postOrThrow(tx, acc, specOf({ id: input.id, ...next }, acc.config), actor.uid);
      finishAccounting(tx, acc);
    }
    const changed = Object.fromEntries(["date", "amount", "title", "categoryName", "method", "accountCode", "reference"].filter((k) => old[k] !== next[k]).map((k) => [k, { from: old[k], to: next[k] }]));
    tx.update(ref, { ...next, journalId: old.status === "posted" ? journalIdFor(input.id, nextVersion) : null, history: entryHistory(old, "edited", actor, Object.keys(changed).join(", ")), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: `finance.${old.type}_edited`, entityType: "financeEntry", entityId: input.id, changes: { number: old.number, version: nextVersion, changed } }, tx);
    return { id: input.id, number: old.number, status: old.status, version: nextVersion };
  });
}

/** Delete = void: the posted journal is reversed (on the entry's own date) and the record is kept as void. @param {{ id: string, reason: string }} input @param {Actor} actor @param {{ canAdjust: boolean }} opts */
export async function voidFinanceEntry({ id, reason }, actor, { canAdjust }) {
  const ref = entries().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That entry doesn't exist.");
    const e = snap.data();
    if (e.status === "void") return { id, status: "void", existing: true };
    if (e.type === "adjustment" && !canAdjust) throw new AppError("permission-denied", "Only someone who can authorise cash adjustments can delete one.");
    const acc = await readAccounting(tx, { journals: [journalIdFor(id, e.version), reversalFor(id, e.version)] });
    if (e.status === "posted") {
      const rev = reverseInTx(tx, acc, journalIdFor(id, e.version), reason, e.date, actor.uid);
      if (rev.status !== "posted") throw new AppError("failed-precondition", "The posting couldn't be reversed. Nothing was changed.");
      finishAccounting(tx, acc);
    }
    tx.update(ref, { status: "void", voidReason: reason, voidedBy: actor.uid, voidedAt: FieldValue.serverTimestamp(), reversalId: e.status === "posted" ? reversalFor(id, e.version) : null, history: entryHistory(e, "voided", actor, reason), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "finance.entry_voided", entityType: "financeEntry", entityId: id, changes: { number: e.number, type: e.type, amount: e.amount, reason } }, tx);
    return { id, status: "void", existing: false };
  });
}

/** Approve (posts the journal) or reject a waiting expense. Not by the person who entered it. @param {{ id: string, decision: "approve" | "reject", note?: string }} input @param {Actor} actor */
export async function decideExpense({ id, decision, note = "" }, actor) {
  const ref = entries().doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That expense doesn't exist.");
    const e = snap.data();
    if (e.status !== "pending") return { id, status: e.status, existing: true };
    if (e.createdBy === actor.uid) throw new AppError("permission-denied", "Someone else must approve an expense you entered.");
    const acc = await readAccounting(tx, { journals: [journalIdFor(id, e.version)] });
    if (decision === "approve") {
      assertDate(e.date);
      postOrThrow(tx, acc, specOf({ id, ...e }, acc.config), actor.uid);
      finishAccounting(tx, acc);
    }
    tx.update(ref, { status: decision === "approve" ? "posted" : "rejected", journalId: decision === "approve" ? journalIdFor(id, e.version) : null, decidedBy: actor.uid, decidedAt: FieldValue.serverTimestamp(), decisionNote: note, history: entryHistory(e, decision === "approve" ? "approved" : "rejected", actor, note), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: `finance.expense_${decision === "approve" ? "approved" : "rejected"}`, entityType: "financeEntry", entityId: id, changes: { number: e.number, amount: e.amount, note } }, tx);
    return { id, status: decision === "approve" ? "posted" : "rejected", existing: false };
  });
}

/* ───────── Transfers and cash counts ───────── */

/** Current balance of a money account (from the books). @param {Record<string, any>} config @param {string} code @param {string} [asOf] */
export async function balanceOf(config, code, asOf = today()) {
  const bal = await balancesAsOf(asOf);
  const t = bal.get(code) ?? { debit: 0, credit: 0 };
  return naturalBalance(config.accounts[code], t.debit, t.credit);
}

/** Move money between two of your own accounts. Not income, not an expense. @param {Record<string, any>} input validated transferInput @param {Actor} actor */
export async function createTransfer(input, actor) {
  assertDate(input.date);
  const cfg = (await configRef().get()).data();
  if (!cfg?.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet. Create the chart of accounts first.");
  if (cfg.closedThrough && input.date <= cfg.closedThrough) throw new AppError("failed-precondition", `The books are closed through ${cfg.closedThrough}. Date this transfer after that day, or ask the Owner to reopen the period.`, { fields: { date: "Period is closed" } });
  const all = moneyAccountsOf(cfg);
  const from = all.get(input.fromAccount);
  const to = all.get(input.toAccount);
  if (!from?.active || !to?.active) throw new AppError("invalid-argument", "Choose two active cash, bank or wallet accounts.", { fields: { toAccount: "Not a money account" } });
  const have = await balanceOf(cfg, from.code, input.date > today() ? today() : input.date);
  if (input.amount > have) throw new AppError("failed-precondition", `${from.name} only has ${money(Math.max(0, have))} at that date.`, { fields: { amount: "More than the account holds" } });
  const idemRef = db.collection("idempotency").doc(`finance__${actor.uid}__${input.idempotencyKey}`);
  const id = entries().doc().id;
  return db.runTransaction(async (tx) => {
    const [idem, acc, counter] = await Promise.all([tx.get(idemRef), readAccounting(tx), tx.get(counterRef())]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const n = counter.exists ? counter.data().next ?? 1 : 1;
    const number = `FN-${String(n).padStart(6, "0")}`;
    const title = `${from.name} → ${to.name}`;
    const entry = { type: "transfer", number, version: 1, status: "posted", date: input.date, amount: input.amount, title, description: input.note, accountCode: from.code, accountName: from.name, toAccountCode: to.code, toAccountName: to.name, reference: input.reference, categoryName: "Transfer", attachments: [], createdBy: actor.uid, createdByName: actor.name };
    postOrThrow(tx, acc, specOf({ id, ...entry }, acc.config), actor.uid);
    finishAccounting(tx, acc);
    tx.set(counterRef(), { next: n + 1 });
    tx.create(entries().doc(id), { ...entry, journalId: journalIdFor(id, 1), history: entryHistory(null, "created", actor), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "finance.transfer_created", entityType: "financeEntry", entityId: id, changes: { number, from: from.code, to: to.code, amount: input.amount, date: input.date } }, tx);
    const result = { id, number, status: "posted" };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/**
 * Reconcile an account: record what was counted (or what the bank statement says) against what the books expect.
 * A difference stays on record; it is only posted to the books by someone who may authorise adjustments.
 * @param {Record<string, any>} input validated cashCountInput @param {Actor} actor @param {{ canAdjust: boolean }} opts
 */
export async function recordCashCount(input, actor, { canAdjust }) {
  assertDate(input.date);
  if (input.adjust && !canAdjust) throw new AppError("permission-denied", "You can record a count, but only someone who may authorise cash adjustments can post the difference.");
  const cfg = (await configRef().get()).data();
  if (!cfg?.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet.");
  const acct = moneyAccountsOf(cfg).get(input.accountCode);
  if (!acct) throw new AppError("invalid-argument", "Choose a cash, bank or wallet account.", { fields: { accountCode: "Not a money account" } });
  const expected = await balanceOf(cfg, acct.code, input.date);
  const variance = input.countedAmount - expected;
  const idemRef = db.collection("idempotency").doc(`finance__${actor.uid}__${input.idempotencyKey}`);
  const countRef = db.collection("cashCounts").doc();
  const entryId = entries().doc().id;
  return db.runTransaction(async (tx) => {
    const [idem, acc, counter] = await Promise.all([tx.get(idemRef), readAccounting(tx), tx.get(counterRef())]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    let adjustmentId = null;
    if (input.adjust && variance !== 0) {
      const n = counter.exists ? counter.data().next ?? 1 : 1;
      const number = `FN-${String(n).padStart(6, "0")}`;
      const direction = variance < 0 ? "shortage" : "excess";
      const entry = { type: "adjustment", number, version: 1, status: "posted", date: input.date, amount: Math.abs(variance), direction, title: `${acct.name} ${direction} found at count`, description: input.note, accountCode: acct.code, accountName: acct.name, categoryName: "Cash adjustment", reference: "", attachments: [], createdBy: actor.uid, createdByName: actor.name };
      postOrThrow(tx, acc, specOf({ id: entryId, ...entry }, acc.config), actor.uid);
      finishAccounting(tx, acc);
      tx.set(counterRef(), { next: n + 1 });
      tx.create(entries().doc(entryId), { ...entry, journalId: journalIdFor(entryId, 1), countId: countRef.id, history: entryHistory(null, "created", actor, input.note), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      adjustmentId = entryId;
    }
    tx.create(countRef, { accountCode: acct.code, accountName: acct.name, kind: acct.kind, date: input.date, expected, counted: input.countedAmount, variance, note: input.note, status: variance === 0 ? "reconciled" : adjustmentId ? "adjusted" : "difference", adjustmentId, countedBy: actor.uid, countedByName: actor.name, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "finance.cash_count", entityType: "cashCount", entityId: countRef.id, changes: { account: acct.code, date: input.date, expected, counted: input.countedAmount, variance, adjusted: Boolean(adjustmentId) } }, tx);
    const result = { id: countRef.id, expected, counted: input.countedAmount, variance, status: variance === 0 ? "reconciled" : adjustmentId ? "adjusted" : "difference", adjustmentId };
    tx.create(idemRef, { result, createdAt: FieldValue.serverTimestamp() });
    return { ...result, existing: false };
  });
}

/* ───────── Lists ───────── */

/** @param {Record<string, any>} input validated listEntriesInput */
export async function listFinanceEntries({ type, status, from, to, accountCode, categoryId, after, limit = 50 }) {
  let q = entries().orderBy("date", "desc");
  if (type) q = entries().where("type", "==", type).orderBy("date", "desc");
  if (from) q = q.where("date", ">=", from);
  if (to) q = q.where("date", "<=", to);
  if (after) {
    const cur = await entries().doc(after).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const out = [];
  let last = null;
  let exhausted = false;
  for (let pass = 0; pass < 6 && out.length < limit && !exhausted; pass += 1) {
    const snap = await q.limit(100).get();
    exhausted = snap.size < 100;
    for (const d of snap.docs) {
      last = d;
      const e = d.data();
      if (status && e.status !== status) continue;
      if (accountCode && e.accountCode !== accountCode && e.toAccountCode !== accountCode) continue;
      if (categoryId && e.categoryId !== categoryId) continue;
      out.push(view(d.id, e));
      if (out.length >= limit) break;
    }
    if (last) q = q.startAfter(last);
  }
  return { entries: out, next: out.length >= limit || !exhausted ? out[out.length - 1]?.id ?? null : null };
}

/* ───────── Categories, settings, bank accounts ───────── */

/** @param {Record<string, any>} input validated financeCategoryInput @param {Actor} actor */
export async function saveFinanceCategory({ id, kind, name, accountCode = null }, actor) {
  const cfg = (await configRef().get()).data();
  if (accountCode) {
    const a = cfg?.accounts?.[accountCode];
    if (!a || a.isGroup || a.active === false || a.type !== (kind === "income" ? "revenue" : "expense")) throw new AppError("invalid-argument", `Choose an active ${kind === "income" ? "revenue" : "expense"} account.`, { fields: { accountCode: "Wrong account type" } });
  }
  const dup = await db.collection("financeCategories").where("kind", "==", kind).where("nameKey", "==", name.trim().toLowerCase()).limit(2).get();
  if (dup.docs.some((d) => d.id !== id)) throw new AppError("already-exists", "There is already a category with that name.", { fields: { name: "Already exists" } });
  const ref = id ? db.collection("financeCategories").doc(id) : db.collection("financeCategories").doc();
  const data = { kind, name: name.trim(), nameKey: name.trim().toLowerCase(), accountCode, role: accountCode ? null : DEFAULT_ROLE[kind], updatedAt: FieldValue.serverTimestamp() };
  if (id) {
    const cur = await ref.get();
    if (!cur.exists || cur.data().kind !== kind) throw new AppError("not-found", "That category doesn't exist.");
    await ref.update(data);
  } else await ref.create({ ...data, isActive: true, createdAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: id ? "finance.category_updated" : "finance.category_created", entityType: "financeCategory", entityId: ref.id, changes: { kind, name, accountCode } });
  return { id: ref.id };
}

/** @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setFinanceCategoryActive({ id, isActive }, actor) {
  const ref = db.collection("financeCategories").doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That category doesn't exist.");
  await ref.update({ isActive, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "finance.category_active", entityType: "financeCategory", entityId: id, changes: { isActive } });
  return { id, isActive };
}

/** Add the suggested categories that don't exist yet (never changes or removes any). @param {{ kind: "income" | "expense" }} input @param {Actor} actor */
export async function addSuggestedCategories({ kind }, actor) {
  const list = kind === "income" ? SUGGESTED_INCOME_CATEGORIES : SUGGESTED_EXPENSE_CATEGORIES;
  const have = new Set((await db.collection("financeCategories").where("kind", "==", kind).get()).docs.map((d) => d.data().nameKey));
  const created = [];
  for (const c of list) {
    if (have.has(c.name.toLowerCase())) continue;
    await db.collection("financeCategories").doc().create({ kind, name: c.name, nameKey: c.name.toLowerCase(), accountCode: null, role: c.role, isActive: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    created.push(c.name);
  }
  if (created.length) await writeAudit({ actorUid: actor.uid, action: "finance.categories_added", entityType: "financeCategory", entityId: kind, changes: { created } });
  return { created };
}

export async function listFinanceCategories() {
  const snap = await db.collection("financeCategories").get();
  return { categories: /** @type {Record<string, any>[]} */ (snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: undefined, updatedAt: undefined }))).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) };
}

export async function getFinanceSettings() {
  const s = await settingsRef().get();
  return { approvalThreshold: s.exists ? s.data().approvalThreshold ?? 0 : 0 };
}

/** @param {{ approvalThreshold: number }} input @param {Actor} actor */
export async function saveFinanceSettings({ approvalThreshold }, actor) {
  await settingsRef().set({ approvalThreshold, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: true });
  await writeAudit({ actorUid: actor.uid, action: "finance.settings_updated", entityType: "settings", entityId: "finance", changes: { approvalThreshold } });
  return { approvalThreshold };
}

/** Cash, bank and wallet accounts with their balances today (from the books). */
export async function listMoneyAccounts() {
  const cfg = (await configRef().get()).data();
  if (!cfg?.enabled) return { enabled: false, accounts: [] };
  const bal = await balancesAsOf(today());
  const accounts = [...moneyAccountsOf(cfg).values()].map((a) => ({ ...a, balance: naturalBalance(cfg.accounts[a.code], bal.get(a.code)?.debit ?? 0, bal.get(a.code)?.credit ?? 0) })).sort((a, b) => a.code.localeCompare(b.code));
  return { enabled: true, accounts };
}

/** Add a bank account: a new account under the existing bank heading in the chart of accounts (the next free code). @param {{ idempotencyKey: string, name: string }} input @param {Actor} actor */
export async function addBankAccount({ idempotencyKey, name }, actor) {
  const idemRef = db.collection("idempotency").doc(`financebank__${actor.uid}__${idempotencyKey}`);
  const prior = await idemRef.get();
  if (prior.exists) return { ...prior.data().result, existing: true };
  const cfg = (await configRef().get()).data();
  if (!cfg?.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet.");
  const parent = cfg.accounts[cfg.roles.bank]?.parent;
  if (!parent) throw new AppError("failed-precondition", "No bank heading exists in the chart of accounts.");
  if (Object.values(cfg.accounts).some((a) => a.parent === parent && String(a.name).toLowerCase() === name.trim().toLowerCase())) throw new AppError("already-exists", "A bank account with that name already exists.", { fields: { name: "Already exists" } });
  const codes = Object.entries(cfg.accounts).filter(([, a]) => a.parent === parent).map(([c]) => Number(c)).filter(Number.isFinite);
  const code = String(Math.max(Number(parent), ...codes) + 1);
  if (cfg.accounts[code]) throw new AppError("failed-precondition", "No free account code under the bank heading.");
  await saveAccount({ code, name: name.trim(), type: "asset", parentCode: parent, isGroup: false, contra: false, description: "Bank account" }, actor.uid);
  const result = { code };
  await idemRef.create({ result, createdAt: FieldValue.serverTimestamp() });
  return { ...result, existing: false };
}

/* ───────── Recurring expenses ───────── */

/** @param {Record<string, any>} input validated recurringInput @param {Actor} actor */
export async function saveRecurring(input, actor) {
  const { id, startDate, ...rest } = input;
  const ref = id ? db.collection("recurringExpenses").doc(id) : db.collection("recurringExpenses").doc();
  const cat = await db.collection("financeCategories").doc(input.categoryId).get();
  if (!cat.exists || cat.data().kind !== "expense") throw new AppError("invalid-argument", "Choose an expense category.", { fields: { categoryId: "Not found" } });
  if (id) {
    const cur = await ref.get();
    if (!cur.exists) throw new AppError("not-found", "That recurring expense doesn't exist.");
    await ref.update({ ...rest, updatedAt: FieldValue.serverTimestamp() });
  } else await ref.create({ ...rest, startDate, dayOfMonth: Number(startDate.slice(8)), nextDate: startDate, lastGenerated: null, createdBy: actor.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: id ? "finance.recurring_updated" : "finance.recurring_created", entityType: "recurringExpense", entityId: ref.id, changes: { title: input.title, amount: input.amount, frequency: input.frequency } });
  return { id: ref.id };
}

/** @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setRecurringActive({ id, isActive }, actor) {
  const ref = db.collection("recurringExpenses").doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That recurring expense doesn't exist.");
  await ref.update({ isActive, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "finance.recurring_active", entityType: "recurringExpense", entityId: id, changes: { isActive } });
  return { id, isActive };
}

export async function listRecurring() {
  const snap = await db.collection("recurringExpenses").get();
  return { recurring: snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: undefined, updatedAt: undefined })) };
}

/**
 * Create the expense entries that have fallen due (up to today). Each is keyed by recurring id + date, so running this
 * twice, or from two screens at once, creates each only once. There is no background scheduler: someone runs it.
 * @param {Actor} actor @param {{ canApprove: boolean }} opts
 */
export async function runRecurring(actor, { canApprove }) {
  const due = await db.collection("recurringExpenses").where("isActive", "==", true).where("nextDate", "<=", today()).get();
  const created = [];
  const failed = [];
  for (const d of due.docs) {
    const r = d.data();
    let next = r.nextDate;
    for (let i = 0; i < 12 && next <= today(); i += 1) {
      try {
        const res = await createEntry({ type: "expense", date: next, amount: r.amount, title: r.title, description: r.description ?? "", categoryId: r.categoryId, method: r.method, accountCode: r.accountCode ?? null, reference: "", vendorName: r.vendorName ?? "", supplierId: null, attachments: [], recurringId: d.id }, actor, { canApprove, fixedId: `rec_${d.id}_${next}` });
        if (!res.existing) created.push({ recurringId: d.id, date: next, number: res.number, status: res.status });
      } catch (e) {
        failed.push({ recurringId: d.id, date: next, message: /** @type {Error} */ (e).message });
        break;
      }
      next = nextOccurrence(r.frequency, next, r.dayOfMonth);
    }
    if (next !== r.nextDate) await d.ref.update({ nextDate: next, lastGenerated: nowIso(), updatedAt: FieldValue.serverTimestamp() });
  }
  if (created.length) await writeAudit({ actorUid: actor.uid, action: "finance.recurring_run", entityType: "recurringExpense", entityId: "run", changes: { created: created.length } });
  return { created, failed };
}

