/**
 * HR, attendance, leave and payroll endpoints. Each checks its permission on the server from the verified sign-in token; the person's identity
 * (and so "my own records") comes from that token, never from the request.
 *
 *   hr.read            directory, attendance, leave, dashboard (contact details, no salary or CNIC)
 *   hr.write           add / edit employees                      hr.sensitive   CNIC and documents
 *   hr.salary.read     salaries, payslips, payroll, advances     hr.salary.write   pay terms
 *   hr.attendance      mark / correct attendance, shifts, holidays        hr.leave.manage   approve leave, adjust balances
 *   hr.payroll.generate / .approve / .pay      prepare / approve + reverse / record payments
 *   hr.advances.manage approve and pay out advances and loans    hr.manage   HR settings and commission rules
 *   hr.export          export / print     hr.self   own profile, attendance, leave, advances and payslips
 */
import { secureCallable } from "../lib/callable.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import * as S from "../shared/schemas/index.js";
import { canRunHrReport, HR_REPORT_LABEL } from "../shared/hr.js";
import * as hr from "../services/hr.js";
import * as att from "../services/hrAttendance.js";
import * as pay from "../services/hrPayroll.js";
import * as rep from "../services/hrReports.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const permsOf = (ctx) => (Array.isArray(ctx.token?.perms) ? /** @type {string[]} */ (ctx.token.perms) : []);
const P = (permission, limit = 300) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });
/** An endpoint without a single fixed permission: the handler checks (any of these). */
const ANY = (limit = 300) => ({ auth: /** @type {const} */ ("required"), rateLimit: { limit, windowSeconds: 600 } });
const need = (ctx, ...anyOf) => {
  if (!anyOf.some((p) => permsOf(ctx).includes(p))) throw new AppError("permission-denied", "You don't have permission to do this.");
};
/** The signed-in person's own employee record (needs hr.self). */
const own = async (ctx) => {
  need(ctx, "hr.self");
  return att.requireOwnEmployee(/** @type {string} */ (ctx.uid));
};

/* ───────── Settings, roles ───────── */
export const getHrSettings = secureCallable("getHrSettings", { ...ANY(), schema: S.hrEmptyInput }, (ctx) => {
  need(ctx, "hr.read", "hr.self");
  return hr.getHrSettings();
});
export const saveHrSettings = secureCallable("saveHrSettings", { ...P("hr.manage", 30), schema: S.hrSettingsInput }, (ctx) => hr.saveHrSettings(ctx.data, actorOf(ctx)));
export const createHrRoles = secureCallable("createHrRoles", { ...P("staff.manage", 6), schema: S.hrRolesInput }, (ctx) => hr.createHrRoles(/** @type {string} */ (ctx.uid)));

/* ───────── Employees ───────── */
export const saveEmployee = secureCallable("saveEmployee", { ...P("hr.write", 120), schema: S.saveEmployeeInput }, (ctx) => hr.saveEmployee(ctx.data, actorOf(ctx), permsOf(ctx)));
export const setEmployeeStatus = secureCallable("setEmployeeStatus", { ...P("hr.write", 60), schema: S.employeeStatusInput }, (ctx) => hr.setEmployeeStatus(ctx.data, actorOf(ctx)));
export const listEmployees = secureCallable("listEmployees", { ...P("hr.read"), schema: S.listEmployeesInput }, (ctx) => hr.listEmployees(ctx.data, permsOf(ctx)));
export const getEmployee = secureCallable("getEmployee", { ...P("hr.read"), schema: S.employeeIdInput }, async (ctx) => {
  const r = await hr.getEmployee(ctx.data, permsOf(ctx));
  if (permsOf(ctx).includes("hr.sensitive") || permsOf(ctx).includes("hr.salary.read")) await writeAudit({ actorUid: ctx.uid, action: "hr.employee_viewed", entityType: "employee", entityId: ctx.data.id, changes: { sensitive: permsOf(ctx).includes("hr.sensitive"), salary: permsOf(ctx).includes("hr.salary.read") } });
  return r;
});
export const addEmployeeDocument = secureCallable("addEmployeeDocument", { ...P("hr.sensitive", 60), schema: S.employeeDocInput }, (ctx) => hr.addDocument(ctx.data, actorOf(ctx)));
export const removeEmployeeDocument = secureCallable("removeEmployeeDocument", { ...P("hr.sensitive", 60), schema: S.employeeDocDeleteInput }, (ctx) => hr.removeDocument(ctx.data, actorOf(ctx)));
export const hrMyProfile = secureCallable("hrMyProfile", { ...ANY(), schema: S.hrEmptyInput }, async (ctx) => {
  const e = await own(ctx);
  const shift = e.shiftId ? (await att.listShifts()).shifts.find((s) => s.id === e.shiftId) : null;
  return { employee: { id: e.id, employeeNo: e.employeeNo, name: e.name, phone: e.phone, email: e.email ?? "", address: e.address ?? "", designation: e.designation ?? "", department: e.department ?? "", joiningDate: e.joiningDate, employmentType: e.employmentType ?? "", status: e.status, photoUrl: e.photoUrl ?? "", emergencyContact: e.emergencyContact ?? null }, shift: shift ? { name: shift.name, start: shift.start, end: shift.end, breakMinutes: shift.breakMinutes, workingDays: shift.workingDays } : null };
});

/* ───────── Shifts, holidays ───────── */
export const saveShift = secureCallable("saveShift", { ...P("hr.attendance", 60), schema: S.saveShiftInput }, (ctx) => att.saveShift(ctx.data, actorOf(ctx)));
export const listShifts = secureCallable("listShifts", { ...P("hr.read"), schema: S.hrEmptyInput }, () => att.listShifts());
export const assignShift = secureCallable("assignShift", { ...P("hr.attendance", 60), schema: S.assignShiftInput }, (ctx) => att.assignShift(ctx.data, actorOf(ctx)));
export const saveHoliday = secureCallable("saveHoliday", { ...P("hr.attendance", 60), schema: S.saveHolidayInput }, (ctx) => att.saveHoliday(ctx.data, actorOf(ctx)));
export const deleteHoliday = secureCallable("deleteHoliday", { ...P("hr.attendance", 60), schema: S.holidayDeleteInput }, (ctx) => att.deleteHoliday(ctx.data, actorOf(ctx)));
export const listHolidays = secureCallable("listHolidays", { ...ANY(), schema: S.holidayListInput }, (ctx) => {
  need(ctx, "hr.read", "hr.self");
  return att.listHolidays(ctx.data);
});

/* ───────── Attendance ───────── */
export const markAttendance = secureCallable("markAttendance", { ...P("hr.attendance", 300), schema: S.markAttendanceInput }, (ctx) => att.markAttendance(ctx.data, actorOf(ctx)));
export const bulkMarkAttendance = secureCallable("bulkMarkAttendance", { ...P("hr.attendance", 60), schema: S.bulkAttendanceInput }, (ctx) => att.bulkMarkAttendance(ctx.data, actorOf(ctx)));
export const correctAttendance = secureCallable("correctAttendance", { ...P("hr.attendance", 120), schema: S.correctAttendanceInput }, (ctx) => att.correctAttendance(ctx.data, actorOf(ctx)));
export const attendanceDay = secureCallable("attendanceDay", { ...P("hr.read"), schema: S.attendanceDayInput }, (ctx) => att.attendanceDay(ctx.data));
export const employeeAttendanceMonth = secureCallable("employeeAttendanceMonth", { ...P("hr.read"), schema: S.employeeMonthInput }, (ctx) => att.employeeMonth(ctx.data));
export const monthlyAttendance = secureCallable("monthlyAttendance", { ...P("hr.read"), schema: S.monthInput }, (ctx) => att.monthlyAttendance(ctx.data));
export const myAttendance = secureCallable("myAttendance", { ...ANY(), schema: S.monthInput }, async (ctx) => att.employeeMonth({ employeeId: (await own(ctx)).id, month: ctx.data.month }));

/* ───────── Leave ───────── */
export const applyLeave = secureCallable("applyLeave", { ...ANY(60), schema: S.applyLeaveInput }, async (ctx) => {
  const mine = permsOf(ctx).includes("hr.self") ? await att.requireOwnEmployee(/** @type {string} */ (ctx.uid)).catch(() => null) : null;
  const target = ctx.data.employeeId && ctx.data.employeeId !== mine?.id ? ctx.data.employeeId : null;
  if (target) {
    need(ctx, "hr.write", "hr.leave.manage");
    const e = (await hr.employees().doc(target).get());
    if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
    return att.applyLeave(ctx.data, actorOf(ctx), hr.plain(e));
  }
  if (!mine) throw new AppError("permission-denied", "Your sign-in isn't linked to an employee record.");
  return att.applyLeave(ctx.data, actorOf(ctx), mine);
});
export const decideLeave = secureCallable("decideLeave", { ...P("hr.leave.manage", 120), schema: S.decideLeaveInput }, (ctx) => att.decideLeave(ctx.data, actorOf(ctx)));
export const cancelLeave = secureCallable("cancelLeave", { ...ANY(60), schema: S.cancelLeaveInput }, async (ctx) => {
  const canManage = permsOf(ctx).includes("hr.leave.manage");
  const mine = permsOf(ctx).includes("hr.self") ? await att.requireOwnEmployee(/** @type {string} */ (ctx.uid)).catch(() => null) : null;
  if (!canManage && !mine) throw new AppError("permission-denied", "You don't have permission to do this.");
  return att.cancelLeave(ctx.data, actorOf(ctx), { canManage, employeeId: mine?.id ?? null });
});
export const adjustLeaveBalance = secureCallable("adjustLeaveBalance", { ...P("hr.leave.manage", 60), schema: S.adjustLeaveInput }, (ctx) => att.adjustLeave(ctx.data, actorOf(ctx)));
export const listLeave = secureCallable("listLeave", { ...P("hr.read"), schema: S.leaveListInput }, (ctx) => att.listLeave(ctx.data));
export const leaveBalance = secureCallable("leaveBalance", { ...ANY(), schema: S.leaveBalanceInput }, async (ctx) => {
  if (ctx.data.employeeId) {
    const mine = permsOf(ctx).includes("hr.self") ? await att.requireOwnEmployee(/** @type {string} */ (ctx.uid)).catch(() => null) : null;
    if (mine?.id !== ctx.data.employeeId) need(ctx, "hr.read");
    return att.leaveBalance(ctx.data, ctx.data.employeeId);
  }
  return att.leaveBalance(ctx.data, (await own(ctx)).id);
});
export const myLeave = secureCallable("myLeave", { ...ANY(), schema: S.leaveListInput }, async (ctx) => att.listLeave({ ...ctx.data, employeeId: (await own(ctx)).id }));
export const leaveCalendar = secureCallable("leaveCalendar", { ...P("hr.read"), schema: S.monthInput }, (ctx) => att.leaveCalendar(ctx.data));

/* ───────── Advances, loans, commission ───────── */
export const requestAdvance = secureCallable("requestAdvance", { ...ANY(60), schema: S.requestAdvanceInput }, async (ctx) => {
  const mine = permsOf(ctx).includes("hr.self") ? await att.requireOwnEmployee(/** @type {string} */ (ctx.uid)).catch(() => null) : null;
  if (ctx.data.employeeId && ctx.data.employeeId !== mine?.id) {
    need(ctx, "hr.advances.manage");
    const e = await hr.employees().doc(ctx.data.employeeId).get();
    if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
    return pay.requestAdvance(ctx.data, actorOf(ctx), hr.plain(e));
  }
  if (!mine) throw new AppError("permission-denied", "Your sign-in isn't linked to an employee record.");
  return pay.requestAdvance(ctx.data, actorOf(ctx), mine);
});
export const decideAdvance = secureCallable("decideAdvance", { ...P("hr.advances.manage", 60), schema: S.decideAdvanceInput }, (ctx) => pay.decideAdvance(ctx.data, actorOf(ctx)));
export const disburseAdvance = secureCallable("disburseAdvance", { ...P("hr.advances.manage", 30), schema: S.disburseAdvanceInput }, (ctx) => pay.disburseAdvance(ctx.data, actorOf(ctx)));
export const cancelAdvance = secureCallable("cancelAdvance", { ...ANY(60), schema: S.advanceIdInput }, async (ctx) => {
  const canManage = permsOf(ctx).includes("hr.advances.manage");
  const mine = permsOf(ctx).includes("hr.self") ? await att.requireOwnEmployee(/** @type {string} */ (ctx.uid)).catch(() => null) : null;
  if (!canManage && !mine) throw new AppError("permission-denied", "You don't have permission to do this.");
  return pay.cancelAdvance(ctx.data, actorOf(ctx), { canManage, employeeId: mine?.id ?? null });
});
export const listAdvances = secureCallable("listAdvances", { ...P("hr.salary.read"), schema: S.advanceListInput }, (ctx) => pay.listAdvances(ctx.data));
export const myAdvances = secureCallable("myAdvances", { ...ANY(), schema: S.advanceListInput }, async (ctx) => pay.listAdvances({ ...ctx.data, employeeId: (await own(ctx)).id }));
export const saveCommissionRule = secureCallable("saveCommissionRule", { ...P("hr.manage", 60), schema: S.saveCommissionRuleInput }, (ctx) => pay.saveCommissionRule(ctx.data, actorOf(ctx)));
export const setCommissionRuleActive = secureCallable("setCommissionRuleActive", { ...P("hr.manage", 60), schema: S.commissionActiveInput }, (ctx) => pay.setCommissionRuleActive(ctx.data, actorOf(ctx)));
export const listCommissionRules = secureCallable("listCommissionRules", { ...P("hr.salary.read"), schema: S.hrEmptyInput }, () => pay.listCommissionRules());

/* ───────── Payroll ───────── */
export const generatePayroll = secureCallable("generatePayroll", { ...P("hr.payroll.generate", 30), schema: S.generatePayrollInput }, (ctx) => pay.generatePayroll(ctx.data, actorOf(ctx)));
export const addPayrollAdjustment = secureCallable("addPayrollAdjustment", { ...P("hr.payroll.generate", 120), schema: S.payrollAdjustInput }, (ctx) => pay.addAdjustment(ctx.data, actorOf(ctx)));
export const deletePayrollAdjustment = secureCallable("deletePayrollAdjustment", { ...P("hr.payroll.generate", 120), schema: S.payrollAdjustDeleteInput }, (ctx) => pay.deleteAdjustment(ctx.data, actorOf(ctx)));
export const listPayrollAdjustments = secureCallable("listPayrollAdjustments", { ...P("hr.salary.read"), schema: S.monthInput }, (ctx) => pay.listAdjustments(ctx.data));
export const approvePayroll = secureCallable("approvePayroll", { ...P("hr.payroll.approve", 20), schema: S.approvePayrollInput }, (ctx) => pay.approvePayroll(ctx.data, actorOf(ctx)));
export const reversePayroll = secureCallable("reversePayroll", { ...P("hr.payroll.approve", 20), schema: S.reversePayrollInput }, (ctx) => pay.reversePayroll(ctx.data, actorOf(ctx)));
export const paySalaries = secureCallable("paySalaries", { ...P("hr.payroll.pay", 60), schema: S.paySalariesInput }, (ctx) => pay.paySalaries(ctx.data, actorOf(ctx)));
export const voidSalaryPayment = secureCallable("voidSalaryPayment", { ...P("hr.payroll.pay", 30), schema: S.voidSalaryPaymentInput }, (ctx) => pay.voidSalaryPayment(ctx.data, actorOf(ctx)));
export const payrollRun = secureCallable("payrollRun", { ...P("hr.salary.read"), schema: S.monthInput }, (ctx) => pay.payrollRun(ctx.data));
export const listPayrollRuns = secureCallable("listPayrollRuns", { ...P("hr.salary.read"), schema: S.hrEmptyInput }, () => pay.listPayrollRuns());
export const getPayslip = secureCallable("getPayslip", { ...ANY(), schema: S.payslipInput }, async (ctx) => {
  if (permsOf(ctx).includes("hr.salary.read") && ctx.data.employeeId) {
    await writeAudit({ actorUid: ctx.uid, action: "hr.payslip_viewed", entityType: "payslip", entityId: `${ctx.data.month}__${ctx.data.employeeId}`, changes: {} });
    return pay.payslip({ month: ctx.data.month, employeeId: ctx.data.employeeId }, { ownOnly: false });
  }
  const e = await own(ctx);
  return pay.payslip({ month: ctx.data.month, employeeId: e.id }, { ownOnly: true });
});
export const myPayslips = secureCallable("myPayslips", { ...ANY(), schema: S.myPayslipsInput }, async (ctx) => pay.myPayslips((await own(ctx)).id, ctx.data.limit));
export const hrAccountStatus = secureCallable("hrAccountStatus", { ...P("hr.salary.read"), schema: S.hrEmptyInput }, () => pay.hrAccountStatus());
export const setupHrAccounts = secureCallable("setupHrAccounts", { ...P("accounting.manage", 10), schema: S.hrEmptyInput }, (ctx) => pay.ensureHrAccounts(actorOf(ctx)));

/* ───────── Dashboard, reports, exports ───────── */
export const hrDashboard = secureCallable("hrDashboard", { ...P("hr.read", 120), schema: S.hrEmptyInput }, (ctx) => rep.hrDashboard(permsOf(ctx)));
export const hrReport = secureCallable("hrReport", { ...ANY(90), schema: S.hrReportInput }, async (ctx) => {
  const r = await rep.hrReport(ctx.data, permsOf(ctx));
  if (/^(payroll_summary|salary_history|advances|commission)$/.test(ctx.data.report)) await writeAudit({ actorUid: ctx.uid, action: "hr.report_run", entityType: "hr", entityId: ctx.data.report, changes: { from: ctx.data.from, to: ctx.data.to } });
  return { ...r, report: ctx.data.report, generatedAt: new Date().toISOString() };
});
/** Called just before a file is produced in the browser: re-checks permissions and records who exported what. */
export const hrExport = secureCallable("hrExport", { ...P("hr.export", 60), schema: S.hrExportInput }, async (ctx) => {
  const ok = ctx.data.report === "payslip" ? permsOf(ctx).includes("hr.salary.read") : canRunHrReport(ctx.data.report, permsOf(ctx));
  if (!ok) throw new AppError("permission-denied", "You don't have permission to export this report.");
  await writeAudit({ actorUid: ctx.uid, action: "hr.exported", entityType: "hr", entityId: ctx.data.report, changes: { format: ctx.data.format, from: ctx.data.from, to: ctx.data.to } });
  return { ok: true, title: HR_REPORT_LABEL[ctx.data.report] ?? "Payslip" };
});
