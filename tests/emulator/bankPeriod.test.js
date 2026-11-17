/**
 * Bank reconciliation and period closing against the emulators (`npm run test:emulator`). Throwaway "demo-" data only.
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
const { pktDateKey } = await import("../../functions/shared/accounting.js");

const key = () => randomUUID().replace(/-/g, "");
const day = (offset) => pktDateKey(new Date(Date.now() + offset * 86400000));
const TOKENS = {
  owner: { uid: "own-1", name: "Owner", staff: true, perms: ["*"], auth_time: 9999999999 },
  clerk: { uid: "clerk-1", name: "Clerk", staff: true, perms: ["accounting.read", "accounting.post"], auth_time: 9999999999 },
  customer: { uid: "cust-x" },
};
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
const BANK = "1021";
const journal = (date, memo, lines) => call("createJournal", "owner", { idempotencyKey: key(), date, memo, lines, post: true });
const entries = async () => (await db.collection("ledgerEntries").where("accountCode", "==", BANK).get()).docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.id.localeCompare(b.id));

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-x") await auth.createUser({ uid: t.uid }).catch(() => {});
  await accounting.initializeAccounting("seed");
  // Bank: +1,000,000 (owner capital) on day -20, +250,000 and -100,000 on day -10, +40,000 on day -3.
  for (const [d, memo, debit, credit] of [[-20, "Capital in", 1000000, 0], [-10, "Deposit", 250000, 0], [-10, "Bank fee", 0, 100000], [-3, "Late deposit", 40000, 0]]) {
    const other = credit ? [{ accountCode: "6010", debit: credit, credit: 0 }] : [{ accountCode: "3010", debit: 0, credit: debit }];
    const r = await journal(day(d), memo, [{ accountCode: BANK, debit, credit }, ...other]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

/* ───────── Bank reconciliation ───────── */

test("access: only people with accounting.reconcile can reconcile; reading needs accounting.read", async () => {
  const data = { accountCode: BANK, statementDate: day(0) };
  assert.equal((await call("reconWorkspace", null, data)).status, 401);
  assert.equal((await call("reconWorkspace", "customer", data)).status, 403);
  assert.equal((await call("reconWorkspace", "clerk", data)).status, 403, "a clerk who can post cannot reconcile");
  assert.equal((await call("closePeriod", "clerk", { idempotencyKey: key(), through: day(-5) })).status, 403, "or close periods");
  assert.equal((await call("listReconciliations", "clerk", { accountCode: BANK })).status, 200);
  assert.equal((await call("reconWorkspace", "owner", { accountCode: "6010", statementDate: day(0) })).status, 400, "an expense account is not reconcilable");
  assert.equal((await call("reconWorkspace", "owner", { accountCode: "1010", statementDate: day(0) })).status, 400, "cash is reconciled by the register count");
});

test("the workspace lists the unmatched lines up to the statement date", async () => {
  const w = await ok("reconWorkspace", "owner", { accountCode: BANK, statementDate: day(-5) });
  assert.equal(w.entries.length, 3, "the day -3 deposit is after the statement date");
  assert.deepEqual(w.entries.map((e) => e.debit - e.credit).sort((a, b) => b - a), [1000000, 250000, -100000]);
  assert.equal(w.clearedBalance, 0);
  assert.equal(w.lastStatementDate, null);
});

test("a reconciliation finishes only when the ticked lines equal the statement to the paisa", async () => {
  const w = await ok("reconWorkspace", "owner", { accountCode: BANK, statementDate: day(-5) });
  const all = w.entries.map((e) => e.id);
  const base = { accountCode: BANK, statementDate: day(-5), entryIds: all };
  const wrong = await call("finishReconciliation", "owner", { idempotencyKey: key(), ...base, statementBalance: 1150001 });
  assert.equal(wrong.status, 400);
  assert.match(JSON.stringify(wrong.body), /difference of 0\.01/);
  assert.equal((await entries()).filter((e) => e.reconciliationId).length, 0, "a refused attempt marks nothing");
  const partial = await call("finishReconciliation", "owner", { idempotencyKey: key(), ...base, entryIds: all.slice(0, 2), statementBalance: 1150000 });
  assert.equal(partial.status, 400, "a missing line makes it unbalanced");
  const done = await ok("finishReconciliation", "owner", { idempotencyKey: key(), ...base, statementBalance: 1150000 });
  assert.equal(done.clearedBalance, 1150000);
  assert.equal(done.lines, 3);
  const marked = (await entries()).filter((e) => e.reconciliationId === done.id);
  assert.equal(marked.length, 3);
  assert.equal(marked.reduce((n, e) => n + e.debit - e.credit, 0), 1150000, "amounts untouched");
  const state = (await db.doc(`bankReconState/${BANK}`).get()).data();
  assert.equal(state.clearedBalance, 1150000);
  assert.equal(state.lastStatementDate, day(-5));
});

test("the same request twice does nothing more; a cleared line cannot be cleared again; the next statement continues from the last", async () => {
  const w = await ok("reconWorkspace", "owner", { accountCode: BANK, statementDate: day(0) });
  assert.equal(w.entries.length, 1, "only the late deposit is left");
  assert.equal(w.clearedBalance, 1150000);
  const body = { idempotencyKey: key(), accountCode: BANK, statementDate: day(0), statementBalance: 1190000, entryIds: w.entries.map((e) => e.id) };
  const first = await ok("finishReconciliation", "owner", body);
  const again = await ok("finishReconciliation", "owner", body);
  assert.equal(again.existing, true);
  assert.equal(again.id, first.id);
  assert.equal((await db.collection("bankReconciliations").where("accountCode", "==", BANK).get()).size, 2);
  const reuse = await call("finishReconciliation", "owner", { ...body, idempotencyKey: key(), statementBalance: 1190000 });
  assert.equal(reuse.status, 400, "already reconciled");
  const early = await call("finishReconciliation", "owner", { idempotencyKey: key(), accountCode: BANK, statementDate: day(-9), statementBalance: 0, entryIds: ["x_0"] });
  assert.equal(early.status >= 400, true);
});

test("only the latest reconciliation can be undone; undoing frees its lines and restores the balance", async () => {
  const list = await ok("listReconciliations", "owner", { accountCode: BANK });
  const finished = list.reconciliations.filter((r) => r.status === "finished");
  assert.equal(finished.length, 2);
  const [latest, older] = finished;
  const notLatest = await call("undoReconciliation", "owner", { idempotencyKey: key(), id: older.id, reason: "Wrong statement" });
  assert.equal(notLatest.status, 400);
  await ok("undoReconciliation", "owner", { idempotencyKey: key(), id: latest.id, reason: "Wrong statement" });
  assert.equal((await entries()).filter((e) => e.reconciliationId).length, 3, "the late deposit is free again");
  const state = (await db.doc(`bankReconState/${BANK}`).get()).data();
  assert.equal(state.clearedBalance, 1150000);
  assert.equal(state.lastReconId, older.id);
  const w = await ok("reconWorkspace", "owner", { accountCode: BANK, statementDate: day(0) });
  assert.equal(w.entries.length, 1);
  assert.equal((await call("undoReconciliation", "owner", { idempotencyKey: key(), id: latest.id, reason: "again please" })).status, 404, "already undone");
});

/* ───────── Period closing ───────── */

test("closing is refused for today, while there are drafts, or while an automatic posting has failed", async () => {
  assert.equal((await call("closePeriod", "owner", { idempotencyKey: key(), through: day(0) })).status, 400, "today hasn't ended");
  const draft = await ok("createJournal", "owner", { idempotencyKey: key(), date: day(-6), memo: "Unfinished", lines: [{ accountCode: "6010", debit: 100, credit: 0 }, { accountCode: BANK, debit: 0, credit: 100 }], post: false });
  const blocked = await call("closePeriod", "owner", { idempotencyKey: key(), through: day(-5) });
  assert.equal(blocked.status, 400);
  assert.match(JSON.stringify(blocked.body), /draft journal/);
  await ok("deleteDraftJournal", "owner", { id: draft.id });
  await db.collection("accountingExceptions").doc("sale__x").set({ status: "failed", sourceType: "sale", sourceId: "x", reason: "test" });
  const stuck = await call("closePeriod", "owner", { idempotencyKey: key(), through: day(-5) });
  assert.equal(stuck.status, 400);
  assert.match(JSON.stringify(stuck.body), /automatic posting/);
  await db.doc("accountingExceptions/sale__x").delete();
  const checks = await ok("periodChecks", "owner", { through: day(-5) });
  assert.equal(checks.ok, true);
  assert.equal(checks.totals.debit, checks.totals.credit);
});

test("a closed period takes no new entries — manual journals and even automatic postings are refused", async () => {
  const through = day(-5);
  const closed = await ok("closePeriod", "owner", { idempotencyKey: key(), through, note: "Month end" });
  assert.equal(closed.through, through);
  assert.equal((await db.doc("accountingConfig/main").get()).data().closedThrough, through);
  assert.equal((await ok("listPeriods", "clerk", {})).closedThrough, through);

  const manual = await journal(day(-6), "Late entry", [{ accountCode: "6010", debit: 500, credit: 0 }, { accountCode: BANK, debit: 0, credit: 500 }]);
  assert.equal(manual.status, 400);
  assert.match(JSON.stringify(manual.body), /closed through/);
  const onTheDay = await journal(through, "On the last closed day", [{ accountCode: "6010", debit: 500, credit: 0 }, { accountCode: BANK, debit: 0, credit: 500 }]);
  assert.equal(onTheDay.status, 400, "the closing day itself is closed");
  const open = await journal(day(-4), "First open day", [{ accountCode: "6010", debit: 500, credit: 0 }, { accountCode: BANK, debit: 0, credit: 500 }]);
  assert.equal(open.status, 200, JSON.stringify(open.body));

  // The books themselves refuse, so an automatic posting cannot change closed history: it becomes an exception.
  const acc = await db.runTransaction(async (tx) => {
    const a = await accounting.readAccounting(tx);
    const r = accounting.postInTx(tx, a, { sourceType: "sale", sourceId: "late-sale", dateKey: day(-8), memo: "Late", lines: [{ role: "cash", debit: 100 }, { role: "sales_revenue", credit: 100 }] }, "system");
    accounting.finishAccounting(tx, a);
    return r;
  });
  assert.equal(acc.status, "failed");
  assert.equal((await db.doc("accountingExceptions/sale__late-sale").get()).exists, true);
  assert.equal((await db.doc("journalEntries/sale__late-sale").get()).exists, false, "nothing was posted into the closed period");
  await db.doc("accountingExceptions/sale__late-sale").delete();

  assert.equal((await call("closePeriod", "owner", { idempotencyKey: key(), through: day(-6) })).status, 400, "can't close an earlier day than the closed one");
  const again = await call("closePeriod", "owner", { idempotencyKey: key(), through });
  assert.equal(again.status, 400, "already closed");
});

test("a reversal made today is allowed (it is dated in the open period); reopening needs a reason and is recorded", async () => {
  const j = (await db.collection("journalEntries").where("memo", "==", "First open day").get()).docs[0];
  const rev = await call("reverseJournal", "owner", { journalId: j.id, reason: "Entered twice" });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal((await call("reopenPeriod", "clerk", { idempotencyKey: key(), through: null, reason: "Need to fix something" })).status, 403);
  assert.equal((await call("reopenPeriod", "owner", { idempotencyKey: key(), through: null, reason: "x" })).status, 400, "a real reason is required");
  assert.equal((await call("reopenPeriod", "owner", { idempotencyKey: key(), through: day(-5), reason: "Not earlier than closed" })).status, 400);
  const reopened = await ok("reopenPeriod", "owner", { idempotencyKey: key(), through: null, reason: "Correct a supplier invoice" });
  assert.equal(reopened.previous, day(-5));
  assert.equal((await db.doc("accountingConfig/main").get()).data().closedThrough, undefined);
  const late = await journal(day(-6), "Now allowed", [{ accountCode: "6010", debit: 700, credit: 0 }, { accountCode: BANK, debit: 0, credit: 700 }]);
  assert.equal(late.status, 200);
  const history = (await ok("listPeriods", "owner", {})).history;
  assert.deepEqual(history.map((h) => h.type).sort(), ["close", "reopen"]);
  assert.ok((await db.collection("auditLogs").where("action", "==", "accounting.period_reopened").get()).size >= 1);
  assert.ok((await db.collection("auditLogs").where("action", "==", "accounting.period_closed").get()).size >= 1);
});
