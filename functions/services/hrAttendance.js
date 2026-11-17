/**
 * Shifts, holidays, daily attendance and leave.
 *
 *   shifts/{id}                    name, start / end, break, grace, working weekdays
 *   holidays/{YYYY-MM-DD}          one holiday per date (the date is the id)
 *   attendance/{employeeId__date}  ONE record per employee per day: the id makes a duplicate impossible, not just unlikely
 *   leaveRequests/{id}             an application and its decision;  leaveBalances/{employeeId__year}: adjustments and days used
 *
 * Every time is "HH:MM" and every date a YYYY-MM-DD key in Pakistan time (the business time zone). A month whose payroll is APPROVED or PAID is
 * locked: attendance and leave in it can't be changed until that payroll is reversed. Attendance corrections keep the old values, who changed
 * them and why, on the record itself and in the audit log.
 */
import { FieldPath } from "firebase-admin/firestore";
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey } from "../shared/accounting.js";
import { daysBetween } from "../shared/finance.js";
import { attendanceMetrics, finalStatus, workingDates, monthRange, timeToMin, ATTENDANCE_STATUS } from "../shared/hr.js";
import { getHrSettings, employees, employeeForUid, plain, strip } from "./hr.js";

/** @typedef {{ uid: string, name: string }} Actor */

const att = () => db.collection("attendance");
const iso = (t) => t?.toDate?.().toISOString() ?? null;
const attId = (employeeId, date) => `${employeeId}__${date}`;
const WEEK_ALL = [0, 1, 2, 3, 4, 5, 6];

/* ───────── Shifts and holidays ───────── */

/** @param {Record<string, any>} input validated saveShiftInput @param {Actor} actor */
export async function saveShift({ id, name, start, end, breakMinutes, graceMinutes, workingDays, isActive }, actor) {
  if (timeToMin(start) === timeToMin(end)) throw new AppError("invalid-argument", "The shift can't start and end at the same time.", { fields: { end: "Same as start" } });
  const ref = id ? db.collection("shifts").doc(id) : db.collection("shifts").doc();
  const body = { name, start, end, breakMinutes, graceMinutes, workingDays: [...workingDays].sort(), isActive, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
  if (id) {
    if (!(await ref.get()).exists) throw new AppError("not-found", "That shift doesn't exist.");
    await ref.update(body);
  } else await ref.create({ ...body, createdAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: id ? "hr.shift_updated" : "hr.shift_created", entityType: "shift", entityId: ref.id, changes: { name } });
  return { id: ref.id };
}

export async function listShifts() {
  const snap = await db.collection("shifts").limit(100).get();
  const staff = await employees().where("status", "==", "active").limit(1000).get();
  const counts = new Map();
  for (const e of staff.docs) if (e.data().shiftId) counts.set(e.data().shiftId, (counts.get(e.data().shiftId) ?? 0) + 1);
  return { shifts: snap.docs.map((d) => Object.assign(strip(d, "createdAt", "updatedAt"), { employees: counts.get(d.id) ?? 0 })).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

/** Put employees on a shift (or take them off one). @param {{ employeeIds: string[], shiftId: string | null }} input @param {Actor} actor */
export async function assignShift({ employeeIds, shiftId }, actor) {
  if (shiftId) {
    const s = await db.collection("shifts").doc(shiftId).get();
    if (!s.exists || s.data()?.isActive === false) throw new AppError("invalid-argument", "That shift doesn't exist or is switched off.");
  }
  const snaps = await db.getAll(...employeeIds.map((id) => employees().doc(id)));
  const missing = snaps.filter((s) => !s.exists).length;
  if (missing) throw new AppError("not-found", `${missing} of those employees don't exist.`);
  const batch = db.batch();
  for (const s of snaps) {
    batch.update(s.ref, { shiftId, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    batch.create(db.collection("employeeHistory").doc(), { employeeId: s.id, kind: "shift", summary: shiftId ? "Shift assigned" : "Shift removed", restricted: null, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  await writeAudit({ actorUid: actor.uid, action: "hr.shift_assigned", entityType: "shift", entityId: shiftId ?? "none", changes: { employees: employeeIds.length } });
  return { assigned: employeeIds.length };
}

/** @param {{ date: string, name: string }} input @param {Actor} actor */
export async function saveHoliday({ date, name }, actor) {
  await db.collection("holidays").doc(date).set({ date, name, updatedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "hr.holiday_saved", entityType: "holiday", entityId: date, changes: { name } });
  return { date };
}
/** @param {{ date: string }} input @param {Actor} actor */
export async function deleteHoliday({ date }, actor) {
  await db.collection("holidays").doc(date).delete();
  await writeAudit({ actorUid: actor.uid, action: "hr.holiday_deleted", entityType: "holiday", entityId: date, changes: {} });
  return { date };
}
/** @param {{ year: number }} input */
export async function listHolidays({ year }) {
  const snap = await db.collection("holidays").where(FieldPath.documentId(), ">=", `${year}-01-01`).where(FieldPath.documentId(), "<=", `${year}-12-31`).get();
  return { holidays: snap.docs.map((d) => ({ date: d.id, name: d.data().name })).sort((a, b) => a.date.localeCompare(b.date)) };
}
/** The holiday dates in a range, as a Set. @param {string} from @param {string} to */
export async function holidaySet(from, to) {
  const snap = await db.collection("holidays").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", to).get();
  return new Set(snap.docs.map((d) => d.id));
}

/* ───────── Locks ───────── */

/** A month with an approved or paid payroll is locked. @param {FirebaseFirestore.Transaction | null} tx @param {string} month */
async function lockedMonth(tx, month) {
  const ref = db.collection("payrollRuns").doc(month);
  const s = await (tx ? tx.get(ref) : ref.get());
  return s.exists && ["approved", "paid"].includes(s.data()?.status);
}
const lockMessage = (month) => `Payroll for ${month} has been approved, so its attendance and leave are locked. Reverse the payroll first if something has to change.`;

/* ───────── Attendance ───────── */

/**
 * Work out one day's record from what was entered, the employee's shift and the settings. Pure of the database (everything is passed in).
 * @param {Record<string, any>} emp @param {Record<string, any> | null} shift @param {Record<string, any>} input @param {Record<string, any>} settings
 */
function buildRecord(emp, shift, input, settings) {
  const timed = ["present", "late", "half_day"].includes(input.status);
  const checkIn = timed ? (input.checkIn ?? "") : "";
  const checkOut = timed ? (input.checkOut ?? "") : "";
  if (checkOut && !checkIn) throw new AppError("invalid-argument", "Enter the arrival time as well as the departure time.", { fields: { checkIn: "Required" } });
  const m = shift ? attendanceMetrics(/** @type {any} */ (shift), { checkIn, checkOut }, { overtimeMinMinutes: settings.overtime.minMinutes }) : { workedMinutes: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0 };
  if (!shift && checkIn && checkOut) {
    const a = timeToMin(checkIn);
    let b = timeToMin(checkOut);
    if (b < a) b += 1440;
    m.workedMinutes = b - a;
  }
  return { status: finalStatus(input.status, m.lateMinutes), checkIn, checkOut, ...m };
}

/** Why attendance can't be recorded for this employee and date, or "". @param {Record<string, any>} emp @param {string} date */
function notAllowed(emp, date) {
  if (date > pktDateKey(new Date())) return "That date is in the future.";
  if (date < emp.joiningDate) return `${emp.name} joined on ${emp.joiningDate}.`;
  if (emp.status !== "active" && (!emp.leavingDate || date > emp.leavingDate)) return `${emp.name} is not an active employee on that date.`;
  return "";
}

const shiftSnapshot = (s) => (s ? { id: s.id, name: s.name, start: s.start, end: s.end, breakMinutes: s.breakMinutes ?? 0, graceMinutes: s.graceMinutes ?? 0, workingDays: s.workingDays } : null);

/** @param {Record<string, any>} emp @param {Record<string, any> | null} shift @param {Record<string, any>} r @param {string} date @param {Actor} actor @param {string} source */
const recordDoc = (emp, shift, r, date, input, actor, source) => ({ employeeId: emp.id, employeeNo: emp.employeeNo, employeeName: emp.name, date, month: date.slice(0, 7), ...r, shift: shiftSnapshot(shift), leaveId: null, leaveType: null, leavePaid: null, fraction: 1, note: input.note ?? "", source, corrections: [], markedBy: actor.uid, markedByName: actor.name, markedAt: FieldValue.serverTimestamp() });

/** Mark one employee's attendance for a day. A second record for the same day is refused: use a correction. @param {Record<string, any>} input validated markAttendanceInput @param {Actor} actor */
export async function markAttendance(input, actor) {
  const settings = await getHrSettings();
  const out = await db.runTransaction(async (tx) => {
    const empSnap = await tx.get(employees().doc(input.employeeId));
    if (!empSnap.exists) throw new AppError("not-found", "That employee doesn't exist.");
    const emp = plain(empSnap);
    const [shiftSnap, existing, locked] = await Promise.all([emp.shiftId ? tx.get(db.collection("shifts").doc(emp.shiftId)) : null, tx.get(att().doc(attId(emp.id, input.date))), lockedMonth(tx, input.date.slice(0, 7))]);
    const why = notAllowed(emp, input.date);
    if (why) throw new AppError("failed-precondition", why);
    if (locked) throw new AppError("failed-precondition", lockMessage(input.date.slice(0, 7)));
    if (existing.exists) throw new AppError("already-exists", `Attendance for ${emp.name} on ${input.date} is already marked (${ATTENDANCE_STATUS[existing.data()?.status] ?? existing.data()?.status}). Use a correction to change it.`, { existing: existing.data()?.status });
    const shift = shiftSnap?.exists ? { id: shiftSnap.id, ...shiftSnap.data() } : null;
    const r = buildRecord(emp, shift, input, settings);
    tx.create(att().doc(attId(emp.id, input.date)), recordDoc(emp, shift, r, input.date, input, actor, "manual"));
    return { employeeId: emp.id, date: input.date, status: r.status, lateMinutes: r.lateMinutes, overtimeMinutes: r.overtimeMinutes };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.attendance_marked", entityType: "attendance", entityId: attId(out.employeeId, out.date), changes: { status: out.status } });
  return out;
}

/**
 * Mark many employees for one day in a single transaction. Employees who already have a record for the day are skipped and reported, never overwritten.
 * @param {{ date: string, entries: { employeeId: string, status: string, checkIn?: string, checkOut?: string }[] }} input @param {Actor} actor
 */
export async function bulkMarkAttendance({ date, entries }, actor) {
  const settings = await getHrSettings();
  const out = await db.runTransaction(async (tx) => {
    const locked = await lockedMonth(tx, date.slice(0, 7));
    if (locked) throw new AppError("failed-precondition", lockMessage(date.slice(0, 7)));
    const empSnaps = await tx.getAll(...entries.map((e) => employees().doc(e.employeeId)));
    const emps = empSnaps.filter((s) => s.exists).map(plain);
    const shiftIds = [...new Set(emps.map((e) => e.shiftId).filter(Boolean))];
    const [shiftSnaps, existing] = await Promise.all([shiftIds.length ? tx.getAll(...shiftIds.map((id) => db.collection("shifts").doc(id))) : [], tx.getAll(...entries.map((e) => att().doc(attId(e.employeeId, date))))]);
    const shifts = new Map(shiftSnaps.filter((s) => s.exists).map((s) => [s.id, { id: s.id, ...s.data() }]));
    const byEmp = new Map(emps.map((e) => [e.id, e]));
    /** @type {{ employeeId: string, reason: string }[]} */
    const skipped = [];
    let created = 0;
    entries.forEach((e, i) => {
      const emp = byEmp.get(e.employeeId);
      if (!emp) return void skipped.push({ employeeId: e.employeeId, reason: "Not found" });
      if (existing[i].exists) return void skipped.push({ employeeId: e.employeeId, reason: `Already marked (${ATTENDANCE_STATUS[existing[i].data()?.status] ?? existing[i].data()?.status})` });
      const why = notAllowed(emp, date);
      if (why) return void skipped.push({ employeeId: e.employeeId, reason: why });
      const shift = emp.shiftId ? (shifts.get(emp.shiftId) ?? null) : null;
      let r;
      try {
        r = buildRecord(emp, shift, e, settings);
      } catch (err) {
        return void skipped.push({ employeeId: e.employeeId, reason: /** @type {Error} */ (err).message });
      }
      tx.create(att().doc(attId(emp.id, date)), recordDoc(emp, shift, r, date, e, actor, "bulk"));
      created += 1;
    });
    return { created, skipped };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.attendance_bulk", entityType: "attendance", entityId: date, changes: { created: out.created, skipped: out.skipped.length } });
  return out;
}

/** Change an existing record. The old values, the reason and who changed it stay on the record and in the audit log. @param {Record<string, any>} input validated correctAttendanceInput @param {Actor} actor */
export async function correctAttendance(input, actor) {
  const settings = await getHrSettings();
  const out = await db.runTransaction(async (tx) => {
    const ref = att().doc(attId(input.employeeId, input.date));
    const empSnap = await tx.get(employees().doc(input.employeeId));
    if (!empSnap.exists) throw new AppError("not-found", "That employee doesn't exist.");
    const emp = plain(empSnap);
    const [cur, locked] = await Promise.all([tx.get(ref), lockedMonth(tx, input.date.slice(0, 7))]);
    if (!cur.exists) throw new AppError("not-found", "There is no attendance record for that day to correct. Mark it instead.");
    if (locked) throw new AppError("failed-precondition", lockMessage(input.date.slice(0, 7)));
    const before = cur.data() ?? {};
    if (before.leaveId) throw new AppError("failed-precondition", "That day is on approved leave. Cancel or change the leave request instead.");
    const shift = before.shift ?? null;
    const r = buildRecord(emp, shift, input, settings);
    const correction = { at: new Date().toISOString(), by: actor.uid, byName: actor.name, reason: input.reason, before: { status: before.status, checkIn: before.checkIn, checkOut: before.checkOut }, after: { status: r.status, checkIn: r.checkIn, checkOut: r.checkOut } };
    tx.update(ref, { ...r, source: "corrected", corrections: [...(before.corrections ?? []), correction], correctedAt: FieldValue.serverTimestamp(), correctedBy: actor.uid });
    return { employeeId: emp.id, date: input.date, from: before.status, to: r.status };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.attendance_corrected", entityType: "attendance", entityId: attId(out.employeeId, out.date), changes: { from: out.from, to: out.to, reason: input.reason } });
  return out;
}

/** The totals of a set of attendance records. @param {Record<string, any>[]} rows */
export function summarize(rows) {
  const t = { present: 0, late: 0, half_day: 0, absent: 0, leave: 0, weekly_off: 0, holiday: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, workedMinutes: 0 };
  for (const r of rows) {
    t[r.status] = (t[r.status] ?? 0) + 1;
    t.lateMinutes += r.lateMinutes ?? 0;
    t.earlyMinutes += r.earlyMinutes ?? 0;
    t.overtimeMinutes += r.overtimeMinutes ?? 0;
    t.workedMinutes += r.workedMinutes ?? 0;
  }
  return t;
}

const view = (d) => {
  const { markedAt, correctedAt, ...rest } = d;
  return { ...rest, markedAt: iso(markedAt), correctedAt: iso(correctedAt) };
};

/** Everyone who should have attendance on a day, with their record (or none yet) and what the shift and holiday list expect. @param {{ date: string }} input */
export async function attendanceDay({ date }) {
  const [empSnap, attSnap, hol, shiftSnap] = await Promise.all([employees().limit(1000).get(), att().where("date", "==", date).get(), db.collection("holidays").doc(date).get(), db.collection("shifts").limit(100).get()]);
  const records = new Map(attSnap.docs.map((d) => [d.data().employeeId, view(d.data())]));
  const shifts = new Map(shiftSnap.docs.map((d) => [d.id, d.data()]));
  const rows = empSnap.docs.map(plain).filter((e) => e.joiningDate <= date && (e.status === "active" || (e.leavingDate && e.leavingDate >= date))).sort((a, b) => a.nameLower.localeCompare(b.nameLower)).map((e) => {
    const shift = e.shiftId ? shifts.get(e.shiftId) : null;
    const working = (shift?.workingDays ?? WEEK_ALL.filter((d) => d !== 0)).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    return { employeeId: e.id, employeeNo: e.employeeNo, name: e.name, designation: e.designation ?? "", department: e.department ?? "", shift: shift ? { name: shift.name, start: shift.start, end: shift.end } : null, expected: hol.exists ? "holiday" : working ? "working" : "weekly_off", record: records.get(e.id) ?? null };
  });
  return { date, holiday: hol.exists ? hol.data()?.name : null, rows, summary: summarize([...records.values()]), locked: await lockedMonth(null, date.slice(0, 7)) };
}

/** One employee's month: every record, the totals, and the days the shift expects work on (for the calendar). @param {{ employeeId: string, month: string }} input */
export async function employeeMonth({ employeeId, month }) {
  const { from, to } = monthRange(month);
  const [e, snap, hol] = await Promise.all([employees().doc(employeeId).get(), att().where("employeeId", "==", employeeId).where("month", "==", month).get(), holidaySet(from, to)]);
  if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
  const emp = plain(e);
  const shift = emp.shiftId ? (await db.collection("shifts").doc(emp.shiftId).get()).data() : null;
  const rows = snap.docs.map((d) => view(d.data())).sort((a, b) => a.date.localeCompare(b.date));
  const days = daysBetween(from, to).map((date) => {
    const r = rows.find((x) => x.date === date);
    const working = (shift?.workingDays ?? WEEK_ALL.filter((d) => d !== 0)).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    return { date, expected: hol.has(date) ? "holiday" : working ? "working" : "weekly_off", record: r ?? null };
  });
  return { employee: { id: emp.id, name: emp.name, employeeNo: emp.employeeNo }, month, days, summary: summarize(rows), locked: await lockedMonth(null, month) };
}

/** Every employee's totals for a month. @param {{ month: string }} input */
export async function monthlyAttendance({ month }) {
  const [snap, emps] = await Promise.all([att().where("month", "==", month).limit(10000).get(), employees().limit(1000).get()]);
  const by = new Map();
  for (const d of snap.docs) (by.get(d.data().employeeId) ?? by.set(d.data().employeeId, []).get(d.data().employeeId)).push(d.data());
  return { month, rows: emps.docs.map(plain).filter((e) => by.has(e.id) || e.status === "active").map((e) => ({ employeeId: e.id, employeeNo: e.employeeNo, name: e.name, ...summarize(by.get(e.id) ?? []) })).sort((a, b) => a.name.localeCompare(b.name)) };
}

/* ───────── Leave ───────── */

const balRef = (employeeId, year) => db.collection("leaveBalances").doc(`${employeeId}__${year}`);
const idem = (kind, uid, key) => db.collection("idempotency").doc(`${kind}__${uid}__${key}`);

/** Days per calendar year for a list of dates. @param {string[]} dates */
const byYear = (dates) => dates.reduce((m, d) => ({ ...m, [d.slice(0, 4)]: (m[d.slice(0, 4)] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}));

/** Remaining days of one leave type this year. Unpaid leave with no allowance is unlimited. @param {Record<string, any>} settings @param {Record<string, any> | undefined} bal @param {string} type */
function remaining(settings, bal, type) {
  const lt = settings.leaveTypes.find((l) => l.key === type);
  if (!lt) return null;
  if (!lt.paid && lt.days === 0) return Infinity;
  return lt.days + (bal?.adjustments?.[type] ?? 0) - (bal?.used?.[type] ?? 0);
}

/** An employee's leave balances for a year (allowance, adjustments, used, pending, remaining). @param {{ employeeId?: string, year: number }} input @param {string} defaultEmployeeId */
export async function leaveBalance({ employeeId, year }, defaultEmployeeId) {
  const id = employeeId ?? defaultEmployeeId;
  const [settings, bal, pending] = await Promise.all([getHrSettings(), balRef(id, year).get(), db.collection("leaveRequests").where("employeeId", "==", id).where("status", "==", "pending").get()]);
  const b = bal.data();
  const pend = {};
  for (const p of pending.docs) pend[p.data().type] = (pend[p.data().type] ?? 0) + (p.data().daysByYear?.[year] ?? 0);
  return { employeeId: id, year, balances: settings.leaveTypes.map((lt) => ({ type: lt.key, name: lt.name, paid: lt.paid, allowance: lt.days, adjustments: b?.adjustments?.[lt.key] ?? 0, used: b?.used?.[lt.key] ?? 0, pending: pend[lt.key] ?? 0, remaining: remaining(settings, b, lt.key) === Infinity ? null : (remaining(settings, b, lt.key) ?? 0) - (pend[lt.key] ?? 0), unlimited: !lt.paid && lt.days === 0 })) };
}

/**
 * Apply for leave. Working days only count (weekly offs and holidays inside the range don't use up leave). Refused when the dates overlap another
 * request, fall in a locked payroll month, or the balance isn't enough.
 * @param {Record<string, any>} input validated applyLeaveInput @param {Actor} actor @param {Record<string, any>} emp the employee the leave is for
 */
export async function applyLeave(input, actor, emp) {
  const settings = await getHrSettings();
  const lt = settings.leaveTypes.find((l) => l.key === input.type);
  if (!lt) throw new AppError("invalid-argument", "That isn't one of your leave types.", { fields: { type: "Unknown" } });
  if (input.from < emp.joiningDate) throw new AppError("invalid-argument", `${emp.name} joined on ${emp.joiningDate}.`, { fields: { from: "Before joining" } });
  const shift = emp.shiftId ? (await db.collection("shifts").doc(emp.shiftId).get()).data() : null;
  const hol = await holidaySet(input.from, input.to);
  const dates = workingDates(input.from, input.to, shift?.workingDays ?? WEEK_ALL.filter((d) => d !== 0), hol);
  if (!dates.length) throw new AppError("invalid-argument", "There are no working days in that range (weekly offs and holidays don't need leave).", { fields: { from: "No working days" } });
  const days = input.halfDay ? 0.5 : dates.length;
  const perYear = input.halfDay ? { [dates[0].slice(0, 4)]: 0.5 } : byYear(dates);
  const done = await db.runTransaction(async (tx) => {
    const ik = idem("leave", actor.uid, input.idempotencyKey);
    const [k, others, bals, ...locks] = await Promise.all([tx.get(ik), tx.get(db.collection("leaveRequests").where("employeeId", "==", emp.id).where("status", "in", ["pending", "approved"])), Promise.all(Object.keys(perYear).map((y) => tx.get(balRef(emp.id, y)))), ...[...new Set(dates.map((d) => d.slice(0, 7)))].map((m) => lockedMonth(tx, m))]);
    if (k.exists) return { id: k.data()?.requestId, existing: true };
    if (locks.some(Boolean)) throw new AppError("failed-precondition", "Payroll for part of that period has already been approved, so leave can't be added to it.");
    const clash = others.docs.find((o) => o.data().from <= input.to && o.data().to >= input.from);
    if (clash) throw new AppError("already-exists", `That overlaps another leave request (${clash.data().from} to ${clash.data().to}, ${clash.data().status}).`, { fields: { from: "Overlaps another request" } });
    Object.entries(perYear).forEach(([y, n], i) => {
      const left = remaining(settings, bals[i].data(), input.type);
      const pending = others.docs.filter((o) => o.data().type === input.type && o.data().status === "pending").reduce((s, o) => s + (o.data().daysByYear?.[y] ?? 0), 0);
      if (left !== Infinity && (left ?? 0) - pending < n) throw new AppError("failed-precondition", `Not enough ${lt.name.toLowerCase()} left for ${y}: ${Math.max(0, (left ?? 0) - pending)} day(s) available, ${n} asked for.`, { fields: { type: "Not enough balance" } });
    });
    const ref = db.collection("leaveRequests").doc();
    tx.create(ref, { employeeId: emp.id, employeeNo: emp.employeeNo, employeeName: emp.name, type: input.type, typeName: lt.name, paid: lt.paid, from: input.from, to: input.to, halfDay: input.halfDay, days, daysByYear: perYear, reason: input.reason, status: "pending", appliedBy: actor.uid, appliedByName: actor.name, createdAt: FieldValue.serverTimestamp() });
    tx.create(ik, { requestId: ref.id, at: FieldValue.serverTimestamp() });
    return { id: ref.id, existing: false };
  });
  if (!done.existing) await writeAudit({ actorUid: actor.uid, action: "hr.leave_applied", entityType: "leave", entityId: done.id, changes: { type: input.type, days } });
  return { id: done.id, days };
}

/** Approve or reject. Approval re-checks the balance and clashes, then fills the attendance days as leave and uses up the balance — together or not at all. @param {{ id: string, decision: string, note?: string }} input @param {Actor} actor */
export async function decideLeave({ id, decision, note = "" }, actor) {
  const settings = await getHrSettings();
  const res = await db.runTransaction(async (tx) => {
    const ref = db.collection("leaveRequests").doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That leave request doesn't exist.");
    const r = snap.data() ?? {};
    if (r.status !== "pending") throw new AppError("failed-precondition", `That request is already ${r.status}.`);
    if (decision === "reject") {
      tx.update(ref, { status: "rejected", decidedBy: actor.uid, decidedByName: actor.name, decisionNote: note, decidedAt: FieldValue.serverTimestamp() });
      return { id, status: "rejected" };
    }
    const emp = plain(await tx.get(employees().doc(r.employeeId)));
    const shift = emp.shiftId ? (await tx.get(db.collection("shifts").doc(emp.shiftId))).data() : null;
    const hol = await holidaySet(r.from, r.to);
    const dates = workingDates(r.from, r.to, shift?.workingDays ?? WEEK_ALL.filter((d) => d !== 0), hol);
    const perYear = r.halfDay ? { [dates[0]?.slice(0, 4) ?? r.from.slice(0, 4)]: 0.5 } : byYear(dates);
    const [existing, bals, others, ...locks] = await Promise.all([dates.length ? tx.getAll(...dates.map((d) => att().doc(attId(r.employeeId, d)))) : [], Promise.all(Object.keys(perYear).map((y) => tx.get(balRef(r.employeeId, y)))), tx.get(db.collection("leaveRequests").where("employeeId", "==", r.employeeId).where("status", "==", "approved")), ...[...new Set(dates.map((d) => d.slice(0, 7)))].map((m) => lockedMonth(tx, m))]);
    if (locks.some(Boolean)) throw new AppError("failed-precondition", "Payroll for part of that period has already been approved, so this leave can't be approved.");
    if (others.docs.some((o) => o.id !== id && o.data().from <= r.to && o.data().to >= r.from)) throw new AppError("already-exists", "That overlaps leave that is already approved.");
    const conflicts = existing.filter((s) => s.exists && s.data()?.status !== "absent");
    if (conflicts.length) throw new AppError("failed-precondition", `Attendance is already recorded on ${conflicts.map((s) => s.data()?.date).join(", ")}. Correct it before approving this leave.`);
    Object.entries(perYear).forEach(([y, n], i) => {
      const left = remaining(settings, bals[i].data(), r.type);
      if (left !== Infinity && (left ?? 0) < n) throw new AppError("failed-precondition", `Not enough ${r.typeName.toLowerCase()} left for ${y}.`);
    });
    dates.forEach((d, i) => {
      const rec = { employeeId: emp.id, employeeNo: emp.employeeNo, employeeName: emp.name, date: d, month: d.slice(0, 7), status: "leave", checkIn: "", checkOut: "", workedMinutes: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, shift: shiftSnapshot(shift ? { id: emp.shiftId, ...shift } : null), leaveId: id, leaveType: r.type, leavePaid: r.paid, fraction: r.halfDay ? 0.5 : 1, note: `${r.typeName}`, source: "leave", corrections: existing[i].exists ? [{ at: new Date().toISOString(), by: actor.uid, byName: actor.name, reason: "Approved leave replaced an absence", before: { status: "absent" }, after: { status: "leave" } }] : [], markedBy: actor.uid, markedByName: actor.name, markedAt: FieldValue.serverTimestamp() };
      if (existing[i].exists) tx.set(existing[i].ref, rec);
      else tx.create(att().doc(attId(r.employeeId, d)), rec);
    });
    Object.entries(perYear).forEach(([y, n]) => tx.set(balRef(r.employeeId, y), { employeeId: r.employeeId, year: Number(y), used: { [r.type]: FieldValue.increment(n) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
    tx.update(ref, { status: "approved", decidedBy: actor.uid, decidedByName: actor.name, decisionNote: note, decidedAt: FieldValue.serverTimestamp(), dates });
    return { id, status: "approved", dates: dates.length };
  });
  await writeAudit({ actorUid: actor.uid, action: decision === "approve" ? "hr.leave_approved" : "hr.leave_rejected", entityType: "leave", entityId: id, changes: { note } });
  return res;
}

/** Withdraw a request. A pending one can always be withdrawn; an approved one only while it is still in the future (the days and the balance are given back). @param {{ id: string }} input @param {Actor} actor @param {{ canManage: boolean, employeeId: string | null }} who */
export async function cancelLeave({ id }, actor, who) {
  const res = await db.runTransaction(async (tx) => {
    const ref = db.collection("leaveRequests").doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That leave request doesn't exist.");
    const r = snap.data() ?? {};
    if (!who.canManage && r.employeeId !== who.employeeId) throw new AppError("permission-denied", "That isn't your leave request.");
    if (!["pending", "approved"].includes(r.status)) throw new AppError("failed-precondition", `That request is already ${r.status}.`);
    if (r.status === "approved") {
      if (r.from <= pktDateKey(new Date())) throw new AppError("failed-precondition", "Leave that has already started can't be cancelled. Correct the attendance days instead.");
      const dates = r.dates ?? [];
      const locks = await Promise.all([...new Set(dates.map((d) => d.slice(0, 7)))].map((m) => lockedMonth(tx, m)));
      if (locks.some(Boolean)) throw new AppError("failed-precondition", "Payroll for part of that period has been approved.");
      dates.forEach((d) => tx.delete(att().doc(attId(r.employeeId, d))));
      Object.entries(r.daysByYear ?? {}).forEach(([y, n]) => tx.set(balRef(r.employeeId, y), { used: { [r.type]: FieldValue.increment(-n) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
    }
    tx.update(ref, { status: "cancelled", cancelledBy: actor.uid, cancelledAt: FieldValue.serverTimestamp() });
    return { id, status: "cancelled" };
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.leave_cancelled", entityType: "leave", entityId: id, changes: {} });
  return res;
}

/** Add or take away days of a leave type for one employee and year. Needs a reason; recorded in the audit log. Repeating the request changes nothing. @param {Record<string, any>} input validated adjustLeaveInput @param {Actor} actor */
export async function adjustLeave({ idempotencyKey, employeeId, year, type, days, reason }, actor) {
  const settings = await getHrSettings();
  if (!settings.leaveTypes.some((l) => l.key === type)) throw new AppError("invalid-argument", "That isn't one of your leave types.");
  const res = await db.runTransaction(async (tx) => {
    const ik = idem("leaveadj", actor.uid, idempotencyKey);
    const [k, e] = await Promise.all([tx.get(ik), tx.get(employees().doc(employeeId))]);
    if (k.exists) return { existing: true };
    if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
    tx.set(balRef(employeeId, year), { employeeId, year, adjustments: { [type]: FieldValue.increment(days) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(ik, { at: FieldValue.serverTimestamp() });
    tx.create(db.collection("employeeHistory").doc(), { employeeId, kind: "leave", summary: `Leave balance adjusted: ${days > 0 ? "+" : ""}${days} ${type} for ${year}. ${reason}`, restricted: null, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    return { existing: false };
  });
  if (!res.existing) await writeAudit({ actorUid: actor.uid, action: "hr.leave_adjusted", entityType: "employee", entityId: employeeId, changes: { type, year, days, reason } });
  return { ok: true };
}

/** Leave requests, newest first. @param {{ status?: string, employeeId?: string, limit?: number }} input */
export async function listLeave({ status = "all", employeeId, limit = 50 }) {
  let q = db.collection("leaveRequests").orderBy("createdAt", "desc");
  if (employeeId) q = db.collection("leaveRequests").where("employeeId", "==", employeeId).orderBy("createdAt", "desc");
  const snap = await q.limit(employeeId || status !== "all" ? 500 : limit).get();
  const rows = snap.docs.map((d) => Object.assign(strip(d, "cancelledAt"), { createdAt: iso(d.data().createdAt), decidedAt: iso(d.data().decidedAt) })).filter((r) => status === "all" || r.status === status);
  return { requests: rows.slice(0, limit) };
}

/** Approved and pending leave touching a month, for the calendar. @param {{ month: string }} input */
export async function leaveCalendar({ month }) {
  const { from, to } = monthRange(month);
  const snap = await db.collection("leaveRequests").where("status", "in", ["pending", "approved"]).limit(1000).get();
  const rows = snap.docs.map(plain).filter((r) => r.from <= to && r.to >= from);
  return { month, leave: rows.map((r) => ({ id: r.id, employeeId: r.employeeId, name: r.employeeName, type: r.typeName, status: r.status, from: r.from, to: r.to, days: r.days, halfDay: r.halfDay })) };
}

/** The employee record of the signed-in person, or a clear error. @param {string} uid */
export async function requireOwnEmployee(uid) {
  const e = await employeeForUid(uid);
  if (!e) throw new AppError("not-found", "Your sign-in isn't linked to an employee record yet. Ask HR to link it.");
  return e;
}
