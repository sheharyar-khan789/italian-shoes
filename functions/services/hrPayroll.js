/**
 * Payroll, salary advances and loans, commissions, and their posting to the existing double-entry accounting engine.
 *
 *   payrollRuns/{YYYY-MM}        the month's run: status (draft → approved → paid, or reversed back to draft), totals, journal, version
 *   payslips/{YYYY-MM__empId}    one payslip per employee: the pay terms used, attendance summary, every line, net pay, payment
 *   payrollAdjustments/{id}      one-off bonuses, allowances and deductions HR enters for a month (kept when the run is regenerated)
 *   employeeAdvances/{id}        an advance or loan: request → approval → pay-out → monthly instalments taken from pay
 *   commissionRules/{id}         percent / fixed / target rules; commission is worked out HERE from the saved sales, never typed in
 *
 * EVERY amount is calculated on the server from stored records (shared/hr.js payslipCalc); the browser sends only choices (which month, who to pay).
 * Accounting: approving a run posts ONE journal (id derived from the month and version, so it can only be posted once), paying a salary posts one
 * journal per payslip (id derived from month and employee), disbursing an advance posts one journal (id derived from the advance). A posted journal is
 * never edited: a correction is a reversal made by the accounting engine. Journals are written in the same transaction as the HR status change.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey, paymentRoleOf, DEFAULT_ACCOUNTS, ROLES } from "../shared/accounting.js";
import { daysBetween } from "../shared/finance.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { payslipCalc, accrualLines, dailyRate, shiftMinutes, workingDates, monthRange, commissionFor, installments, daysInMonth } from "../shared/hr.js";
import { readAccounting, postInTx, reverseInTx, finishAccounting, saveAccount, setRoleAccount, reversalIdOf } from "./accounting.js";
import { getHrSettings, employees, secure, plain, strip } from "./hr.js";
import { holidaySet } from "./hrAttendance.js";

/** @typedef {{ uid: string, name: string }} Actor */

const runRef = (month) => db.collection("payrollRuns").doc(month);
const slipRef = (month, employeeId) => db.collection("payslips").doc(`${month}__${employeeId}`);
const advRef = (id) => db.collection("employeeAdvances").doc(id);
const idem = (kind, uid, key) => db.collection("idempotency").doc(`${kind}__${uid}__${key}`);
const iso = (t) => t?.toDate?.().toISOString() ?? null;
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
const WEEK_DEFAULT = [1, 2, 3, 4, 5, 6];
const MAX_EMPLOYEES = 150;
const needsReference = (m) => m !== "cash";

const accrualId = (month, version) => `payroll__${month}__v${version}`;
/** One journal per payment. A salary that is paid, undone and paid again — or a payroll that is reversed and approved again — gets a NEW journal id (run version, attempt number), never an old one. */
const payId = (month, employeeId, version, n) => `salarypay__${month}__v${version}__${employeeId}__n${n}`;
const advanceJournalId = (id) => `advance__${id}`;

/* ───────── Chart of accounts for HR ───────── */

const HR_ROLE_KEYS = ["employee_advances", "salary_payable", "payroll_deductions"];

/** Which of the HR accounts are missing (an older chart of accounts was made before they existed). */
export async function hrAccountStatus() {
  const cfg = (await db.collection("accountingConfig").doc("main").get()).data();
  if (!cfg?.enabled) return { enabled: false, missing: [] };
  return { enabled: true, missing: HR_ROLE_KEYS.filter((r) => !cfg.roles?.[r] || !cfg.accounts?.[cfg.roles[r]]).map((r) => ({ role: r, label: ROLES[r].label })) };
}

/** Add the Employee advances, Salaries payable and Payroll deductions accounts to a chart made before Phase 13, and point their roles at them. Additive only. @param {Actor} actor */
export async function ensureHrAccounts(actor) {
  const st = await hrAccountStatus();
  if (!st.enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  const done = [];
  for (const { role } of st.missing) {
    const def = DEFAULT_ACCOUNTS.find((a) => a.role === role);
    if (!def) continue;
    const existing = await db.collection("accounts").doc(def.code).get();
    if (!existing.exists) await saveAccount({ code: def.code, name: def.name, type: def.type, parentCode: def.parent, isGroup: false, contra: false, description: def.description ?? "" }, actor.uid);
    else if (existing.data()?.type !== def.type || existing.data()?.isGroup) throw new AppError("failed-precondition", `Account ${def.code} already exists for something else. Create a ${def.type} account for “${ROLES[role].label}” in the Chart of Accounts and choose it there.`);
    await setRoleAccount({ role, code: def.code }, actor.uid);
    done.push(role);
  }
  if (done.length) await writeAudit({ actorUid: actor.uid, action: "hr.accounts_ready", entityType: "accounting", entityId: "hr", changes: { roles: done } });
  return { added: done };
}

/** The roles a journal needs must be set; say which one isn't. @param {Record<string, any> | null} config @param {string[]} roles */
function needRoles(config, roles) {
  const lack = roles.filter((r) => !config?.roles?.[r]);
  if (lack.length) throw new AppError("failed-precondition", `Accounting has no account set for ${lack.map((r) => `“${ROLES[r]?.label ?? r}”`).join(", ")}. Open HR → Payroll and press “Set up payroll accounts”, or choose them in the Chart of Accounts.`, { conflict: "accounts" });
}

/** Post one journal inside a transaction; an accounting problem rolls the whole HR change back instead of leaving a half-booked payroll. */
function postOrThrow(tx, acc, spec, actorUid) {
  const r = postInTx(tx, acc, spec, actorUid);
  if (r.status === "exists") throw new AppError("failed-precondition", "That accounting entry already exists. Refresh and check the payroll status.", { conflict: "journal" });
  if (r.status === "failed") throw new AppError("failed-precondition", "The accounting entry couldn't be made. Check that the salary accounts exist and are switched on, then try again.", { conflict: "accounts" });
  return r;
}

/* ───────── Commission ───────── */

/** @param {Record<string, any>} input validated saveCommissionRuleInput @param {Actor} actor */
export async function saveCommissionRule({ id, ...body }, actor) {
  const ref = id ? db.collection("commissionRules").doc(id) : db.collection("commissionRules").doc();
  if (body.scope === "employee" && !(await employees().doc(/** @type {string} */ (body.employeeId)).get()).exists) throw new AppError("invalid-argument", "That employee doesn't exist.", { fields: { employeeId: "Not found" } });
  const data = { ...body, employeeId: body.employeeId ?? null, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
  if (id) {
    if (!(await ref.get()).exists) throw new AppError("not-found", "That rule doesn't exist.");
    await ref.update(data);
  } else await ref.create({ ...data, createdAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: id ? "hr.commission_rule_updated" : "hr.commission_rule_created", entityType: "commissionRule", entityId: ref.id, changes: { name: body.name, type: body.type } });
  return { id: ref.id };
}
/** @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setCommissionRuleActive({ id, isActive }, actor) {
  const ref = db.collection("commissionRules").doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That rule doesn't exist.");
  await ref.update({ isActive, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "hr.commission_rule_toggled", entityType: "commissionRule", entityId: id, changes: { isActive } });
  return { id, isActive };
}
export async function listCommissionRules() {
  const snap = await db.collection("commissionRules").limit(100).get();
  return { rules: snap.docs.map((d) => strip(d, "createdAt", "updatedAt")).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

/** Net sales per staff sign-in for a month, from the saved POS sales (the cashier who rang them up). Refunded value is taken off. @param {string} month */
export async function salesByStaff(month) {
  const { from, to } = monthRange(month);
  const { Timestamp } = await import("firebase-admin/firestore");
  const snap = await db.collection("sales").where("createdAt", ">=", Timestamp.fromDate(new Date(`${from}T00:00:00+05:00`))).where("createdAt", "<=", Timestamp.fromDate(new Date(`${to}T23:59:59.999+05:00`))).orderBy("createdAt").limit(5001).get();
  if (snap.size > 5000) throw new AppError("failed-precondition", "That month has more than 5,000 sales; commission can't be worked out in one pass.");
  /** @type {Map<string, { net: number, sales: number }>} */
  const by = new Map();
  for (const d of snap.docs) {
    const s = d.data();
    if (!s.cashierUid || UNCOUNTED_SALE_STATUSES.includes(s.status)) continue;
    const r = by.get(s.cashierUid) ?? { net: 0, sales: 0 };
    r.net += Math.max(0, (s.netSales ?? 0) - Math.min(s.netSales ?? 0, s.refundedTotal ?? 0));
    r.sales += 1;
    by.set(s.cashierUid, r);
  }
  return by;
}

/** The commission lines one employee earns in a month from the active rules. @param {Record<string, any>} emp @param {{ net: number } | undefined} sales @param {Record<string, any>[]} rules */
export function commissionLines(emp, sales, rules) {
  const net = sales?.net ?? 0;
  return rules.filter((r) => r.isActive !== false && (r.scope === "all" || (r.scope === "employee" && r.employeeId === emp.id) || (r.scope === "designation" && r.designation === emp.designation))).map((r) => ({ name: r.name, ruleId: r.id, amount: commissionFor(/** @type {any} */ (r), net) })).filter((l) => l.amount > 0);
}

/* ───────── Advances and loans ───────── */

/** @param {Record<string, any>} input validated requestAdvanceInput @param {Actor} actor @param {Record<string, any>} emp */
export async function requestAdvance({ idempotencyKey, kind, amount, months, startMonth, reason }, actor, emp) {
  if (emp.status !== "active") throw new AppError("failed-precondition", `${emp.name} is not an active employee.`);
  if (kind === "advance" && months > 6) throw new AppError("invalid-argument", "A salary advance is recovered within 6 months. Use a loan for longer.", { fields: { months: "Too long for an advance" } });
  if (startMonth < pktDateKey(new Date()).slice(0, 7)) throw new AppError("invalid-argument", "The first deduction month can't be in the past.", { fields: { startMonth: "In the past" } });
  const res = await db.runTransaction(async (tx) => {
    const ik = idem("advreq", actor.uid, idempotencyKey);
    const k = await tx.get(ik);
    if (k.exists) return { id: k.data()?.advanceId };
    const ref = db.collection("employeeAdvances").doc();
    tx.create(ref, { employeeId: emp.id, employeeNo: emp.employeeNo, employeeName: emp.name, kind, amount, months, startMonth, reason, status: "requested", repaid: 0, requestedBy: actor.uid, requestedByName: actor.name, createdAt: FieldValue.serverTimestamp() });
    tx.create(ik, { advanceId: ref.id, at: FieldValue.serverTimestamp() });
    return { id: ref.id };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.advance_requested", entityType: "advance", entityId: res.id, changes: { kind, amount } });
  return res;
}

/** @param {{ id: string, decision: string, note?: string }} input @param {Actor} actor */
export async function decideAdvance({ id, decision, note = "" }, actor) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(advRef(id));
    if (!snap.exists) throw new AppError("not-found", "That request doesn't exist.");
    if (snap.data()?.status !== "requested") throw new AppError("failed-precondition", `That request is already ${snap.data()?.status}.`);
    tx.update(snap.ref, { status: decision === "approve" ? "approved" : "rejected", decidedBy: actor.uid, decidedByName: actor.name, decisionNote: note, decidedAt: FieldValue.serverTimestamp() });
  });
  await writeAudit({ actorUid: actor.uid, action: `hr.advance_${decision === "approve" ? "approved" : "rejected"}`, entityType: "advance", entityId: id, changes: {} });
  return { id };
}

/** Pay the money out. A second pay-out of the same advance is impossible: the status and the journal id both stop it. @param {Record<string, any>} input validated disburseAdvanceInput @param {Actor} actor */
export async function disburseAdvance({ idempotencyKey, id, method, date, reference = "" }, actor) {
  if (needsReference(method) && reference.trim().length < 3) throw new AppError("invalid-argument", "Enter the transfer reference.", { fields: { reference: "Required" } });
  if (date > pktDateKey(new Date())) throw new AppError("invalid-argument", "The payment date can't be in the future.", { fields: { date: "In the future" } });
  const res = await db.runTransaction(async (tx) => {
    const jid = advanceJournalId(id);
    const [snap, ik, acc] = await Promise.all([tx.get(advRef(id)), tx.get(idem("advpay", actor.uid, idempotencyKey)), readAccounting(tx, { journals: [jid] })]);
    if (!snap.exists) throw new AppError("not-found", "That request doesn't exist.");
    const a = snap.data() ?? {};
    if (ik.exists || a.status === "disbursed" || a.status === "closed") return { id, existing: true };
    if (a.status !== "approved") throw new AppError("failed-precondition", a.status === "requested" ? "Approve the request before paying it out." : `That request is ${a.status}.`);
    if (acc.enabled) needRoles(acc.config, ["employee_advances", paymentRoleOf(method)]);
    const schedule = installments(a.amount, a.months, a.startMonth).map((i) => ({ ...i, deducted: 0 }));
    const j = postOrThrow(tx, acc, { id: jid, sourceType: "advance", sourceId: id, dateKey: date, memo: `${a.kind === "loan" ? "Loan" : "Salary advance"} paid to ${a.employeeName}`, lines: [{ role: "employee_advances", debit: a.amount, credit: 0 }, { role: paymentRoleOf(method), debit: 0, credit: a.amount }] }, actor.uid);
    finishAccounting(tx, acc);
    tx.update(snap.ref, { status: "disbursed", schedule, repaid: 0, disbursement: { method, date, reference: reference.trim(), by: actor.uid, byName: actor.name, at: new Date().toISOString(), journal: j.status === "posted" ? { id: jid, number: j.number } : null } });
    tx.create(idem("advpay", actor.uid, idempotencyKey), { advanceId: id, at: FieldValue.serverTimestamp() });
    return { id, existing: false };
  });
  if (!res.existing) await writeAudit({ actorUid: actor.uid, action: "hr.advance_disbursed", entityType: "advance", entityId: id, changes: { method } });
  return res;
}

/** Withdraw a request that hasn't been paid out. @param {{ id: string }} input @param {Actor} actor @param {{ canManage: boolean, employeeId: string | null }} who */
export async function cancelAdvance({ id }, actor, who) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(advRef(id));
    if (!snap.exists) throw new AppError("not-found", "That request doesn't exist.");
    const a = snap.data() ?? {};
    if (!who.canManage && a.employeeId !== who.employeeId) throw new AppError("permission-denied", "That isn't your request.");
    if (!["requested", "approved"].includes(a.status)) throw new AppError("failed-precondition", `That request is already ${a.status}.`);
    tx.update(snap.ref, { status: "cancelled", cancelledBy: actor.uid, cancelledAt: FieldValue.serverTimestamp() });
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.advance_cancelled", entityType: "advance", entityId: id, changes: {} });
  return { id };
}

const advView = (d) => {
  const a = plain(d);
  return Object.assign(strip(d, "cancelledAt"), { createdAt: iso(a.createdAt), decidedAt: iso(a.decidedAt), outstanding: ["disbursed"].includes(a.status) ? a.amount - (a.repaid ?? 0) : 0 });
};
/** @param {{ status?: string, employeeId?: string, limit?: number }} input */
export async function listAdvances({ status = "all", employeeId, limit = 50 }) {
  const base = db.collection("employeeAdvances");
  const snap = await (employeeId ? base.where("employeeId", "==", employeeId) : base.orderBy("createdAt", "desc")).limit(500).get();
  const rows = snap.docs.map(advView).filter((a) => status === "all" || a.status === status).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { advances: rows.slice(0, limit), outstanding: sum(rows.filter((r) => r.status === "disbursed"), "outstanding") };
}

/* ───────── Payroll adjustments ───────── */

/** A payroll month is open for changes until its run is approved. @param {string} month */
async function assertOpen(month) {
  const r = await runRef(month).get();
  if (r.exists && ["approved", "paid"].includes(r.data()?.status)) throw new AppError("failed-precondition", `Payroll for ${month} has been approved. Reverse it first to change anything.`);
}

/** @param {Record<string, any>} input validated payrollAdjustInput @param {Actor} actor */
export async function addAdjustment({ month, employeeId, kind, name, amount, reason }, actor) {
  await assertOpen(month);
  if (month > pktDateKey(new Date()).slice(0, 7)) throw new AppError("invalid-argument", "That month hasn't started.");
  const e = await employees().doc(employeeId).get();
  if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
  const ref = db.collection("payrollAdjustments").doc();
  await ref.create({ month, employeeId, employeeName: e.data()?.name, kind, name, amount, reason, by: actor.uid, byName: actor.name, createdAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "hr.payroll_adjustment_added", entityType: "payroll", entityId: month, changes: { employeeId, kind, amount, reason } });
  return { id: ref.id };
}
/** @param {{ id: string }} input @param {Actor} actor */
export async function deleteAdjustment({ id }, actor) {
  const ref = db.collection("payrollAdjustments").doc(id);
  const s = await ref.get();
  if (!s.exists) throw new AppError("not-found", "That entry doesn't exist.");
  await assertOpen(s.data()?.month);
  await ref.delete();
  await writeAudit({ actorUid: actor.uid, action: "hr.payroll_adjustment_removed", entityType: "payroll", entityId: s.data()?.month, changes: { id } });
  return { id };
}
/** @param {{ month: string }} input */
export async function listAdjustments({ month }) {
  const snap = await db.collection("payrollAdjustments").where("month", "==", month).limit(1000).get();
  return { adjustments: snap.docs.map((d) => ({ ...plain(d), createdAt: undefined })) };
}

/* ───────── Generating a month ───────── */

/**
 * Work out a payslip for every eligible employee. Safe to repeat while the month is open: the drafts are replaced, the entered adjustments kept.
 * Someone eligible = joined by the end of the month, and either still active or left during/after it.
 * @param {{ month: string }} input @param {Actor} actor
 */
export async function generatePayroll({ month }, actor) {
  const today = pktDateKey(new Date());
  if (month > today.slice(0, 7)) throw new AppError("invalid-argument", "Payroll can't be made for a month that hasn't started.", { fields: { month: "In the future" } });
  const { from, to } = monthRange(month);
  const [settings, empSnap, shiftSnap, hol, attSnap, advSnap, adjSnap, ruleSnap, sales] = await Promise.all([
    getHrSettings(), employees().limit(1000).get(), db.collection("shifts").limit(100).get(), holidaySet(from, to), db.collection("attendance").where("month", "==", month).limit(10000).get(),
    db.collection("employeeAdvances").where("status", "==", "disbursed").limit(1000).get(), db.collection("payrollAdjustments").where("month", "==", month).limit(1000).get(), db.collection("commissionRules").where("isActive", "==", true).limit(100).get(), salesByStaff(month),
  ]);
  const eligible = empSnap.docs.map(plain).filter((e) => e.joiningDate <= to && (e.status === "active" || (e.leavingDate && e.leavingDate >= from)));
  if (eligible.length > MAX_EMPLOYEES) throw new AppError("failed-precondition", `Payroll handles up to ${MAX_EMPLOYEES} employees at a time.`);
  const secs = eligible.length ? await db.getAll(...eligible.map((e) => secure().doc(e.id))) : [];
  const secOf = new Map(secs.map((s) => [s.id, s.data()]));
  /** @type {Map<string, any>} */
  const shifts = new Map();
  for (const d of shiftSnap.docs) shifts.set(d.id, { id: d.id, ...d.data() });
  const rules = ruleSnap.docs.map(plain);
  const attBy = new Map();
  for (const d of attSnap.docs) (attBy.get(d.data().employeeId) ?? attBy.set(d.data().employeeId, []).get(d.data().employeeId)).push(d.data());
  const advBy = new Map();
  for (const d of advSnap.docs) (advBy.get(d.data().employeeId) ?? advBy.set(d.data().employeeId, []).get(d.data().employeeId)).push(plain(d));
  const adjBy = new Map();
  for (const d of adjSnap.docs) (adjBy.get(d.data().employeeId) ?? adjBy.set(d.data().employeeId, []).get(d.data().employeeId)).push(plain(d));
  const rulesCfg = { ...settings.attendance, overtime: settings.overtime };

  const slips = [];
  /** @type {{ employeeId: string, name: string, reason: string }[]} */
  const skipped = [];
  for (const emp of eligible) {
    const sec = secOf.get(emp.id);
    if (!sec?.payConfigured || !(sec.basicSalary > 0)) {
      skipped.push({ employeeId: emp.id, name: emp.name, reason: "No basic salary has been set" });
      continue;
    }
    const shift = emp.shiftId ? shifts.get(emp.shiftId) : null;
    const workingDays = shift?.workingDays ?? WEEK_DEFAULT;
    const start = emp.joiningDate > from ? emp.joiningDate : from;
    const end = emp.leavingDate && emp.leavingDate < to ? emp.leavingDate : to;
    const recs = attBy.get(emp.id) ?? [];
    const marked = new Set(recs.map((r) => r.date));
    const expected = workingDates(start, end < today ? end : today, workingDays, hol);
    const unmarked = expected.filter((d) => !marked.has(d));
    const notEmployedDays = daysInMonth(month) - daysBetween(start, end).length;
    const monthWorking = workingDates(from, to, workingDays, hol).length;
    const rate = dailyRate(sec.basicSalary, month, settings.payroll.dailyRateBasis, monthWorking);
    const adjs = adjBy.get(emp.id) ?? [];
    const due = (advBy.get(emp.id) ?? []).map((a) => ({ id: a.id, label: `${a.kind === "loan" ? "Loan" : "Advance"} instalment`, amount: (a.schedule ?? []).filter((i) => i.month <= month).reduce((n, i) => n + (i.amount - (i.deducted ?? 0)), 0) })).filter((x) => x.amount > 0);
    const comm = commissionLines(emp, sales.get(emp.staffUid ?? ""), rules);
    const calc = payslipCalc({
      month, basic: sec.basicSalary, allowances: [...(sec.allowances ?? []), ...adjs.filter((a) => a.kind === "allowance").map((a) => ({ name: a.name, amount: a.amount }))],
      bonuses: adjs.filter((a) => a.kind === "bonus").map((a) => ({ name: a.name, amount: a.amount })), commissions: comm, otherDeductions: adjs.filter((a) => a.kind === "deduction").map((a) => ({ name: a.name, amount: a.amount })), advances: due,
      attendance: { absentDays: recs.filter((r) => r.status === "absent").length + (settings.payroll.unmarked === "absent" ? unmarked.length : 0), halfDays: recs.filter((r) => r.status === "half_day").length, lateCount: recs.filter((r) => r.status === "late").length, unpaidLeaveDays: recs.filter((r) => r.status === "leave" && r.leavePaid === false).reduce((n, r) => n + (r.fraction ?? 1), 0), overtimeMinutes: sum(recs, "overtimeMinutes"), notEmployedDays },
      rules: rulesCfg, dayRate: rate, scheduledMinutes: shift ? shiftMinutes(shift) : 480,
    });
    const warnings = [];
    if (settings.payroll.unmarked === "block" && unmarked.length) warnings.push(`${unmarked.length} working day(s) have no attendance recorded`);
    if (calc.deferred > 0) warnings.push("Part of a loan or advance instalment couldn't be taken this month and stays due");
    slips.push({ emp, sec, doc: { employeeId: emp.id, employeeNo: emp.employeeNo, name: emp.name, designation: emp.designation ?? "", department: emp.department ?? "", month, terms: { basicSalary: sec.basicSalary, salaryMethod: sec.salaryMethod, payDetails: sec.payDetails ?? "", allowances: sec.allowances ?? [] }, attendance: { absentDays: recs.filter((r) => r.status === "absent").length, halfDays: recs.filter((r) => r.status === "half_day").length, lateCount: recs.filter((r) => r.status === "late").length, presentDays: recs.filter((r) => r.status === "present" || r.status === "late").length, leaveDays: recs.filter((r) => r.status === "leave").length, unpaidLeaveDays: calc.leaveDeduction ? recs.filter((r) => r.status === "leave" && r.leavePaid === false).reduce((n, r) => n + (r.fraction ?? 1), 0) : 0, overtimeMinutes: sum(recs, "overtimeMinutes"), notEmployedDays, unmarkedDays: unmarked.length }, calc, commissionLines: comm, bonusLines: adjs.filter((a) => a.kind === "bonus").map((a) => ({ name: a.name, amount: a.amount })), allowanceLines: [...(sec.allowances ?? []), ...adjs.filter((a) => a.kind === "allowance").map((a) => ({ name: a.name, amount: a.amount }))], deductionLines: adjs.filter((a) => a.kind === "deduction").map((a) => ({ name: a.name, amount: a.amount })), net: calc.net, unmarkedDays: settings.payroll.unmarked === "block" ? unmarked.length : 0, warnings, salesNet: sales.get(emp.staffUid ?? "")?.net ?? 0 } });
  }

  const totals = { basic: 0, allowances: 0, overtime: 0, bonuses: 0, commissions: 0, gross: 0, attendanceDeduction: 0, leaveDeduction: 0, advanceDeduction: 0, otherDeductions: 0, deductions: 0, net: 0 };
  for (const s of slips) for (const k of Object.keys(totals)) totals[k] += s.doc.calc[k];
  const out = await db.runTransaction(async (tx) => {
    const [run, olds] = await Promise.all([tx.get(runRef(month)), tx.get(db.collection("payslips").where("month", "==", month))]);
    const status = run.data()?.status;
    if (status && ["approved", "paid"].includes(status)) throw new AppError("failed-precondition", `Payroll for ${month} has been approved. Reverse it first to recalculate.`);
    const gen = (run.data()?.gen ?? 0) + 1;
    const keep = new Set(slips.map((s) => s.emp.id));
    olds.docs.filter((d) => !keep.has(d.data().employeeId)).forEach((d) => tx.delete(d.ref));
    for (const s of slips) tx.set(slipRef(month, s.emp.id), { ...s.doc, gen, status: "draft", payment: null, createdAt: FieldValue.serverTimestamp() });
    tx.set(runRef(month), { month, status: "draft", version: run.data()?.version ?? 1, gen, employees: slips.length, employeeIds: slips.map((s) => s.emp.id), totals, skipped, generatedBy: actor.uid, generatedByName: actor.name, generatedAt: FieldValue.serverTimestamp(), journal: null, paidCount: 0 }, { merge: false });
    return { month, employees: slips.length, totals, skipped, gen };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.payroll_generated", entityType: "payroll", entityId: month, changes: { employees: out.employees, net: totals.net } });
  return out;
}

/* ───────── Approving, paying, reversing ───────── */

/** Approve the run: lock the month, post the accrual journal, take the instalments off the advances — all in one transaction. @param {{ month: string }} input @param {Actor} actor */
export async function approvePayroll({ month }, actor) {
  const settings = await getHrSettings();
  const res = await db.runTransaction(async (tx) => {
    const run = await tx.get(runRef(month));
    if (!run.exists) throw new AppError("failed-precondition", "Generate the payroll for this month first.");
    const r = run.data() ?? {};
    if (r.status !== "draft") throw new AppError("failed-precondition", `That payroll is already ${r.status}.`);
    const ids = r.employeeIds ?? [];
    const slipSnaps = ids.length ? await tx.getAll(...ids.map((id) => slipRef(month, id))) : [];
    const slips = slipSnaps.filter((s) => s.exists).map(plain);
    if (!slips.length) throw new AppError("failed-precondition", "There are no payslips to approve.");
    if (slips.some((s) => s.gen !== r.gen || s.status !== "draft")) throw new AppError("failed-precondition", "The payslips are out of date. Generate the payroll again.");
    const unmarked = settings.payroll.unmarked === "block" ? slips.filter((s) => s.unmarkedDays > 0) : [];
    if (unmarked.length) throw new AppError("failed-precondition", `${unmarked.length} employee(s) have working days with no attendance (${unmarked.slice(0, 3).map((s) => s.name).join(", ")}${unmarked.length > 3 ? "…" : ""}). Mark or correct the attendance, then generate again.`, { conflict: "attendance" });
    const advIds = [...new Set(slips.flatMap((s) => s.calc.advances.filter((a) => a.amount > 0).map((a) => a.id)))];
    const jid = accrualId(month, r.version ?? 1);
    const [advSnaps, acc] = await Promise.all([advIds.length ? tx.getAll(...advIds.map(advRef)) : [], readAccounting(tx, { journals: [jid] })]);
    const totals = Object.fromEntries(Object.keys(r.totals).map((k) => [k, slips.reduce((n, s) => n + (s.calc[k] ?? 0), 0)]));
    if (acc.enabled) needRoles(acc.config, ["salaries", ...(totals.net > 0 ? ["salary_payable"] : []), ...(totals.advanceDeduction > 0 ? ["employee_advances"] : []), ...(totals.otherDeductions > 0 ? ["payroll_deductions"] : [])]);
    const lines = accrualLines(/** @type {any} */ (totals));
    const j = lines.length ? postOrThrow(tx, acc, { id: jid, sourceType: "payroll", sourceId: `${month}__v${r.version ?? 1}`, dateKey: monthRange(month).to, memo: `Payroll for ${month}`, lines }, actor.uid) : { status: "disabled" };
    finishAccounting(tx, acc);
    // Instalments: apply what was taken to the earliest unpaid instalments.
    advSnaps.forEach((snap) => {
      if (!snap.exists) return;
      const a = snap.data() ?? {};
      const taken = slips.flatMap((s) => s.calc.advances).filter((x) => x.id === snap.id).reduce((n, x) => n + x.amount, 0);
      let left = taken;
      const schedule = (a.schedule ?? []).map((i) => ({ ...i }));
      for (const i of schedule) {
        if (left <= 0) break;
        const room = i.amount - (i.deducted ?? 0);
        const take = Math.min(room, left);
        i.deducted = (i.deducted ?? 0) + take;
        i.status = i.deducted >= i.amount ? "deducted" : "part";
        left -= take;
      }
      const repaid = (a.repaid ?? 0) + taken;
      tx.update(snap.ref, { schedule, repaid, status: repaid >= a.amount ? "closed" : "disbursed", lastDeductedMonth: month });
    });
    slipSnaps.forEach((s) => s.exists && tx.update(s.ref, { status: "approved", approvedAt: FieldValue.serverTimestamp() }));
    tx.update(run.ref, { status: "approved", totals, approvedBy: actor.uid, approvedByName: actor.name, approvedAt: FieldValue.serverTimestamp(), journal: j.status === "posted" ? { id: jid, number: /** @type {any} */ (j).number } : { id: null, number: null, status: j.status } });
    return { month, employees: slips.length, totals, journal: j.status === "posted" ? { id: jid, number: /** @type {any} */ (j).number } : null };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.payroll_approved", entityType: "payroll", entityId: month, changes: { net: res.totals.net, journal: res.journal?.number ?? null } });
  return res;
}

/** Record salary payments. One journal per payslip (Dr Salaries payable, Cr cash / bank / wallet); repeating the request or paying twice changes nothing. @param {Record<string, any>} input validated paySalariesInput @param {Actor} actor */
export async function paySalaries({ idempotencyKey, month, employeeIds, method, date, reference = "" }, actor) {
  if (date > pktDateKey(new Date())) throw new AppError("invalid-argument", "The payment date can't be in the future.", { fields: { date: "In the future" } });
  if (date < monthRange(month).from) throw new AppError("invalid-argument", "The payment date is before that payroll month.", { fields: { date: "Too early" } });
  if (method && needsReference(method) && reference.trim().length < 3) throw new AppError("invalid-argument", "Enter the transfer reference.", { fields: { reference: "Required" } });
  const res = await db.runTransaction(async (tx) => {
    const ik = idem("salpay", actor.uid, idempotencyKey);
    const [k, run, slipSnaps] = await Promise.all([tx.get(ik), tx.get(runRef(month)), tx.getAll(...employeeIds.map((id) => slipRef(month, id)))]);
    const version = run.data()?.version ?? 1;
    const attempt = (s) => (s.data()?.voidedPayments?.length ?? 0) + 1;
    const acc = await readAccounting(tx, { journals: slipSnaps.map((s, i) => payId(month, employeeIds[i], version, attempt(s))) });
    if (k.exists) return k.data()?.result;
    if (!run.exists || !["approved", "paid"].includes(run.data()?.status)) throw new AppError("failed-precondition", "Approve the payroll before paying salaries.");
    const missing = slipSnaps.filter((s) => !s.exists).length;
    if (missing) throw new AppError("not-found", `${missing} of those people have no payslip for ${month}.`);
    /** @type {Record<string, any>[]} */
    const slips = slipSnaps.map((s) => ({ ref: s.ref, ...plain(s) }));
    const payable = slips.filter((s) => s.status === "approved");
    const skipped = slips.filter((s) => s.status === "paid").map((s) => s.employeeId);
    const methods = payable.map((s) => method ?? s.terms.salaryMethod);
    if (acc.enabled) needRoles(acc.config, ["salary_payable", ...methods.map(paymentRoleOf)]);
    let paid = 0;
    payable.forEach((s, i) => {
      const m = methods[i];
      if (needsReference(m) && !method && reference.trim().length < 3) throw new AppError("invalid-argument", `Enter the transfer reference for ${s.name}'s ${m.replace("_", " ")} payment.`, { fields: { reference: "Required" } });
      let journal = null;
      if (s.net > 0) {
        const jid = payId(month, s.employeeId, version, (s.voidedPayments?.length ?? 0) + 1);
        const j = postOrThrow(tx, acc, { id: jid, sourceType: "salarypay", sourceId: `${month}__v${version}__${s.employeeId}__n${(s.voidedPayments?.length ?? 0) + 1}`, dateKey: date, memo: `Salary for ${month} paid to ${s.name}`, lines: [{ role: "salary_payable", debit: s.net, credit: 0 }, { role: paymentRoleOf(m), debit: 0, credit: s.net }] }, actor.uid);
        journal = j.status === "posted" ? { id: jid, number: j.number } : null;
      }
      tx.update(s.ref, { status: "paid", payment: { method: m, date, reference: reference.trim(), by: actor.uid, byName: actor.name, at: new Date().toISOString(), journal } });
      paid += 1;
    });
    finishAccounting(tx, acc);
    const total = (run.data()?.paidCount ?? 0) + paid;
    tx.update(run.ref, { paidCount: total, status: total >= (run.data()?.employees ?? 0) ? "paid" : "approved" });
    const result = { month, paid, skipped, total: payable.reduce((n, s) => n + s.net, 0) };
    tx.create(ik, { result, at: FieldValue.serverTimestamp() });
    return result;
  });
  if (res.paid) await writeAudit({ actorUid: actor.uid, action: "hr.salaries_paid", entityType: "payroll", entityId: month, changes: { count: res.paid, total: res.total } });
  return res;
}

/** Undo one salary payment (a reversal journal, never an edit). @param {{ month: string, employeeId: string, reason: string }} input @param {Actor} actor */
export async function voidSalaryPayment({ month, employeeId, reason }, actor) {
  const res = await db.runTransaction(async (tx) => {
    const [slip, run] = await Promise.all([tx.get(slipRef(month, employeeId)), tx.get(runRef(month))]);
    if (!slip.exists || slip.data()?.status !== "paid") throw new AppError("failed-precondition", "That salary hasn't been paid.");
    const jid = slip.data()?.payment?.journal?.id ?? "none";
    const acc = await readAccounting(tx, { journals: [jid, reversalIdOf(jid)] });
    if (slip.data()?.payment?.journal) reverseInTx(tx, acc, jid, reason, pktDateKey(new Date()), actor.uid);
    finishAccounting(tx, acc);
    tx.update(slip.ref, { status: "approved", payment: null, voidedPayments: FieldValue.arrayUnion({ at: new Date().toISOString(), by: actor.uid, reason, was: slip.data()?.payment ?? null }) });
    tx.update(run.ref, { paidCount: Math.max(0, (run.data()?.paidCount ?? 1) - 1), status: "approved" });
    return { month, employeeId };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.salary_payment_voided", entityType: "payroll", entityId: `${month}__${employeeId}`, changes: { reason } });
  return res;
}

/** Reverse an approved payroll that hasn't been paid: the accrual journal is reversed, instalments are given back, the month reopens. @param {{ month: string, reason: string }} input @param {Actor} actor */
export async function reversePayroll({ month, reason }, actor) {
  const res = await db.runTransaction(async (tx) => {
    const run = await tx.get(runRef(month));
    if (!run.exists || run.data()?.status !== "approved") throw new AppError("failed-precondition", run.data()?.status === "paid" || (run.data()?.paidCount ?? 0) > 0 ? "Some salaries have been paid. Undo those payments first." : "Only an approved payroll can be reversed.");
    const r = run.data() ?? {};
    if ((r.paidCount ?? 0) > 0) throw new AppError("failed-precondition", "Some salaries have been paid. Undo those payments first.");
    const slipSnaps = await tx.getAll(...(r.employeeIds ?? []).map((id) => slipRef(month, id)));
    const advIds = [...new Set(slipSnaps.flatMap((s) => (s.data()?.calc?.advances ?? []).filter((a) => a.amount > 0).map((a) => a.id)))];
    const jid = accrualId(month, r.version ?? 1);
    const [advSnaps, acc] = await Promise.all([advIds.length ? tx.getAll(...advIds.map(advRef)) : [], readAccounting(tx, { journals: [jid, reversalIdOf(jid)] })]);
    if (r.journal?.id) reverseInTx(tx, acc, jid, reason, pktDateKey(new Date()), actor.uid);
    finishAccounting(tx, acc);
    advSnaps.forEach((snap) => {
      if (!snap.exists) return;
      const a = snap.data() ?? {};
      const taken = slipSnaps.flatMap((s) => s.data()?.calc?.advances ?? []).filter((x) => x.id === snap.id).reduce((n, x) => n + x.amount, 0);
      let left = taken;
      const schedule = (a.schedule ?? []).map((i) => ({ ...i }));
      for (const i of [...schedule].reverse()) {
        if (left <= 0) break;
        const back = Math.min(i.deducted ?? 0, left);
        i.deducted = (i.deducted ?? 0) - back;
        i.status = i.deducted <= 0 ? "scheduled" : "part";
        left -= back;
      }
      tx.update(snap.ref, { schedule, repaid: Math.max(0, (a.repaid ?? 0) - taken), status: "disbursed" });
    });
    slipSnaps.forEach((s) => s.exists && tx.update(s.ref, { status: "draft", gen: -1 }));
    tx.update(run.ref, { status: "draft", version: (r.version ?? 1) + 1, journal: null, reversedBy: actor.uid, reversedAt: FieldValue.serverTimestamp(), reversalReason: reason, gen: (r.gen ?? 0) + 1 });
    return { month };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.payroll_reversed", entityType: "payroll", entityId: month, changes: { reason } });
  return res;
}

/* ───────── Reading payroll ───────── */

const slipView = (s) => {
  const { createdAt, approvedAt, ...rest } = s;
  return { ...rest, createdAt: iso(createdAt), approvedAt: iso(approvedAt) };
};

/** The run and its payslips (summary rows). @param {{ month: string }} input */
export async function payrollRun({ month }) {
  const [run, slips] = await Promise.all([runRef(month).get(), db.collection("payslips").where("month", "==", month).limit(500).get()]);
  const r = run.data();
  return {
    month,
    run: r ? { ...r, generatedAt: iso(r.generatedAt), approvedAt: iso(r.approvedAt), reversedAt: iso(r.reversedAt) } : null,
    payslips: slips.docs.map(plain).map((s) => ({ employeeId: s.employeeId, employeeNo: s.employeeNo, name: s.name, designation: s.designation, status: s.status, net: s.net, gross: s.calc.gross, deductions: s.calc.deductions, method: s.terms.salaryMethod, warnings: s.warnings, unmarkedDays: s.unmarkedDays, paidOn: s.payment?.date ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
    accounts: await hrAccountStatus(),
  };
}

export async function listPayrollRuns() {
  const snap = await db.collection("payrollRuns").limit(60).get();
  return { runs: snap.docs.map((d) => ({ month: d.id, status: d.data().status, employees: d.data().employees, net: d.data().totals?.net ?? 0, paidCount: d.data().paidCount ?? 0 })).sort((a, b) => b.month.localeCompare(a.month)) };
}

/** One payslip. @param {{ month: string, employeeId: string }} input @param {{ ownOnly: boolean }} opts */
export async function payslip({ month, employeeId }, { ownOnly }) {
  const s = await slipRef(month, employeeId).get();
  if (!s.exists || (ownOnly && !["approved", "paid"].includes(s.data()?.status))) throw new AppError("not-found", "That payslip isn't available.");
  return { payslip: slipView(plain(s)) };
}

/** Own payslips (approved or paid only). @param {string} employeeId @param {number} limit */
export async function myPayslips(employeeId, limit) {
  const snap = await db.collection("payslips").where("employeeId", "==", employeeId).limit(60).get();
  return { payslips: snap.docs.map(plain).filter((s) => ["approved", "paid"].includes(s.status)).sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit).map((s) => ({ month: s.month, net: s.net, gross: s.calc.gross, deductions: s.calc.deductions, status: s.status, paidOn: s.payment?.date ?? null })) };
}
