import { test } from "node:test";
import assert from "node:assert/strict";
import { HR_DEFAULTS, timeToMin, minToTime, weekdayOf, monthRange, daysInMonth, isMonthKey, workingDates, leaveDays, shiftMinutes, attendanceMetrics, finalStatus, dailyRate, hourlyRate, installments, commissionFor, payslipCalc, accrualLines, canRunHrReport, HR_REPORT_PERMS } from "../../shared/hr.js";
import { hrSettingsInput, saveEmployeeInput, markAttendanceInput, bulkAttendanceInput, applyLeaveInput, requestAdvanceInput, saveCommissionRuleInput, saveShiftInput, paySalariesInput, payrollAdjustInput, employeeDocInput } from "../../shared/schemas/index.js";
import { ALL_PERMISSIONS, HR_ROLES, OWNER_ONLY, claimPerms, expandClaimPerms, DEFAULT_ROLES } from "../../shared/permissions.js";
import { DEFAULT_ACCOUNTS, ROLES, checkJournalLines } from "../../shared/accounting.js";

test("times and dates: Pakistan-time keys, weekdays, month ranges, working days exclude weekly offs and holidays", () => {
  assert.equal(timeToMin("09:30"), 570);
  assert.ok(Number.isNaN(timeToMin("9:30")) && Number.isNaN(timeToMin("24:00")) && Number.isNaN(timeToMin("")));
  assert.equal(minToTime(570), "09:30");
  assert.equal(weekdayOf("2026-11-16"), 1);
  assert.equal(weekdayOf("2026-11-22"), 0);
  assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
  assert.equal(daysInMonth("2026-12"), 31);
  assert.equal(isMonthKey("2026-13"), false);
  const mon_sat = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(workingDates("2026-11-16", "2026-11-23", mon_sat, ["2026-11-18"]), ["2026-11-16", "2026-11-17", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-23"], "no Sunday, no holiday");
  assert.equal(leaveDays({ from: "2026-11-20", to: "2026-11-23" }, mon_sat), 3, "Fri, Sat, Mon: the Sunday doesn't use leave");
  assert.equal(leaveDays({ from: "2026-11-22", to: "2026-11-22" }, mon_sat), 0);
  assert.equal(leaveDays({ from: "2026-11-16", to: "2026-11-16", halfDay: true }, mon_sat), 0.5);
  assert.equal(leaveDays({ from: "2026-11-22", to: "2026-11-22", halfDay: true }, mon_sat), 0, "a half day on a day off is nothing");
});

test("shift calculations: late after the grace period, early departure, overtime beyond the minimum, overnight shifts", () => {
  const shift = { start: "09:00", end: "18:00", breakMinutes: 60, graceMinutes: 10 };
  assert.equal(shiftMinutes(shift), 480);
  assert.deepEqual(attendanceMetrics(shift, { checkIn: "09:35", checkOut: "17:30" }), { workedMinutes: 415, lateMinutes: 25, earlyMinutes: 30, overtimeMinutes: 0 });
  assert.deepEqual(attendanceMetrics(shift, { checkIn: "09:10", checkOut: "18:45" }), { workedMinutes: 515, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 45 }, "exactly at the grace limit is not late");
  assert.equal(attendanceMetrics(shift, { checkIn: "09:00", checkOut: "18:29" }).overtimeMinutes, 0, "below the 30-minute minimum");
  assert.equal(attendanceMetrics(shift, { checkIn: "09:00", checkOut: "18:30" }).overtimeMinutes, 30);
  assert.equal(attendanceMetrics(shift, { checkIn: "09:00", checkOut: "18:20" }, { overtimeMinMinutes: 15 }).overtimeMinutes, 20);
  assert.deepEqual(attendanceMetrics(shift, { checkIn: "09:20" }), { workedMinutes: 0, lateMinutes: 10, earlyMinutes: 0, overtimeMinutes: 0 }, "no departure yet");
  const night = { start: "22:00", end: "06:00", breakMinutes: 0, graceMinutes: 0 };
  assert.equal(shiftMinutes(night), 480);
  assert.deepEqual(attendanceMetrics(night, { checkIn: "22:15", checkOut: "06:00" }), { workedMinutes: 465, lateMinutes: 15, earlyMinutes: 0, overtimeMinutes: 0 });
  assert.equal(finalStatus("present", 5), "late");
  assert.equal(finalStatus("present", 0), "present");
  assert.equal(finalStatus("half_day", 40), "half_day");
  assert.equal(finalStatus("absent", 0), "absent");
});

test("daily and hourly pay, instalments that add up exactly, commission rules", () => {
  assert.equal(dailyRate(3000000, "2026-11", "30", 26), 100000);
  assert.equal(dailyRate(3100000, "2026-12", "calendar", 26), 100000);
  assert.equal(dailyRate(2600000, "2026-11", "working", 26), 100000);
  assert.equal(hourlyRate(100000, 480), 12500);
  assert.equal(hourlyRate(100000, 0), 0);
  const inst = installments(1000000, 3, "2026-11");
  assert.deepEqual(inst.map((i) => i.amount), [333333, 333333, 333334]);
  assert.equal(inst.reduce((n, i) => n + i.amount, 0), 1000000, "never a paisa lost");
  assert.deepEqual(installments(100, 2, "2026-12").map((i) => i.month), ["2026-12", "2027-01"], "rolls over the year");
  assert.equal(commissionFor({ type: "percent", rate: 2 }, 1000000), 20000);
  assert.equal(commissionFor({ type: "percent", rate: 2.5 }, 999), 24, "rounded down");
  assert.equal(commissionFor({ type: "percent", rate: 2 }, -500), 0, "no commission on negative sales");
  assert.equal(commissionFor({ type: "fixed", amount: 50000 }, 0), 50000);
  assert.equal(commissionFor({ type: "fixed", amount: 50000, target: 100000 }, 99999), 0);
  assert.equal(commissionFor({ type: "fixed", amount: 50000, target: 100000 }, 100000), 50000);
  assert.equal(commissionFor({ type: "target", amount: 30000, target: 1000000, aboveRate: 10 }, 999999), 0);
  assert.equal(commissionFor({ type: "target", amount: 30000, target: 1000000, aboveRate: 10 }, 1500000), 30000 + 50000);
});

const rules = { ...HR_DEFAULTS.attendance, lateEvery: 3, overtime: { enabled: true, multiplier: 1.5, minMinutes: 30 } };
const base = { month: "2026-10", basic: 3000000, allowances: [{ name: "Fuel", amount: 200000 }], bonuses: [], commissions: [], otherDeductions: [], advances: [], attendance: { absentDays: 0, halfDays: 0, lateCount: 0, unpaidLeaveDays: 0, overtimeMinutes: 0 }, rules, dayRate: 100000, scheduledMinutes: 480 };

test("payslip: Net = basic + allowances + overtime + bonuses + commissions − deductions, every line in whole paisa", () => {
  const c = payslipCalc({ ...base, bonuses: [{ name: "Eid", amount: 500000 }], commissions: [{ name: "Sales", amount: 20000 }], otherDeductions: [{ name: "Fine", amount: 25000 }], attendance: { absentDays: 1, halfDays: 1, lateCount: 3, unpaidLeaveDays: 1, overtimeMinutes: 120 } });
  assert.deepEqual([c.basic, c.allowances, c.overtime, c.bonuses, c.commissions], [3000000, 200000, 37500, 500000, 20000]);
  assert.equal(c.gross, 3000000 + 200000 + 37500 + 500000 + 20000);
  assert.deepEqual([c.absentDeduction, c.halfDeduction, c.lateDeduction, c.attendanceDeduction, c.leaveDeduction, c.otherDeductions], [100000, 50000, 50000, 200000, 100000, 25000]);
  assert.equal(c.net, c.gross - c.deductions);
  assert.equal(c.net, 3757500 - 325000);
  for (const v of Object.values(c)) if (typeof v === "number") assert.ok(Number.isInteger(v), "whole paisa");
});

test("payslip: late deduction only every N lates, overtime off or below the minimum pays nothing, part-month employment is deducted", () => {
  assert.equal(payslipCalc({ ...base, attendance: { ...base.attendance, lateCount: 2 } }).lateDeduction, 0);
  assert.equal(payslipCalc({ ...base, attendance: { ...base.attendance, lateCount: 7 } }).lateDeduction, 100000, "two full groups of three = 1 day");
  assert.equal(payslipCalc({ ...base, rules: { ...rules, lateEvery: 0 }, attendance: { ...base.attendance, lateCount: 9 } }).lateDeduction, 0, "switched off");
  assert.equal(payslipCalc({ ...base, rules: { ...rules, overtime: { ...rules.overtime, enabled: false } }, attendance: { ...base.attendance, overtimeMinutes: 600 } }).overtime, 0);
  assert.equal(payslipCalc({ ...base, attendance: { ...base.attendance, notEmployedDays: 10 } }).attendanceDeduction, 1000000, "joined on the 11th: ten days are not paid");
  assert.equal(payslipCalc({ ...base, rules: { ...rules, absentDeductDays: 2 }, attendance: { ...base.attendance, absentDays: 1 } }).absentDeduction, 200000, "the owner can make an absence cost two days");
});

test("payslip: advance and loan instalments are limited by what the pay can cover; the rest is DEFERRED, never a negative net", () => {
  const c = payslipCalc({ ...base, basic: 100000, allowances: [], advances: [{ id: "a1", label: "Loan", amount: 80000 }, { id: "a2", label: "Advance", amount: 80000 }] });
  assert.deepEqual(c.advances.map((a) => [a.amount, a.deferred]), [[80000, 0], [20000, 60000]]);
  assert.equal(c.advanceDeduction, 100000);
  assert.equal(c.net, 0);
  assert.equal(c.deferred, 60000);
  const d = payslipCalc({ ...base, basic: 100000, allowances: [], attendance: { ...base.attendance, absentDays: 3 }, advances: [{ id: "a1", label: "Loan", amount: 50000 }] });
  assert.equal(d.attendanceDeduction, 300000);
  assert.equal(d.advances[0].amount, 0, "nothing left to take an instalment from");
  assert.ok(d.net <= 0 || d.net === d.gross - d.deductions);
  const e = payslipCalc({ ...base, advances: [{ id: "a1", label: "Loan", amount: 200000 }] });
  assert.equal(e.net, 3200000 - 200000);
  assert.equal(e.deferred, 0);
});

test("accounting: the payroll journal ALWAYS balances (Dr salaries earned = Cr payable + advances recovered + deductions held)", () => {
  const cases = [
    { ...base },
    { ...base, bonuses: [{ name: "B", amount: 12345 }], otherDeductions: [{ name: "F", amount: 999 }], attendance: { absentDays: 2, halfDays: 1, lateCount: 5, unpaidLeaveDays: 1.5, overtimeMinutes: 95 }, advances: [{ id: "x", label: "L", amount: 333333 }], commissions: [{ name: "C", amount: 7 }] },
    { ...base, basic: 1, allowances: [], advances: [{ id: "x", label: "L", amount: 5 }], attendance: { absentDays: 1, halfDays: 0, lateCount: 0, unpaidLeaveDays: 0, overtimeMinutes: 0 } },
  ];
  const index = Object.fromEntries(DEFAULT_ACCOUNTS.map((a) => [a.code, { name: a.name, type: a.type, contra: Boolean(a.contra), active: true, isGroup: Boolean(a.isGroup) }]));
  const role = (r) => DEFAULT_ACCOUNTS.find((a) => a.role === r)?.code;
  for (const input of cases) {
    const c = payslipCalc(input);
    const lines = accrualLines(c);
    assert.equal(lines.reduce((n, l) => n + l.debit, 0), lines.reduce((n, l) => n + l.credit, 0));
    const check = checkJournalLines(lines.map((l) => ({ accountCode: role(l.role), debit: l.debit, credit: l.credit })), index);
    assert.ok(check.ok || lines.length < 2, check.errors?.join(";"));
  }
  assert.ok(["employee_advances", "salary_payable", "payroll_deductions", "salaries"].every((r) => ROLES[r] && DEFAULT_ACCOUNTS.some((a) => a.role === r)), "every HR role has a default account");
  assert.equal(new Set(DEFAULT_ACCOUNTS.map((a) => a.code)).size, DEFAULT_ACCOUNTS.length);
});

test("schemas: employees, shifts, attendance, leave, advances, commission rules, payments", () => {
  const profile = { name: "Asad Ali", phone: "0300 1234567", joiningDate: "2026-01-01" };
  assert.equal(saveEmployeeInput.safeParse({ profile }).success, true);
  assert.equal(saveEmployeeInput.safeParse({ profile: { ...profile, joiningDate: "2026-02-30" } }).success, false);
  assert.equal(saveEmployeeInput.safeParse({ profile: { ...profile, phone: "1" } }).success, false);
  assert.equal(saveEmployeeInput.safeParse({ profile, sensitive: { cnic: "35202-1234567-1" } }).success, true);
  assert.equal(saveEmployeeInput.parse({ profile, sensitive: { cnic: "35202-1234567-1" } }).sensitive.cnic, "3520212345671");
  assert.equal(saveEmployeeInput.safeParse({ profile, sensitive: { cnic: "123" } }).success, false);
  assert.equal(saveEmployeeInput.safeParse({ profile, pay: { basicSalary: -5, salaryMethod: "cash" } }).success, false);
  assert.equal(saveEmployeeInput.safeParse({ profile, pay: { basicSalary: 100000, salaryMethod: "bitcoin" } }).success, false);
  assert.equal(saveEmployeeInput.safeParse({ profile: { ...profile, photoUrl: "http://evil.example/p.png" } }).success, false, "only uploaded files");
  assert.equal(employeeDocInput.safeParse({ employeeId: "e1", kind: "cnic", name: "Front", url: "hr/u/a.png", type: "image/png", size: 100 }).success, true);
  assert.equal(employeeDocInput.safeParse({ employeeId: "e1", kind: "cnic", name: "Front", url: "javascript:alert(1)", type: "image/png", size: 100 }).success, false);
  assert.equal(saveShiftInput.safeParse({ name: "Day", start: "09:00", end: "18:00", breakMinutes: 60, graceMinutes: 10, workingDays: [1, 1] }).success, false, "a weekday twice");
  assert.equal(saveShiftInput.safeParse({ name: "Day", start: "09:00", end: "18:00", breakMinutes: 60, graceMinutes: 10, workingDays: [] }).success, false);
  assert.equal(markAttendanceInput.safeParse({ employeeId: "e1", date: "2026-11-16", status: "present" }).success, true);
  assert.equal(markAttendanceInput.safeParse({ employeeId: "e1", date: "2026-11-16", status: "present", checkIn: "25:00" }).success, false);
  assert.equal(markAttendanceInput.safeParse({ employeeId: "e1", date: "2026-11-16", status: "sleeping" }).success, false);
  assert.equal(bulkAttendanceInput.safeParse({ date: "2026-11-16", entries: [{ employeeId: "a", status: "present" }, { employeeId: "a", status: "absent" }] }).success, false);
  assert.equal(applyLeaveInput.safeParse({ idempotencyKey: "abcdefgh12", type: "annual", from: "2026-11-02", to: "2026-11-01", reason: "Trip" }).success, false);
  assert.equal(applyLeaveInput.safeParse({ idempotencyKey: "abcdefgh12", type: "annual", from: "2026-11-01", to: "2026-11-02", halfDay: true, reason: "Trip" }).success, false, "a half day is one date");
  assert.equal(requestAdvanceInput.safeParse({ idempotencyKey: "abcdefgh12", kind: "loan", amount: 0, months: 3, startMonth: "2026-11", reason: "Bike" }).success, false);
  assert.equal(requestAdvanceInput.safeParse({ idempotencyKey: "abcdefgh12", kind: "loan", amount: 600000, months: 3, startMonth: "2026-11", reason: "Bike" }).success, true);
  assert.equal(saveCommissionRuleInput.safeParse({ name: "Two", type: "percent", rate: 2, scope: "all" }).success, true);
  assert.equal(saveCommissionRuleInput.safeParse({ name: "Two", type: "percent", rate: 0, scope: "all" }).success, false);
  assert.equal(saveCommissionRuleInput.safeParse({ name: "Two", type: "percent", rate: 2, scope: "employee" }).success, false, "needs the employee");
  assert.equal(saveCommissionRuleInput.safeParse({ name: "T", type: "target", amount: 100, target: 0, scope: "all" }).success, false);
  assert.equal(payrollAdjustInput.safeParse({ month: "2026-11", employeeId: "e", kind: "commission", name: "x1", amount: 5, reason: "xyz" }).success, false, "commission can't be typed in");
  assert.equal(paySalariesInput.safeParse({ idempotencyKey: "abcdefgh12", month: "2026-11", employeeIds: [], date: "2026-11-30" }).success, false);
  const s = { departments: ["Sales"], designations: ["Manager"], employmentTypes: ["Full-time"], leaveTypes: HR_DEFAULTS.leaveTypes, attendance: HR_DEFAULTS.attendance, overtime: HR_DEFAULTS.overtime, payroll: { dailyRateBasis: "30", unmarked: "block" } };
  assert.equal(hrSettingsInput.safeParse(s).success, true);
  assert.equal(hrSettingsInput.safeParse({ ...s, departments: ["Sales", "sales"] }).success, false, "a department twice");
  assert.equal(hrSettingsInput.safeParse({ ...s, leaveTypes: [HR_DEFAULTS.leaveTypes[0], HR_DEFAULTS.leaveTypes[0]] }).success, false);
  assert.equal(HR_DEFAULTS.departments.length, 0, "no hard-coded organisation: departments and designations start empty");
});

test("permissions and roles: every HR permission exists, the executive-style split between preparing and approving payroll, reports need all their permissions", () => {
  const hr = ALL_PERMISSIONS.filter((p) => p.startsWith("hr."));
  assert.equal(hr.length, 14);
  for (const r of Object.values(HR_REPORT_PERMS)) for (const p of r) assert.ok(ALL_PERMISSIONS.includes(p), p);
  assert.ok(HR_ROLES.hr_manager.permissions.every((p) => ALL_PERMISSIONS.includes(p)));
  assert.ok(!HR_ROLES.hr_manager.permissions.some((p) => ["hr.payroll.approve", "hr.payroll.pay"].includes(p)), "preparing payroll is separate from approving and paying it");
  assert.ok(HR_ROLES.payroll_accountant.permissions.includes("hr.payroll.approve") && !HR_ROLES.payroll_accountant.permissions.includes("hr.write"));
  assert.deepEqual(HR_ROLES.employee.permissions, ["hr.self"]);
  assert.ok(!OWNER_ONLY.includes("hr.salary.read"));
  assert.equal(canRunHrReport("payroll_summary", ["hr.read"]), false);
  assert.equal(canRunHrReport("payroll_summary", ["hr.salary.read"]), true);
  assert.equal(canRunHrReport("performance", ["hr.read"]), false);
  assert.equal(canRunHrReport("directory", ["hr.read"]), true);
  assert.equal(canRunHrReport("nope", ALL_PERMISSIONS), false);
});

test("sign-in token claims: the Owner's permissions are one wildcard (the full list exceeds Firebase's 1,000-character limit); everyone else keeps a plain list", () => {
  const full = JSON.stringify({ staff: true, roles: ["owner"], perms: ALL_PERMISSIONS });
  assert.ok(full.length > 1000, "the full list would be rejected by Firebase (" + full.length + " characters)");
  assert.deepEqual(claimPerms(ALL_PERMISSIONS), ["*"]);
  assert.deepEqual(expandClaimPerms(["*"]), ALL_PERMISSIONS);
  assert.deepEqual(claimPerms(["orders.read", "hr.self"]), ["orders.read", "hr.self"]);
  assert.deepEqual(expandClaimPerms(["orders.read"]), ["orders.read"]);
  assert.deepEqual(expandClaimPerms(undefined), []);
  assert.deepEqual(expandClaimPerms("*"), [], "only a list is a claim");
  assert.deepEqual(claimPerms(ALL_PERMISSIONS.slice(1)), ALL_PERMISSIONS.slice(1), "one missing permission is not the owner");
  for (const [key, role] of Object.entries(DEFAULT_ROLES)) if (key !== "owner") assert.ok(JSON.stringify({ staff: true, roles: [key], perms: role.permissions }).length < 1000, key + " fits");
  for (const [key, role] of Object.entries(HR_ROLES)) assert.ok(JSON.stringify({ staff: true, roles: [key], perms: role.permissions }).length < 1000, key + " fits");
});
