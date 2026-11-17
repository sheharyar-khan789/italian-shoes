import { z } from "zod";
import { docId, paisa, text, optionalText, longText, email as emailSchema } from "./common.js";
import { isDateKey } from "../accounting.js";
import { MANUAL_STATUSES, SALARY_METHODS, timeToMin, isMonthKey } from "../hr.js";
import { isPrivateFileRef } from "../privateFiles.js";

const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");
const dateKey = z.string().refine(isDateKey, "Use a valid date");
const optDate = z.string().refine((s) => s === "" || isDateKey(s), "Use a valid date").default("");
const month = z.string().refine(isMonthKey, "Use a month like 2026-11");
const hhmm = z.string().refine((s) => !Number.isNaN(timeToMin(s)), "Use a time like 09:30");
const optTime = z.string().refine((s) => s === "" || !Number.isNaN(timeToMin(s)), "Use a time like 09:30").default("");
const days = z.number().min(0).max(366).multipleOf(0.5, "Use whole or half days");
const slugKey = z.string().regex(/^[a-z0-9_]{2,24}$/, "Use lowercase letters, numbers or _");
const cnic = z.string().transform((s) => s.replace(/[\s-]/g, "")).pipe(z.string().regex(/^\d{13}$/, "A CNIC has 13 digits, e.g. 35202-1234567-1"));
const mobile = z.string().trim().min(7, "Enter a phone number").max(30);
const hrFile = z.string().max(300).refine((p) => isPrivateFileRef(p, "hr"), "Upload the file again");
const hrPhoto = z.string().max(300).refine((p) => isPrivateFileRef(p, "hrphoto"), "Upload the photo again");

/* ───────── Settings ───────── */

export const hrSettingsInput = z.object({
  departments: z.array(text(2, 50)).max(40),
  designations: z.array(text(2, 50)).max(80),
  employmentTypes: z.array(text(2, 40)).min(1).max(15),
  leaveTypes: z.array(z.object({ key: slugKey, name: text(2, 40), days: days, paid: z.boolean() })).min(1).max(15),
  attendance: z.object({ halfDayDeductDays: z.number().min(0).max(1), absentDeductDays: z.number().min(0).max(3), lateEvery: z.number().int().min(0).max(31), lateDeductDays: z.number().min(0).max(3) }),
  overtime: z.object({ enabled: z.boolean(), multiplier: z.number().min(1).max(5), minMinutes: z.number().int().min(0).max(240) }),
  payroll: z.object({ dailyRateBasis: z.enum(["30", "calendar", "working"]), unmarked: z.enum(["block", "present", "absent"]).default("block") }),
}).refine((s) => new Set(s.leaveTypes.map((l) => l.key)).size === s.leaveTypes.length, { message: "Leave type keys must be different", path: ["leaveTypes"] })
  .refine((s) => new Set(s.departments.map((d) => d.toLowerCase())).size === s.departments.length, { message: "A department is listed twice", path: ["departments"] })
  .refine((s) => new Set(s.designations.map((d) => d.toLowerCase())).size === s.designations.length, { message: "A designation is listed twice", path: ["designations"] });

/* ───────── Employees ───────── */

const emergency = z.object({ name: optionalText(80), phone: optionalText(30), relation: optionalText(40) }).default({ name: "", phone: "", relation: "" });

/** General profile (needs hr.write). */
const profile = z.object({
  name: text(2, 100),
  phone: mobile,
  email: z.union([emailSchema, z.literal("")]).default(""),
  address: optionalText(300),
  designation: optionalText(50),
  department: optionalText(50),
  managerId: docId.nullable().optional(),
  joiningDate: dateKey,
  employmentType: optionalText(40),
  photoUrl: z.union([hrPhoto, z.literal("")]).default(""),
  emergencyContact: emergency,
  notes: longText(1000).optional().default(""),
  shiftId: docId.nullable().optional(),
  /** The staff sign-in this employee uses (so they can see their own records). Found by email on the server. */
  staffEmail: z.union([emailSchema, z.literal("")]).default(""),
});

/** Pay terms (need hr.salary.write). */
const pay = z.object({
  basicSalary: paisa,
  salaryMethod: z.enum(SALARY_METHODS),
  payDetails: optionalText(120),
  allowances: z.array(z.object({ name: text(2, 40), amount: paisa })).max(10).default([]),
});

export const saveEmployeeInput = z.object({
  id: docId.optional(),
  profile,
  /** CNIC (needs hr.sensitive). Empty removes it. */
  sensitive: z.object({ cnic: z.union([cnic, z.literal("")]) }).optional(),
  pay: pay.optional(),
});
export const employeeStatusInput = z.object({ id: docId, status: z.enum(["active", "inactive", "terminated"]), leavingDate: optDate, reason: text(3, 200) });
export const employeeIdInput = z.object({ id: docId });
export const listEmployeesInput = z.object({ q: optionalText(80), status: z.enum(["active", "inactive", "terminated", "all"]).default("active"), department: optionalText(50), designation: optionalText(50), managerId: docId.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).max(5000).default(0) });
export const employeeDocInput = z.object({ employeeId: docId, kind: z.enum(["cnic", "contract", "certificate", "medical", "other"]), name: text(2, 120), url: hrFile, type: z.string().max(80), size: z.number().int().min(1).max(5 * 1024 * 1024) });
export const employeeDocDeleteInput = z.object({ employeeId: docId, docId: docId });
export const hrEmptyInput = z.object({});

/* ───────── Shifts, holidays, attendance ───────── */

export const saveShiftInput = z.object({
  id: docId.optional(),
  name: text(2, 40),
  start: hhmm,
  end: hhmm,
  breakMinutes: z.number().int().min(0).max(240),
  graceMinutes: z.number().int().min(0).max(120),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one working day").max(7),
  isActive: z.boolean().default(true),
}).refine((s) => new Set(s.workingDays).size === s.workingDays.length, { message: "A weekday is listed twice", path: ["workingDays"] });
export const assignShiftInput = z.object({ employeeIds: z.array(docId).min(1).max(200), shiftId: docId.nullable() });
export const saveHolidayInput = z.object({ date: dateKey, name: text(2, 60) });
export const holidayDeleteInput = z.object({ date: dateKey });
export const holidayListInput = z.object({ year: z.number().int().min(2000).max(2100) });

export const markAttendanceInput = z.object({ employeeId: docId, date: dateKey, status: z.enum(MANUAL_STATUSES), checkIn: optTime, checkOut: optTime, note: optionalText(200) });
export const bulkAttendanceInput = z.object({
  date: dateKey,
  entries: z.array(z.object({ employeeId: docId, status: z.enum(MANUAL_STATUSES), checkIn: optTime, checkOut: optTime })).min(1).max(150),
}).refine((b) => new Set(b.entries.map((e) => e.employeeId)).size === b.entries.length, { message: "An employee is listed twice", path: ["entries"] });
export const correctAttendanceInput = z.object({ employeeId: docId, date: dateKey, status: z.enum(MANUAL_STATUSES), checkIn: optTime, checkOut: optTime, reason: text(3, 200) });
export const attendanceDayInput = z.object({ date: dateKey });
export const employeeMonthInput = z.object({ employeeId: docId, month });
export const monthInput = z.object({ month });

/* ───────── Leave ───────── */

export const applyLeaveInput = z.object({ idempotencyKey: key, employeeId: docId.optional(), type: slugKey, from: dateKey, to: dateKey, halfDay: z.boolean().default(false), reason: text(3, 300) })
  .refine((l) => l.to >= l.from, { message: "The end date can't be before the start date", path: ["to"] })
  .refine((l) => !l.halfDay || l.from === l.to, { message: "A half day is a single date", path: ["halfDay"] });
export const decideLeaveInput = z.object({ id: docId, decision: z.enum(["approve", "reject"]), note: optionalText(300) });
export const cancelLeaveInput = z.object({ id: docId });
export const adjustLeaveInput = z.object({ idempotencyKey: key, employeeId: docId, year: z.number().int().min(2000).max(2100), type: slugKey, days: z.number().min(-366).max(366).multipleOf(0.5).refine((n) => n !== 0, "Enter a number other than zero"), reason: text(3, 200) });
export const leaveListInput = z.object({ status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("all"), employeeId: docId.optional(), limit: z.number().int().min(1).max(200).default(50) });
export const leaveBalanceInput = z.object({ employeeId: docId.optional(), year: z.number().int().min(2000).max(2100) });

/* ───────── Advances and loans ───────── */

export const requestAdvanceInput = z.object({ idempotencyKey: key, employeeId: docId.optional(), kind: z.enum(["advance", "loan"]), amount: paisa.refine((n) => n > 0, "Enter an amount"), months: z.number().int().min(1).max(60), startMonth: month, reason: text(3, 300) });
export const decideAdvanceInput = z.object({ id: docId, decision: z.enum(["approve", "reject"]), note: optionalText(300) });
export const disburseAdvanceInput = z.object({ idempotencyKey: key, id: docId, method: z.enum(SALARY_METHODS), date: dateKey, reference: optionalText(80) });
export const advanceListInput = z.object({ status: z.enum(["requested", "approved", "rejected", "disbursed", "closed", "cancelled", "all"]).default("all"), employeeId: docId.optional(), limit: z.number().int().min(1).max(200).default(50) });
export const advanceIdInput = z.object({ id: docId });

/* ───────── Commission rules ───────── */

export const saveCommissionRuleInput = z.object({
  id: docId.optional(),
  name: text(2, 60),
  type: z.enum(["percent", "fixed", "target"]),
  rate: z.number().min(0).max(100).default(0),
  amount: paisa.default(0),
  target: paisa.default(0),
  aboveRate: z.number().min(0).max(100).default(0),
  scope: z.enum(["all", "employee", "designation"]),
  employeeId: docId.nullable().optional(),
  designation: optionalText(50),
  isActive: z.boolean().default(true),
}).refine((r) => r.scope !== "employee" || Boolean(r.employeeId), { message: "Choose the employee", path: ["employeeId"] })
  .refine((r) => r.scope !== "designation" || Boolean(r.designation), { message: "Choose the designation", path: ["designation"] })
  .refine((r) => r.type !== "percent" || r.rate > 0, { message: "Enter the percentage", path: ["rate"] })
  .refine((r) => r.type === "percent" || r.amount > 0, { message: "Enter the bonus amount", path: ["amount"] })
  .refine((r) => r.type !== "target" || r.target > 0, { message: "Enter the sales target", path: ["target"] });
export const commissionActiveInput = z.object({ id: docId, isActive: z.boolean() });

/* ───────── Payroll ───────── */

export const generatePayrollInput = z.object({ month });
export const payrollAdjustInput = z.object({ month, employeeId: docId, kind: z.enum(["allowance", "bonus", "deduction"]), name: text(2, 60), amount: paisa.refine((n) => n > 0, "Enter an amount"), reason: text(3, 200) });
export const payrollAdjustDeleteInput = z.object({ id: docId });
export const approvePayrollInput = z.object({ month });
export const reversePayrollInput = z.object({ month, reason: text(3, 200) });
export const paySalariesInput = z.object({ idempotencyKey: key, month, employeeIds: z.array(docId).min(1).max(40), method: z.enum(SALARY_METHODS).optional(), date: dateKey, reference: optionalText(80) });
export const voidSalaryPaymentInput = z.object({ month, employeeId: docId, reason: text(3, 200) });
export const payslipInput = z.object({ month, employeeId: docId.optional() });
export const myPayslipsInput = z.object({ limit: z.number().int().min(1).max(36).default(12) });

/* ───────── Reports ───────── */

export const HR_REPORTS = ["directory", "attendance_daily", "attendance_monthly", "late", "overtime", "leave", "payroll_summary", "salary_history", "advances", "commission", "performance"];
export const hrReportInput = z.object({ report: z.enum(/** @type {[string, ...string[]]} */ (HR_REPORTS)), from: dateKey, to: dateKey, employeeId: docId.optional() }).refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const hrExportInput = z.object({ report: z.enum(/** @type {[string, ...string[]]} */ (/** @type {unknown} */ ([...HR_REPORTS, "payslip"]))), format: z.enum(["csv", "excel", "print"]), from: dateKey, to: dateKey });
export const hrRolesInput = z.object({});
