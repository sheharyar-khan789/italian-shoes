/**
 * Bank and wallet reconciliation: matching the books to the statement.
 *
 *   bankReconState/{accountCode}   { clearedBalance, lastStatementDate, lastReconId }  where the last finished reconciliation stands
 *   bankReconciliations/{id}       one finished reconciliation: statement date and balance, the ledger lines it cleared, who and when
 *   ledgerEntries/{…}              gain reconciliationId / reconciledAt when cleared (amounts are never touched)
 *
 * The rule is the usual one: cleared balance = (previous cleared balance) + (debits − credits of the lines you tick). It must
 * equal the ending balance on the statement to the paisa before a reconciliation can be finished. Only the most recent
 * reconciliation of an account can be undone, so the history always lines up.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { configRef } from "./accounting.js";

const stateRef = (code) => db.collection("bankReconState").doc(code);

/** Bank and wallet-clearing accounts only (cash is reconciled by the register count). */
function reconcilable(cfg, code) {
  if (!cfg?.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet.");
  const a = cfg.accounts?.[code];
  if (!a || a.isGroup) throw new AppError("invalid-argument", "That account doesn't exist.", { fields: { accountCode: "Unknown account" } });
  const bankParent = cfg.accounts?.[cfg.roles?.bank]?.parent;
  const isBank = a.parent && a.parent === bankParent;
  const isWallet = code === cfg.roles?.wallet_clearing;
  if (a.type !== "asset" || (!isBank && !isWallet)) throw new AppError("invalid-argument", "Only bank and wallet accounts are reconciled with a statement.", { fields: { accountCode: "Not a bank or wallet account" } });
  return a;
}

/** The lines still to be matched for an account up to the statement date, and where the last reconciliation stands. @param {{ accountCode: string, statementDate: string }} input */
export async function reconciliationWorkspace({ accountCode, statementDate }) {
  const cfg = (await configRef().get()).data();
  const account = reconcilable(cfg, accountCode);
  const [state, snap] = await Promise.all([
    stateRef(accountCode).get(),
    db.collection("ledgerEntries").where("accountCode", "==", accountCode).where("dateKey", "<=", statementDate).orderBy("dateKey").limit(1500).get(),
  ]);
  const open = snap.docs.filter((d) => !d.data().reconciliationId);
  const shown = open.slice(0, 400);
  return {
    account: { code: accountCode, name: account.name },
    clearedBalance: state.exists ? state.data().clearedBalance : 0,
    lastStatementDate: state.exists ? state.data().lastStatementDate : null,
    entries: shown.map((d) => ({ id: d.id, dateKey: d.data().dateKey, number: d.data().number, memo: d.data().memo, debit: d.data().debit, credit: d.data().credit, sourceType: d.data().sourceType })),
    more: open.length > shown.length || snap.size === 1500,
  };
}

/**
 * @param {{ idempotencyKey: string, accountCode: string, statementDate: string, statementBalance: number, entryIds: string[], note?: string }} input
 * @param {{ uid: string, name?: string }} actor
 */
export async function finishReconciliation({ idempotencyKey, accountCode, statementDate, statementBalance, entryIds, note = "" }, actor) {
  const idemRef = db.collection("idempotency").doc(`bankrecon__${actor.uid}__${idempotencyKey}`);
  const reconRef = db.collection("bankReconciliations").doc();
  const ids = [...new Set(entryIds)];
  return db.runTransaction(async (tx) => {
    const [idem, cfgSnap, state, ...entries] = await Promise.all([tx.get(idemRef), tx.get(configRef()), tx.get(stateRef(accountCode)), ...ids.map((id) => tx.get(db.collection("ledgerEntries").doc(id)))]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const account = reconcilable(cfgSnap.data(), accountCode);
    const prev = state.exists ? state.data() : { clearedBalance: 0, lastStatementDate: null, lastReconId: null };
    if (prev.lastStatementDate && statementDate < prev.lastStatementDate) throw new AppError("failed-precondition", `This account was already reconciled to ${prev.lastStatementDate}. Use a later statement date, or undo the last reconciliation.`, { fields: { statementDate: "Earlier than the last reconciliation" } });
    let cleared = prev.clearedBalance;
    for (const e of entries) {
      if (!e.exists) throw new AppError("not-found", "A ticked line no longer exists. Reload and try again.");
      const d = e.data();
      if (d.accountCode !== accountCode) throw new AppError("invalid-argument", "A ticked line belongs to another account.");
      if (d.reconciliationId) throw new AppError("failed-precondition", "A ticked line was already reconciled. Reload and try again.");
      if (d.dateKey > statementDate) throw new AppError("invalid-argument", "A ticked line is dated after the statement date.");
      cleared += (d.debit ?? 0) - (d.credit ?? 0);
    }
    const difference = statementBalance - cleared;
    if (difference !== 0) throw new AppError("failed-precondition", `The ticked lines give ${cleared / 100} but the statement says ${statementBalance / 100}: a difference of ${difference / 100}. Tick or untick lines until the difference is zero.`, { difference });
    for (const e of entries) tx.update(e.ref, { reconciliationId: reconRef.id, reconciledAt: FieldValue.serverTimestamp() });
    tx.create(reconRef, { accountCode, accountName: account.name, statementDate, statementBalance, entryIds: ids, lines: ids.length, previousClearedBalance: prev.clearedBalance, previousStatementDate: prev.lastStatementDate, previousReconId: prev.lastReconId, status: "finished", note, by: actor.uid, byName: actor.name ?? null, at: FieldValue.serverTimestamp() });
    tx.set(stateRef(accountCode), { clearedBalance: cleared, lastStatementDate: statementDate, lastReconId: reconRef.id, updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "bank.reconciled", entityType: "bankReconciliation", entityId: reconRef.id, changes: { accountCode, statementDate, statementBalance, lines: ids.length } }, tx);
    const out = { id: reconRef.id, clearedBalance: cleared, lines: ids.length };
    tx.create(idemRef, { result: out, createdAt: FieldValue.serverTimestamp() });
    return { ...out, existing: false };
  });
}

/** Undo the most recent reconciliation of an account: its lines become unmatched again. @param {{ idempotencyKey: string, id: string, reason: string }} input @param {{ uid: string }} actor */
export async function undoReconciliation({ idempotencyKey, id, reason }, actor) {
  const idemRef = db.collection("idempotency").doc(`bankundo__${actor.uid}__${idempotencyKey}`);
  const reconRef = db.collection("bankReconciliations").doc(id);
  return db.runTransaction(async (tx) => {
    const [idem, recon] = await Promise.all([tx.get(idemRef), tx.get(reconRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    if (!recon.exists || recon.data().status !== "finished") throw new AppError("not-found", "That reconciliation doesn't exist or was already undone.");
    const r = recon.data();
    const state = await tx.get(stateRef(r.accountCode));
    if (state.data()?.lastReconId !== id) throw new AppError("failed-precondition", "Only the most recent reconciliation of an account can be undone.");
    for (const entryId of r.entryIds) tx.update(db.collection("ledgerEntries").doc(entryId), { reconciliationId: FieldValue.delete(), reconciledAt: FieldValue.delete() });
    tx.update(reconRef, { status: "undone", undoneBy: actor.uid, undoneAt: FieldValue.serverTimestamp(), undoReason: reason });
    tx.set(stateRef(r.accountCode), { clearedBalance: r.previousClearedBalance, lastStatementDate: r.previousStatementDate, lastReconId: r.previousReconId, updatedAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "bank.reconciliation_undone", entityType: "bankReconciliation", entityId: id, changes: { reason } }, tx);
    const out = { id };
    tx.create(idemRef, { result: out, createdAt: FieldValue.serverTimestamp() });
    return { ...out, existing: false };
  });
}

/** Finished and undone reconciliations of an account, newest first. @param {{ accountCode: string }} input */
export async function listReconciliations({ accountCode }) {
  const [snap, state] = await Promise.all([db.collection("bankReconciliations").where("accountCode", "==", accountCode).limit(50).get(), stateRef(accountCode).get()]);
  const rows = snap.docs.map((d) => /** @type {Record<string, any>} */ ({ id: d.id, ...d.data(), entryIds: undefined }));
  rows.sort((a, b) => (b.at?.toMillis?.() ?? 0) - (a.at?.toMillis?.() ?? 0));
  return { reconciliations: rows, state: state.exists ? state.data() : null };
}
