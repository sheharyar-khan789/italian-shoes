/**
 * HR, attendance, leave and payroll: configuration defaults and the PURE rules (server and browser). Nothing here reads a database.
 * Money is integer paisa. Dates are YYYY-MM-DD keys in Pakistan time (the business time zone used everywhere in this system); times of day are "HH:MM".
 *
 * Nothing about the organisation is fixed: departments, designations, employment types, leave types, shifts and holidays are the owner's own
 * (HR_DEFAULTS are only the starting values shown before the first save, and departments / designations start EMPTY).
 */
import { addDays, daysBetween } from "./finance.js";

export const HR_DEFAULTS = {
  departments: /** @type {string[]} */ ([]),
  designations: /** @type {string[]} */ ([]),
  employmentTypes: ["Full-time", "Part-time", "Contract", "Probation"],
  /** Leave types. `paid: false` leave is deducted from salary. `days` is the yearly allowance (0 = no balance kept, e.g. unpaid). */
  leaveTypes: [
    { key: "annual", name: "Annual leave", days: 14, paid: true },
    { key: "sick", name: "Sick leave", days: 8, paid: true },
    { key: "casual", name: "Casual leave", days: 10, paid: true },
    { key: "unpaid", name: "Unpaid leave", days: 0, paid: false },
  ],
  attendance: { halfDayDeductDays: 0.5, absentDeductDays: 1, lateEvery: 0, lateDeductDays: 0.5 },
  overtime: { enabled: true, multiplier: 1.5, minMinutes: 30 },
  payroll: { dailyRateBasis: /** @type {"30" | "calendar" | "working"} */ ("30") },
};

export const ATTENDANCE_STATUS = { present: "Present", absent: "Absent", late: "Late", half_day: "Half-day", leave: "On leave", weekly_off: "Weekly off", holiday: "Holiday" };
/** Statuses a person enters by hand (leave, weekly off and holiday are normally filled from approved leave, the shift and the holiday list). */
export const MANUAL_STATUSES = ["present", "absent", "late", "half_day", "leave", "weekly_off", "holiday"];
export const EMPLOYEE_STATUS = { active: "Active", inactive: "Inactive", terminated: "Left the company" };
export const SALARY_METHODS = ["cash", "bank_transfer", "jazzcash", "easypaisa"];
export const LEAVE_STATUS = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
export const ADVANCE_STATUS = { requested: "Requested", approved: "Approved", rejected: "Rejected", disbursed: "Paid out", closed: "Fully repaid", cancelled: "Cancelled" };
export const PAYROLL_STATUS = { draft: "Draft", approved: "Approved", paid: "Paid", reversed: "Reversed" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ───────── Dates and times ───────── */

/** 0 = Sunday … 6 = Saturday, for a date key. @param {string} dateKey */
export const weekdayOf = (dateKey) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();
/** "09:30" → 570. NaN when it isn't a valid time. @param {string} t */
export function timeToMin(t) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}
/** 570 → "09:30". @param {number} n */
export const minToTime = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export const isMonthKey = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s ?? "");
/** First and last date of a month. @param {string} month YYYY-MM */
export function monthRange(month) {
  const from = `${month}-01`;
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}
export const daysInMonth = (month) => Number(monthRange(month).to.slice(8));

/**
 * The days in [from, to] an employee is expected to work: not a weekly off and not a holiday.
 * @param {string} from @param {string} to @param {number[]} workingDays weekday numbers (0 = Sunday) @param {Set<string> | string[]} holidays
 */
export function workingDates(from, to, workingDays, holidays = []) {
  const h = holidays instanceof Set ? holidays : new Set(holidays);
  return daysBetween(from, to).filter((d) => workingDays.includes(weekdayOf(d)) && !h.has(d));
}

/** Days a leave request uses: working days only (weekly offs and holidays inside the range don't count), 0.5 for a half day. */
export function leaveDays({ from, to, halfDay = false }, workingDays, holidays = []) {
  const n = workingDates(from, to, workingDays, holidays).length;
  return halfDay ? (n > 0 ? 0.5 : 0) : n;
}

/* ───────── Shifts and attendance ───────── */

/** Scheduled working minutes of a shift (an end earlier than the start means the shift runs past midnight). @param {{ start: string, end: string, breakMinutes?: number }} s */
export function shiftMinutes(s) {
  const a = timeToMin(s.start);
  let b = timeToMin(s.end);
  if (b <= a) b += 1440;
  return Math.max(0, b - a - (s.breakMinutes ?? 0));
}

/**
 * What a day's check-in and check-out mean against the shift: minutes worked, late, early departure and overtime.
 * Late = minutes after the start (beyond the grace period). Early departure = minutes before the end. Overtime = minutes after the end,
 * counted only from `overtimeMinMinutes` onward.
 * @param {{ start: string, end: string, breakMinutes?: number, graceMinutes?: number }} shift
 * @param {{ checkIn?: string, checkOut?: string }} t
 * @param {{ overtimeMinMinutes?: number }} [o]
 */
export function attendanceMetrics(shift, { checkIn = "", checkOut = "" }, { overtimeMinMinutes = 30 } = {}) {
  const start = timeToMin(shift.start);
  const end = timeToMin(shift.end) <= start ? timeToMin(shift.end) + 1440 : timeToMin(shift.end);
  const inn = timeToMin(checkIn);
  let out = timeToMin(checkOut);
  if (!Number.isNaN(out) && !Number.isNaN(inn) && out < inn) out += 1440;
  const hasIn = !Number.isNaN(inn);
  const hasOut = !Number.isNaN(out);
  const late = hasIn ? Math.max(0, inn - start - (shift.graceMinutes ?? 0)) : 0;
  const early = hasOut ? Math.max(0, end - out) : 0;
  const worked = hasIn && hasOut ? Math.max(0, out - inn - (shift.breakMinutes ?? 0)) : 0;
  const over = hasOut ? Math.max(0, out - end) : 0;
  return { workedMinutes: worked, lateMinutes: late, earlyMinutes: early, overtimeMinutes: over >= overtimeMinMinutes ? over : 0 };
}

/** present → late when the person arrived late (an explicit status such as half-day or absent is kept). @param {string} status @param {number} lateMinutes */
export const finalStatus = (status, lateMinutes) => (status === "present" && lateMinutes > 0 ? "late" : status);

/* ───────── Pay ───────── */

/** Pay for one day. basis "30": salary ÷ 30; "calendar": ÷ days in the month; "working": ÷ working days in the month. @param {number} basic paisa @param {string} month @param {"30" | "calendar" | "working"} basis @param {number} workingDaysInMonth */
export function dailyRate(basic, month, basis, workingDaysInMonth) {
  const divisor = basis === "calendar" ? daysInMonth(month) : basis === "working" ? Math.max(1, workingDaysInMonth) : 30;
  return Math.round(basic / divisor);
}

/** Pay for one working hour (used for overtime). @param {number} dayRate paisa @param {number} scheduledMinutes minutes in a working day */
export const hourlyRate = (dayRate, scheduledMinutes) => (scheduledMinutes > 0 ? Math.round(dayRate / (scheduledMinutes / 60)) : 0);

/** Split an amount into equal monthly instalments; the last one takes the remainder so the total is exact. @param {number} amount paisa @param {number} months @param {string} startMonth YYYY-MM */
export function installments(amount, months, startMonth) {
  const base = Math.floor(amount / months);
  const out = [];
  let y = Number(startMonth.slice(0, 4));
  let m = Number(startMonth.slice(5, 7));
  for (let i = 0; i < months; i += 1) {
    out.push({ month: `${y}-${String(m).padStart(2, "0")}`, amount: i === months - 1 ? amount - base * (months - 1) : base, status: "scheduled" });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Commission or incentive for one rule and the employee's net sales in the month.
 *   percent  rate % of net sales            fixed   a fixed bonus (when the target, if any, is met)
 *   target   a fixed bonus once net sales reach the target, plus an optional % of the sales ABOVE the target
 * @param {{ type: "percent" | "fixed" | "target", rate?: number, amount?: number, target?: number, aboveRate?: number }} rule
 * @param {number} netSales paisa
 */
export function commissionFor(rule, netSales) {
  const sales = Math.max(0, netSales);
  if (rule.type === "percent") return Math.floor((sales * (rule.rate ?? 0)) / 100);
  if (rule.type === "fixed") return !rule.target || sales >= rule.target ? (rule.amount ?? 0) : 0;
  if (sales < (rule.target ?? 0)) return 0;
  return (rule.amount ?? 0) + Math.floor(((sales - (rule.target ?? 0)) * (rule.aboveRate ?? 0)) / 100);
}

/**
 * One employee's payslip, worked out from their pay terms, their month of attendance and the inputs HR has entered.
 *
 *   Net salary = basic + allowances + overtime + bonuses + commissions − deductions
 *   deductions = attendance (absent days, half-days, late arrivals) + unpaid leave + advance / loan instalments + other authorised deductions
 *
 * A loan or advance instalment is only taken to the extent the rest of the pay can cover it; the part that can't be taken is DEFERRED (and
 * reported), so net pay is never negative. Every amount is whole paisa.
 *
 * @param {{
 *   month: string, basic: number, allowances: { name: string, amount: number }[], bonuses: { name: string, amount: number }[], commissions: { name: string, amount: number }[],
 *   otherEarnings?: { name: string, amount: number }[], otherDeductions: { name: string, amount: number }[], advances: { id: string, label: string, amount: number }[],
 *   attendance: { absentDays: number, halfDays: number, lateCount: number, unpaidLeaveDays: number, overtimeMinutes: number, notEmployedDays?: number },
 *   rules: typeof HR_DEFAULTS.attendance & { overtime: typeof HR_DEFAULTS.overtime }, dayRate: number, scheduledMinutes: number
 * }} p
 */
export function payslipCalc(p) {
  const sum = (list) => list.reduce((n, x) => n + x.amount, 0);
  const a = p.attendance;
  const rule = p.rules;
  const absentDeduction = Math.round(a.absentDays * rule.absentDeductDays * p.dayRate);
  const halfDeduction = Math.round(a.halfDays * rule.halfDayDeductDays * p.dayRate);
  const lateDays = rule.lateEvery > 0 ? Math.floor(a.lateCount / rule.lateEvery) * rule.lateDeductDays : 0;
  const lateDeduction = Math.round(lateDays * p.dayRate);
  const notEmployedDeduction = Math.round((a.notEmployedDays ?? 0) * p.dayRate);
  const attendanceDeduction = absentDeduction + halfDeduction + lateDeduction + notEmployedDeduction;
  const leaveDeduction = Math.round(a.unpaidLeaveDays * p.dayRate);
  const overtime = rule.overtime.enabled && a.overtimeMinutes > 0 ? Math.round((a.overtimeMinutes / 60) * hourlyRate(p.dayRate, p.scheduledMinutes) * rule.overtime.multiplier) : 0;
  const allowances = sum(p.allowances);
  const bonuses = sum(p.bonuses) + sum(p.otherEarnings ?? []);
  const commissions = sum(p.commissions);
  const gross = p.basic + allowances + overtime + bonuses + commissions;
  const other = sum(p.otherDeductions);
  const beforeAdvances = gross - attendanceDeduction - leaveDeduction - other;
  let room = Math.max(0, beforeAdvances);
  /** @type {{ id: string, label: string, amount: number, deferred: number }[]} */
  const advanceTaken = p.advances.map((x) => {
    const take = Math.min(x.amount, room);
    room -= take;
    return { id: x.id, label: x.label, amount: take, deferred: x.amount - take };
  });
  const advanceDeduction = advanceTaken.reduce((n, x) => n + x.amount, 0);
  const deductions = attendanceDeduction + leaveDeduction + advanceDeduction + other;
  const net = gross - deductions;
  return { basic: p.basic, allowances, overtime, bonuses, commissions, gross, absentDeduction, halfDeduction, lateDeduction, notEmployedDeduction, attendanceDeduction, leaveDeduction, advanceDeduction, otherDeductions: other, deductions, net, advances: advanceTaken, deferred: advanceTaken.reduce((n, x) => n + x.deferred, 0), dayRate: p.dayRate };
}

/**
 * The accounting for approving a payroll run: what the salaries cost, what is owed to staff, and what is recovered. Pure, so the tests can check
 * that it always balances.
 *   Dr Salaries expense          earned pay (gross − attendance and unpaid-leave deductions)
 *   Cr Salary payable            net pay owed to employees
 *   Cr Employee advances & loans advance / loan instalments recovered
 *   Cr Payroll deductions payable other authorised deductions held
 * @param {{ gross: number, attendanceDeduction: number, leaveDeduction: number, advanceDeduction: number, otherDeductions: number, net: number }} t
 */
export function accrualLines(t) {
  const earned = t.gross - t.attendanceDeduction - t.leaveDeduction;
  return [
    { role: "salaries", debit: earned, credit: 0, memo: "Salaries earned for the month" },
    { role: "salary_payable", debit: 0, credit: t.net, memo: "Net salaries payable" },
    { role: "employee_advances", debit: 0, credit: t.advanceDeduction, memo: "Advances and loans recovered from pay" },
    { role: "payroll_deductions", debit: 0, credit: t.otherDeductions, memo: "Other deductions held" },
  ].filter((l) => l.debit + l.credit > 0);
}

/** The permissions each HR report needs (ALL of them). The server checks them; the screen only hides what a person can't run. */
export const HR_REPORT_PERMS = {
  directory: ["hr.read"],
  attendance_daily: ["hr.read"],
  attendance_monthly: ["hr.read"],
  late: ["hr.read"],
  overtime: ["hr.read"],
  leave: ["hr.read"],
  payroll_summary: ["hr.salary.read"],
  salary_history: ["hr.salary.read"],
  advances: ["hr.salary.read"],
  commission: ["hr.salary.read"],
  performance: ["hr.read", "sales.read"],
};
export const HR_REPORT_LABEL = {
  directory: "Employee directory",
  attendance_daily: "Daily attendance report",
  attendance_monthly: "Monthly attendance report",
  late: "Late arrival report",
  overtime: "Overtime report",
  leave: "Leave report",
  payroll_summary: "Payroll summary",
  salary_history: "Employee salary history",
  advances: "Advance and loan report",
  commission: "Commission report",
  performance: "Employee performance report",
};
/** Can this person run the HR report? @param {string} report @param {string[]} perms */
export const canRunHrReport = (report, perms) => Boolean(HR_REPORT_PERMS[report]) && HR_REPORT_PERMS[report].every((p) => perms.includes(p));
