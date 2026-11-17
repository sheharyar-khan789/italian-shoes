/**
 * Closing and reopening accounting periods.
 *
 *   accountingConfig/main.closedThrough   the last closed day (YYYY-MM-DD). Nothing may be posted dated on or before it:
 *                                         the journal writer itself refuses (accounting.js assertPeriodOpen), so a late
 *                                         automatic posting lands in Accounting → Exceptions rather than changing closed books.
 *   accountingPeriods/{id}                history: every close and reopen, who, when, why, and the trial balance at that moment
 *
 * Closing is refused until the books are fit to close: the trial balance balances, no draft journals are dated in the
 * period, and no automatic posting is waiting in Exceptions. Corrections after closing are made with a journal dated in the
 * open period (a reversal is dated today), never by editing the closed one.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey } from "../shared/accounting.js";
import { configRef } from "./accounting.js";
import { trialBalance } from "./accountingReports.js";

const today = () => pktDateKey(new Date());

/** What stands between the books and a clean close through `through`. @param {string} through */
export async function periodChecks(through) {
  const cfg = (await configRef().get()).data();
  if (!cfg?.enabled) throw new AppError("failed-precondition", "Accounting isn't set up yet.");
  const [tb, drafts, exceptions] = await Promise.all([
    trialBalance({ from: "2000-01-01", to: through }),
    db.collection("journalEntries").where("status", "==", "draft").where("dateKey", "<=", through).limit(50).get(),
    db.collection("accountingExceptions").where("status", "==", "failed").limit(50).get(),
  ]);
  const problems = [];
  if (!tb.balanced) problems.push({ code: "unbalanced", message: "The trial balance does not balance. Resolve this before closing." });
  if (!drafts.empty) problems.push({ code: "drafts", message: `${drafts.size}${drafts.size === 50 ? "+" : ""} draft journal(s) are dated on or before ${through}. Post or delete them first.` });
  if (!exceptions.empty) problems.push({ code: "exceptions", message: `${exceptions.size}${exceptions.size === 50 ? "+" : ""} automatic posting(s) failed and are waiting in Accounting → Exceptions. Retry or resolve them first.` });
  return { through, closedThrough: cfg.closedThrough ?? null, ok: problems.length === 0, problems, totals: { debit: tb.totals.debit, credit: tb.totals.credit } };
}

/**
 * @param {{ idempotencyKey: string, through: string, note?: string }} input @param {{ uid: string, name?: string }} actor
 */
export async function closePeriod({ idempotencyKey, through, note = "" }, actor) {
  const idemRef = db.collection("idempotency").doc(`periodclose__${actor.uid}__${idempotencyKey}`);
  const prior = await idemRef.get();
  if (prior.exists) return { ...prior.data().result, existing: true };
  if (through >= today()) throw new AppError("invalid-argument", "Only days that have ended can be closed. Choose yesterday or earlier.", { fields: { through: "Must be before today" } });
  const checks = await periodChecks(through);
  if (checks.closedThrough && through <= checks.closedThrough) throw new AppError("failed-precondition", `The books are already closed through ${checks.closedThrough}.`, { fields: { through: "Already closed" } });
  if (!checks.ok) throw new AppError("failed-precondition", `Not ready to close: ${checks.problems.map((p) => p.message).join(" ")}`);
  const histRef = db.collection("accountingPeriods").doc();
  const result = await db.runTransaction(async (tx) => {
    const [cfg, idem] = await Promise.all([tx.get(configRef()), tx.get(idemRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const current = cfg.data()?.closedThrough ?? null;
    if (current && through <= current) throw new AppError("failed-precondition", `The books are already closed through ${current}.`);
    tx.update(configRef(), { closedThrough: through, closedAt: FieldValue.serverTimestamp(), closedBy: actor.uid });
    tx.create(histRef, { type: "close", through, previous: current, note, totals: checks.totals, by: actor.uid, byName: actor.name ?? null, at: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "accounting.period_closed", entityType: "accountingPeriod", entityId: histRef.id, changes: { through, previous: current } }, tx);
    const out = { through, previous: current };
    tx.create(idemRef, { result: out, createdAt: FieldValue.serverTimestamp() });
    return { ...out, existing: false };
  });
  return result;
}

/**
 * Reopen: `through` = a new, earlier closed day, or null to open everything. @param {{ idempotencyKey: string, through: string | null, reason: string }} input @param {{ uid: string, name?: string }} actor
 */
export async function reopenPeriod({ idempotencyKey, through, reason }, actor) {
  const idemRef = db.collection("idempotency").doc(`periodopen__${actor.uid}__${idempotencyKey}`);
  const histRef = db.collection("accountingPeriods").doc();
  return db.runTransaction(async (tx) => {
    const [cfg, idem] = await Promise.all([tx.get(configRef()), tx.get(idemRef)]);
    if (idem.exists) return { ...idem.data().result, existing: true };
    const current = cfg.data()?.closedThrough ?? null;
    if (!current) throw new AppError("failed-precondition", "No period is closed.");
    if (through !== null && through >= current) throw new AppError("invalid-argument", `Choose a day before ${current}, or reopen everything.`, { fields: { through: "Must be earlier than the closed date" } });
    tx.update(configRef(), { closedThrough: through === null ? FieldValue.delete() : through, closedAt: FieldValue.serverTimestamp(), closedBy: actor.uid });
    tx.create(histRef, { type: "reopen", through, previous: current, note: reason, by: actor.uid, byName: actor.name ?? null, at: FieldValue.serverTimestamp() });
    writeAudit({ actorUid: actor.uid, action: "accounting.period_reopened", entityType: "accountingPeriod", entityId: histRef.id, changes: { through, previous: current, reason } }, tx);
    const out = { through, previous: current };
    tx.create(idemRef, { result: out, createdAt: FieldValue.serverTimestamp() });
    return { ...out, existing: false };
  });
}

export async function listPeriods() {
  const [cfg, snap] = await Promise.all([configRef().get(), db.collection("accountingPeriods").orderBy("at", "desc").limit(50).get()]);
  return { closedThrough: cfg.data()?.closedThrough ?? null, history: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
