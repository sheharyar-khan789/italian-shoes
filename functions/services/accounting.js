/**
 * Double-entry accounting engine. The ONLY code that writes accounts, journals and ledger lines.
 *
 *   accountingConfig/main        { enabled, roles: {role → code}, accounts: {code → name, type, contra, active, isGroup, control} }
 *   accounts/{code}              one account (the code is the id, so it can't be used twice)
 *   journalEntries/{id}          a journal: number, date, memo, source, lines[], totals, status (draft | posted)
 *   ledgerEntries/{id_i}         one row per journal line (what the general ledger reads)
 *   accountMonths/{YYYY-MM}      debit/credit totals per account for the month  ┐ trial balance, profit & loss and
 *   accountDays/{YYYY-MM-DD}     the same per day                               ┘ balance sheet without scanning lines
 *   partyBalances/{type}__{id}   what one customer owes / one supplier is owed (from lines with a party)
 *   accountingExceptions/{id}    a posting that could not be made (explicit "failed" state, retried by a person)
 *
 * Rules: debits must equal credits (whole paisa); a posted journal is never edited or deleted — it is corrected
 * by a REVERSAL entry (its id is derived from the original, so it can only be made once); an automatic journal's
 * id is derived from its source (`{sourceType}__{sourceId}`), so a source can be posted only once; every
 * account must exist, be active and be an account (not a heading). All of it is checked here, on the server.
 *
 * Business events post INSIDE their own transaction (readAccounting before the first write, postInTx after),
 * so the event and its journal commit together or not at all. When accounting hasn't been set up, nothing is
 * posted and the business carries on. When it is set up but a journal can't be built (an account was switched
 * off, say) the business event still goes ahead and the failed posting is recorded in accountingExceptions
 * with everything needed to retry it — never silently dropped, never silently "fixed".
 */
import { db, FieldValue, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { DEFAULT_ACCOUNTS, ROLES, checkJournalLines, pktDateKey, monthOf, isDateKey } from "../shared/accounting.js";

export const configRef = () => db.collection("accountingConfig").doc("main");
const counterRef = () => db.collection("counters").doc("journals");
export const journalRef = (id) => db.collection("journalEntries").doc(id);
const exceptionRef = (id) => db.collection("accountingExceptions").doc(id);

export class AccountingError extends Error {}

/**
 * A closed period takes no new entries. Throws AccountingError (so an automatic posting lands in Accounting → Exceptions
 * instead of silently changing closed books). `config.closedThrough` is the last closed day, or absent.
 * @param {Record<string, any> | null | undefined} config @param {string} dateKey
 */
export function assertPeriodOpen(config, dateKey) {
  const closed = config?.closedThrough;
  if (closed && dateKey <= closed) throw new AccountingError(`The books are closed through ${closed}, so nothing can be posted dated ${dateKey}. Use a date after ${closed}, or ask the Owner to reopen the period.`);
}

/** The journal id an automatic posting uses. @param {{ id?: string, sourceType: string, sourceId: string }} spec */
export const journalIdOf = (spec) => spec.id ?? `${spec.sourceType}__${spec.sourceId}`;
export const reversalIdOf = (journalId) => `reversal__${journalId}`;

/* ───────── Reading (before the first write of a transaction) ───────── */

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {{ journals?: string[] }} [opts] journal ids the caller needs to see (to reverse them, or to check they aren't posted yet)
 */
export async function readAccounting(tx, { journals = [] } = {}) {
  const [cfg, counter, ...js] = await Promise.all([tx.get(configRef()), tx.get(counterRef()), ...journals.map((id) => tx.get(journalRef(id)))]);
  const config = cfg.exists ? cfg.data() : null;
  return {
    enabled: Boolean(config?.enabled),
    config,
    next: counter.exists ? counter.data().next ?? 1 : 1,
    touched: false,
    /** @type {Map<string, FirebaseFirestore.DocumentSnapshot>} */
    journals: new Map(js.map((s) => [s.id, s])),
  };
}

/** Write the counter once, after all postings in the transaction. */
export function finishAccounting(tx, acc) {
  if (acc.touched) tx.set(counterRef(), { next: acc.next });
}

/* ───────── Building and writing a journal ───────── */

const dateOf = (dateKey) => Timestamp.fromDate(new Date(`${dateKey}T00:00:00+05:00`));

/**
 * Validate a spec against the account index and turn roles into accounts.
 * @param {Record<string, any>} config
 * @param {{ sourceType: string, sourceId: string, dateKey: string, memo: string, lines: any[], reversalOf?: string, meta?: Record<string, any> }} spec
 */
export function buildJournal(config, spec) {
  const index = config.accounts ?? {};
  if (!isDateKey(spec.dateKey)) throw new AccountingError("The journal date isn't a valid date");
  assertPeriodOpen(config, spec.dateKey);
  const lines = spec.lines
    .filter((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0)
    .map((l) => {
      const code = l.accountCode ?? config.roles?.[l.role];
      if (!code) throw new AccountingError(`No account is set for "${ROLES[l.role]?.label ?? l.role}". Choose one in the Chart of Accounts.`);
      return { accountCode: code, debit: l.debit ?? 0, credit: l.credit ?? 0, memo: l.memo ?? "", partyType: l.partyType ?? null, partyId: l.partyId ?? null, partyName: l.partyName ?? null };
    });
  const check = checkJournalLines(lines, index);
  if (!check.ok) throw new AccountingError(check.errors.join("; "));
  return {
    dateKey: spec.dateKey,
    month: monthOf(spec.dateKey),
    memo: spec.memo,
    sourceType: spec.sourceType,
    sourceId: spec.sourceId,
    reversalOf: spec.reversalOf ?? null,
    meta: spec.meta ?? {},
    lines: lines.map((l) => ({ ...l, accountName: index[l.accountCode].name })),
    totalDebit: check.totalDebit,
    totalCredit: check.totalCredit,
  };
}

/**
 * Write a posted journal with its ledger lines, period totals and party balances. Throws AccountingError when
 * the journal is invalid. `existing`: a draft being posted (its document is updated instead of created).
 * @param {FirebaseFirestore.Transaction} tx
 */
function writePosted(tx, acc, id, spec, actorUid, { existing = null, extra = {} } = {}) {
  const built = buildJournal(acc.config, spec);
  const number = `JE-${String(acc.next).padStart(6, "0")}`;
  const index = acc.config.accounts;
  const doc = { ...built, number, status: "posted", date: dateOf(built.dateKey), costMissing: built.meta?.costMissing ?? null, postedBy: actorUid, postedAt: FieldValue.serverTimestamp(), ...extra };
  if (existing) tx.update(existing, doc);
  else tx.create(journalRef(id), { ...doc, createdBy: actorUid, createdAt: FieldValue.serverTimestamp() });

  /** @type {Record<string, { debit: any, credit: any }>} */
  const totals = {};
  built.lines.forEach((l, i) => {
    tx.create(db.collection("ledgerEntries").doc(`${id}_${i}`), {
      journalId: id,
      number,
      dateKey: built.dateKey,
      month: built.month,
      accountCode: l.accountCode,
      accountName: l.accountName,
      accountType: index[l.accountCode].type,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo || built.memo,
      partyType: l.partyType,
      partyId: l.partyId,
      sourceType: built.sourceType,
      sourceId: built.sourceId,
      createdAt: FieldValue.serverTimestamp(),
    });
    const t = (totals[l.accountCode] ??= { debit: 0, credit: 0 });
    t.debit += l.debit;
    t.credit += l.credit;
    const control = index[l.accountCode].control;
    if (l.partyType && control) {
      tx.set(
        db.collection("partyBalances").doc(`${l.partyType}__${l.partyId}`),
        { partyType: l.partyType, partyId: l.partyId, ...(l.partyName ? { name: l.partyName } : {}), debit: FieldValue.increment(l.debit), credit: FieldValue.increment(l.credit), balance: FieldValue.increment(control === "receivable" ? l.debit - l.credit : l.credit - l.debit), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
  });
  const inc = (n) => FieldValue.increment(n);
  const accounts = Object.fromEntries(Object.entries(totals).map(([code, t]) => [code, { debit: inc(t.debit), credit: inc(t.credit) }]));
  tx.set(db.collection("accountMonths").doc(built.month), { accounts, entries: inc(1) }, { merge: true });
  tx.set(db.collection("accountDays").doc(built.dateKey), { accounts, entries: inc(1) }, { merge: true });
  acc.next += 1;
  acc.touched = true;
  return { id, number, totalDebit: built.totalDebit };
}

/**
 * Post an automatic journal from inside a business transaction. Never throws for an accounting problem: if
 * accounting is off nothing happens; if the journal can't be built the failure is recorded for a person to fix.
 * The journal id comes from the source, so the same source can only be posted once.
 * @param {FirebaseFirestore.Transaction} tx
 * @param {Awaited<ReturnType<typeof readAccounting>>} acc
 * @param {Parameters<typeof buildJournal>[1] & { id?: string }} spec
 * @param {string} actorUid
 * @returns {{ status: "disabled" | "posted" | "failed" | "exists", id?: string, number?: string }}
 */
export function postInTx(tx, acc, spec, actorUid) {
  if (!acc.enabled) return { status: "disabled" };
  const id = journalIdOf(spec);
  if (acc.journals.get(id)?.exists) return { status: "exists", id };
  try {
    return { status: "posted", ...writePosted(tx, acc, id, spec, actorUid) };
  } catch (error) {
    if (!(error instanceof AccountingError)) throw error;
    tx.set(exceptionRef(id), { sourceType: spec.sourceType, sourceId: spec.sourceId, status: "failed", reason: error.message, spec: JSON.stringify(spec), createdAt: FieldValue.serverTimestamp() });
    return { status: "failed", id };
  }
}

/** Reverse a posted journal inside a transaction (the original and the would-be reversal must have been read). */
export function reverseInTx(tx, acc, originalId, reason, dateKey, actorUid) {
  if (!acc.enabled) return { status: "disabled" };
  const original = acc.journals.get(originalId);
  if (!original?.exists || original.data().status !== "posted") return { status: "nothing-to-reverse" };
  if (acc.journals.get(reversalIdOf(originalId))?.exists) return { status: "exists" };
  return postInTx(tx, acc, reversalSpec({ id: originalId, ...original.data() }, reason, dateKey), actorUid);
}

/** The opposite of a posted journal: same accounts and parties, debits and credits swapped. */
export function reversalSpec(original, reason, dateKey) {
  return {
    id: reversalIdOf(original.id),
    sourceType: "reversal",
    sourceId: original.id,
    reversalOf: original.id,
    dateKey,
    memo: `Reversal of ${original.number}: ${reason}`,
    lines: original.lines.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit, memo: l.memo ?? "", partyType: l.partyType ?? null, partyId: l.partyId ?? null, partyName: l.partyName ?? null })),
  };
}

/* ───────── Setting up the chart of accounts ───────── */

const indexEntry = (a) => ({ name: a.name, type: a.type, contra: Boolean(a.contra), isGroup: Boolean(a.isGroup), parent: a.parentCode ?? null, active: a.isActive !== false, control: a.control ?? null });

/**
 * Create the default chart of accounts and switch posting on. Only structure is created — no balances.
 * Doing it twice changes nothing.
 * @param {string} actorUid
 */
export async function initializeAccounting(actorUid) {
  return db.runTransaction(async (tx) => {
    const cfg = await tx.get(configRef());
    if (cfg.exists) return { created: false };
    const accounts = {};
    const roles = {};
    for (const a of DEFAULT_ACCOUNTS) {
      const control = a.role ? ROLES[a.role]?.control ?? null : null;
      const doc = { code: a.code, name: a.name, type: a.type, parentCode: a.parent, isGroup: Boolean(a.isGroup), contra: Boolean(a.contra), description: a.description ?? "", isActive: true, isSystem: true, role: a.role ?? null, control, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid };
      tx.create(db.collection("accounts").doc(a.code), doc);
      accounts[a.code] = indexEntry(doc);
      if (a.role) roles[a.role] = a.code;
    }
    tx.create(configRef(), { enabled: true, roles, accounts, initializedAt: FieldValue.serverTimestamp(), initializedBy: actorUid });
    writeAudit({ actorUid, action: "accounting.initialized", entityType: "accounting", entityId: "main", changes: { accounts: DEFAULT_ACCOUNTS.length } }, tx);
    return { created: true, accounts: DEFAULT_ACCOUNTS.length };
  });
}

async function loadConfig(tx) {
  const cfg = await tx.get(configRef());
  if (!cfg.exists) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  return cfg.data();
}

/**
 * Create an account, or edit an existing one's name, description and parent. Code, type and kind never change.
 * @param {Record<string, any>} input validated saveAccountInput @param {string} actorUid
 */
export async function saveAccount(input, actorUid) {
  const { code, name, type, parentCode, isGroup, contra, description } = input;
  const ref = db.collection("accounts").doc(code);
  await db.runTransaction(async (tx) => {
    const [, current, parent] = await Promise.all([loadConfig(tx), tx.get(ref), parentCode ? tx.get(db.collection("accounts").doc(parentCode)) : null]);
    if (parentCode) {
      if (!parent.exists) throw new AppError("invalid-argument", "The parent account doesn't exist.", { fields: { parentCode: "Not found" } });
      if (!parent.data().isGroup) throw new AppError("invalid-argument", "The parent must be a heading (group) account.", { fields: { parentCode: "Not a group" } });
      if (parent.data().type !== type) throw new AppError("invalid-argument", "A child account must be the same type as its parent.", { fields: { parentCode: "Different type" } });
    }
    if (parentCode === code) throw new AppError("invalid-argument", "An account can't be its own parent.", { fields: { parentCode: "Invalid" } });
    if (current.exists) {
      const c = current.data();
      if (c.type !== type || Boolean(c.isGroup) !== isGroup || Boolean(c.contra) !== contra) throw new AppError("failed-precondition", "An account's type and kind can't be changed. Create a new account instead.");
      tx.update(ref, { name, description, parentCode, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
      tx.update(configRef(), { [`accounts.${code}`]: indexEntry({ ...c, name, parentCode }) });
    } else {
      const doc = { code, name, type, parentCode, isGroup, contra, description, isActive: true, isSystem: false, role: null, control: null, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid };
      tx.create(ref, doc);
      tx.update(configRef(), { [`accounts.${code}`]: indexEntry(doc) });
    }
    writeAudit({ actorUid, action: current.exists ? "account.updated" : "account.created", entityType: "account", entityId: code, changes: { name, type } }, tx);
  });
  return { code };
}

/** Switch an account on or off. A switched-off account takes no new postings; a role's account can't be switched off. @param {{ code: string, isActive: boolean }} input @param {string} actorUid */
export async function setAccountActive({ code, isActive }, actorUid) {
  const ref = db.collection("accounts").doc(code);
  await db.runTransaction(async (tx) => {
    const [config, snap] = await Promise.all([loadConfig(tx), tx.get(ref)]);
    if (!snap.exists) throw new AppError("not-found", "That account doesn't exist.");
    if (!isActive && Object.values(config.roles).includes(code)) throw new AppError("failed-precondition", "This account is used by automatic postings. Point that job at another account first.");
    tx.update(ref, { isActive, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    tx.update(configRef(), { [`accounts.${code}.active`]: isActive });
    writeAudit({ actorUid, action: isActive ? "account.activated" : "account.deactivated", entityType: "account", entityId: code, changes: { isActive } }, tx);
  });
  return { code, isActive };
}

/** Delete an account only if nothing has ever been posted to it and nothing depends on it. @param {{ code: string }} input @param {string} actorUid */
export async function deleteAccount({ code }, actorUid) {
  const ref = db.collection("accounts").doc(code);
  const [used, children] = await Promise.all([db.collection("ledgerEntries").where("accountCode", "==", code).limit(1).get(), db.collection("accounts").where("parentCode", "==", code).limit(1).get()]);
  if (!used.empty) throw new AppError("failed-precondition", "Journals have been posted to this account, so it can't be deleted. Switch it off instead.");
  if (!children.empty) throw new AppError("failed-precondition", "This account has sub-accounts. Move or delete them first.");
  await db.runTransaction(async (tx) => {
    const [config, snap] = await Promise.all([loadConfig(tx), tx.get(ref)]);
    if (!snap.exists) throw new AppError("not-found", "That account doesn't exist.");
    if (snap.data().isSystem || Object.values(config.roles).includes(code)) throw new AppError("failed-precondition", "This is one of the standard accounts used by automatic postings, so it can't be deleted.");
    tx.delete(ref);
    tx.update(configRef(), { [`accounts.${code}`]: FieldValue.delete() });
    writeAudit({ actorUid, action: "account.deleted", entityType: "account", entityId: code, changes: { name: snap.data().name } }, tx);
  });
  return { code };
}

/** Point an automatic-posting job (for example "bank") at a different account of the right type. @param {{ role: string, code: string }} input @param {string} actorUid */
export async function setRoleAccount({ role, code }, actorUid) {
  const spec = ROLES[role];
  await db.runTransaction(async (tx) => {
    const [config, snap] = await Promise.all([loadConfig(tx), tx.get(db.collection("accounts").doc(code))]);
    if (!snap.exists) throw new AppError("not-found", "That account doesn't exist.");
    const a = snap.data();
    if (a.type !== spec.type || Boolean(a.contra) !== Boolean(spec.contra)) throw new AppError("invalid-argument", `${spec.label} needs a${spec.type === "asset" ? "n" : ""} ${spec.type}${spec.contra ? " (contra)" : ""} account.`, { fields: { code: "Wrong type" } });
    if (a.isGroup || a.isActive === false) throw new AppError("invalid-argument", "Choose an active account (not a heading).", { fields: { code: "Not usable" } });
    const previous = config.roles[role];
    tx.update(configRef(), { [`roles.${role}`]: code, ...(spec.control ? { [`accounts.${code}.control`]: spec.control } : {}) });
    if (spec.control) tx.update(snap.ref, { control: spec.control });
    if (spec.control && previous && previous !== code && !Object.entries(config.roles).some(([r, c]) => r !== role && c === previous && ROLES[r].control)) {
      tx.update(configRef(), { [`accounts.${previous}.control`]: null });
      tx.update(db.collection("accounts").doc(previous), { control: null });
    }
    writeAudit({ actorUid, action: "accounting.role_set", entityType: "accounting", entityId: role, changes: { role, from: previous ?? null, to: code } }, tx);
  });
  return { role, code };
}

/* ───────── Manual journals ───────── */

const idemRef = (actorUid, key) => db.collection("idempotency").doc(`acct__${actorUid}__${key}`);
const asAppError = (error) => (error instanceof AccountingError ? new AppError("invalid-argument", error.message, { fields: { lines: error.message } }) : error);

/**
 * Create a manual journal: a draft (nothing posted) or, with `post`, posted at once.
 * @param {Record<string, any>} input validated createJournalInput @param {string} actorUid
 */
export async function createJournal(input, actorUid) {
  const { idempotencyKey, date, memo, lines, post } = input;
  const ref = db.collection("journalEntries").doc();
  try {
    return await db.runTransaction(async (tx) => {
      const [idem, acc] = await Promise.all([tx.get(idemRef(actorUid, idempotencyKey)), readAccounting(tx)]);
      if (idem.exists) return { ...idem.data().result, existing: true };
      if (!acc.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
      const spec = { id: ref.id, sourceType: "manual", sourceId: ref.id, dateKey: date, memo, lines };
      let result;
      if (post) {
        const w = writePosted(tx, acc, ref.id, spec, actorUid);
        finishAccounting(tx, acc);
        result = { id: ref.id, number: w.number, status: "posted" };
      } else {
        for (const l of lines) if (!acc.config.accounts[l.accountCode]) throw new AppError("invalid-argument", `Account ${l.accountCode} doesn't exist.`, { fields: { lines: "Unknown account" } });
        tx.create(ref, { status: "draft", number: null, dateKey: date, month: monthOf(date), date: dateOf(date), memo, sourceType: "manual", sourceId: ref.id, lines: lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo ?? "", partyType: l.partyType ?? null, partyId: l.partyId ?? null })), totalDebit: lines.reduce((n, l) => n + l.debit, 0), totalCredit: lines.reduce((n, l) => n + l.credit, 0), createdBy: actorUid, createdAt: FieldValue.serverTimestamp() });
        result = { id: ref.id, number: null, status: "draft" };
      }
      tx.create(idemRef(actorUid, idempotencyKey), { result, createdAt: FieldValue.serverTimestamp() });
      writeAudit({ actorUid, action: post ? "journal.posted" : "journal.draft_saved", entityType: "journal", entityId: ref.id, changes: { memo } }, tx);
      return { ...result, existing: false };
    });
  } catch (error) {
    throw asAppError(error);
  }
}

/** Post a saved draft. The entry is checked again and from then on can't be changed. @param {{ id: string, idempotencyKey: string }} input @param {string} actorUid */
export async function postDraft({ id, idempotencyKey }, actorUid) {
  try {
    return await db.runTransaction(async (tx) => {
      const [idem, draft, acc] = await Promise.all([tx.get(idemRef(actorUid, idempotencyKey)), tx.get(journalRef(id)), readAccounting(tx)]);
      if (idem.exists) return { ...idem.data().result, existing: true };
      if (!draft.exists || draft.data().status !== "draft") throw new AppError("failed-precondition", draft.exists ? "This journal is already posted." : "That draft doesn't exist.");
      if (!acc.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet.");
      const d = draft.data();
      const w = writePosted(tx, acc, id, { id, sourceType: "manual", sourceId: id, dateKey: d.dateKey, memo: d.memo, lines: d.lines }, actorUid, { existing: draft.ref });
      finishAccounting(tx, acc);
      const result = { id, number: w.number, status: "posted" };
      tx.create(idemRef(actorUid, idempotencyKey), { result, createdAt: FieldValue.serverTimestamp() });
      writeAudit({ actorUid, action: "journal.posted", entityType: "journal", entityId: id, changes: { number: w.number } }, tx);
      return { ...result, existing: false };
    });
  } catch (error) {
    throw asAppError(error);
  }
}

/** Delete a DRAFT. Posted journals can never be deleted. @param {{ id: string }} input @param {string} actorUid */
export async function deleteDraft({ id }, actorUid) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(journalRef(id));
    if (!snap.exists) throw new AppError("not-found", "That draft doesn't exist.");
    if (snap.data().status !== "draft") throw new AppError("failed-precondition", "A posted journal can't be deleted. Reverse it instead.");
    tx.delete(snap.ref);
    writeAudit({ actorUid, action: "journal.draft_deleted", entityType: "journal", entityId: id, changes: {} }, tx);
  });
  return { id };
}

/**
 * Reverse a posted journal with a new opposite entry that points at it. Only once per journal; a reversal itself
 * can't be reversed (post the corrected entry instead).
 * @param {{ journalId: string, reason: string, date?: string }} input @param {string} actorUid
 */
export async function reverseJournal({ journalId, reason, date }, actorUid) {
  try {
    return await db.runTransaction(async (tx) => {
      const acc = await readAccounting(tx, { journals: [journalId, reversalIdOf(journalId)] });
      if (!acc.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet.");
      const original = acc.journals.get(journalId);
      if (!original?.exists) throw new AppError("not-found", "That journal doesn't exist.");
      const o = original.data();
      if (o.status !== "posted") throw new AppError("failed-precondition", "Only a posted journal can be reversed. Delete a draft instead.");
      if (o.reversalOf) throw new AppError("failed-precondition", "A reversal can't be reversed. Post a corrected journal instead.");
      if (acc.journals.get(reversalIdOf(journalId))?.exists) throw new AppError("failed-precondition", "This journal was already reversed.");
      const spec = reversalSpec({ id: journalId, ...o }, reason, date ?? pktDateKey(new Date()));
      const w = writePosted(tx, acc, spec.id, spec, actorUid, { extra: { reason } });
      finishAccounting(tx, acc);
      writeAudit({ actorUid, action: "journal.reversed", entityType: "journal", entityId: journalId, changes: { reversal: w.number, reason } }, tx);
      return { id: spec.id, number: w.number, reverses: o.number };
    });
  } catch (error) {
    throw asAppError(error);
  }
}

/** Try a failed automatic posting again (after the account problem was fixed). @param {{ id: string }} input @param {string} actorUid */
export async function retryException({ id }, actorUid) {
  return db.runTransaction(async (tx) => {
    const [ex, acc] = await Promise.all([tx.get(exceptionRef(id)), readAccounting(tx, { journals: [id] })]);
    if (!ex.exists || ex.data().status !== "failed") throw new AppError("not-found", "There is no failed posting with that id.");
    if (!acc.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet.");
    if (acc.journals.get(id)?.exists) {
      tx.update(ex.ref, { status: "resolved", resolvedAt: FieldValue.serverTimestamp() });
      return { status: "already-posted" };
    }
    const spec = JSON.parse(ex.data().spec);
    try {
      const w = writePosted(tx, acc, id, spec, actorUid);
      finishAccounting(tx, acc);
      tx.update(ex.ref, { status: "resolved", resolvedAt: FieldValue.serverTimestamp(), journalNumber: w.number });
      return { status: "posted", number: w.number };
    } catch (error) {
      if (!(error instanceof AccountingError)) throw error;
      throw new AppError("failed-precondition", `Still can't post: ${error.message}`);
    }
  });
}

/* ───────── Opening balances ───────── */

const OPENING_TYPES = ["asset", "liability", "equity"];

/** Check opening-balance lines without posting anything. @param {{ date: string, lines: any[] }} input */
export async function previewOpening({ date, lines }) {
  const cfg = await configRef().get();
  if (!cfg.exists) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  const index = cfg.data().accounts;
  const clean = lines.filter((l) => l.debit + l.credit > 0);
  const check = checkJournalLines(clean, index);
  const errors = check.errors.filter((e) => !/^Debits/.test(e));
  for (const [i, l] of clean.entries()) if (index[l.accountCode] && !OPENING_TYPES.includes(index[l.accountCode].type)) errors.push(`Line ${i + 1}: opening balances are for asset, liability and equity accounts only`);
  const difference = check.totalDebit - check.totalCredit;
  return { date, totalDebit: check.totalDebit, totalCredit: check.totalCredit, difference, balanced: difference === 0 && clean.length > 0, errors, valid: errors.length === 0 && difference === 0, lines: clean.map((l) => ({ ...l, accountName: index[l.accountCode]?.name ?? "?" })) };
}

/**
 * Post the opening balances as ONE identifiable journal (source type "opening"). Nothing is entered for the owner.
 * A second opening journal is refused until the first has been reversed.
 * @param {Record<string, any>} input validated openingBalanceInput @param {string} actorUid
 */
export async function postOpeningBalances({ idempotencyKey, date, memo, lines }, actorUid) {
  const preview = await previewOpening({ date, lines });
  if (!preview.valid) throw new AppError("invalid-argument", preview.errors[0] ?? `Debits (${preview.totalDebit}) don't equal credits (${preview.totalCredit}).`, { fields: { lines: preview.errors[0] ?? "Debits must equal credits" } });
  const existing = await db.collection("journalEntries").where("sourceType", "==", "opening").limit(20).get();
  for (const j of existing.docs) {
    if (j.id === `opening__${idempotencyKey}`) break;
    if (!(await journalRef(reversalIdOf(j.id)).get()).exists) throw new AppError("failed-precondition", "Opening balances were already posted. Reverse that entry first if it needs to be redone.");
  }
  const id = `opening__${idempotencyKey}`;
  try {
    return await db.runTransaction(async (tx) => {
      const acc = await readAccounting(tx, { journals: [id] });
      if (!acc.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet.");
      if (acc.journals.get(id)?.exists) return { id, number: acc.journals.get(id).data().number, existing: true };
      const w = writePosted(tx, acc, id, { id, sourceType: "opening", sourceId: idempotencyKey, dateKey: date, memo: memo || "Opening balances", lines }, actorUid);
      finishAccounting(tx, acc);
      writeAudit({ actorUid, action: "accounting.opening_posted", entityType: "journal", entityId: id, changes: { number: w.number, total: w.totalDebit } }, tx);
      return { id, number: w.number, existing: false };
    });
  } catch (error) {
    throw asAppError(error);
  }
}

/** Run a standalone posting (used by the historical backfill): reads, checks the source isn't posted, posts. */
export async function postStandalone(spec, actorUid, { extraReads = [] } = {}) {
  return db.runTransaction(async (tx) => {
    const acc = await readAccounting(tx, { journals: [journalIdOf(spec), ...extraReads] });
    const r = postInTx(tx, acc, spec, actorUid);
    finishAccounting(tx, acc);
    return r;
  });
}
