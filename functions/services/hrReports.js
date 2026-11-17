/**
 * The HR dashboard and the HR reports. Everything is read from the real HR records (employees, attendance, leave, payslips, advances, sales);
 * nothing is typed in or estimated. Salary figures need hr.salary.read; a report needs ALL of the permissions listed for it in shared/hr.js.
 * Reports come back in the same shape as the analytics reports: { title, from, to, tables: [{ title, columns, rows, totals }], notes }.
 */
import { db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { pktDateKey } from "../shared/accounting.js";
import { daysBetween } from "../shared/finance.js";
import { ATTENDANCE_STATUS, LEAVE_STATUS, ADVANCE_STATUS, EMPLOYEE_STATUS, HR_REPORT_LABEL, canRunHrReport, monthRange } from "../shared/hr.js";
import { employees, secure, plain } from "./hr.js";
import { summarize, monthlyAttendance } from "./hrAttendance.js";
import { inRange, col, table, sum, pct } from "./analyticsData.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";

const MAX = 10000;

/* ───────── Dashboard ───────── */

/** @param {string[]} perms */
export async function hrDashboard(perms) {
  const today = pktDateKey(new Date());
  const month = today.slice(0, 7);
  const money = perms.includes("hr.salary.read");
  const [emps, att, pending, run, approvedSlips, draftRuns, shifts] = await Promise.all([
    employees().limit(1001).get(),
    db.collection("attendance").where("date", "==", today).get(),
    db.collection("leaveRequests").where("status", "==", "pending").count().get(),
    money ? db.collection("payrollRuns").doc(month).get() : null,
    money ? db.collection("payslips").where("status", "==", "approved").limit(2000).get() : null,
    money ? db.collection("payrollRuns").where("status", "==", "draft").count().get() : null,
    db.collection("shifts").limit(100).get(),
  ]);
  const all = emps.docs.map(plain);
  const active = all.filter((e) => e.status === "active" && e.joiningDate <= today);
  const rows = att.docs.map((d) => d.data());
  const s = summarize(rows);
  const marked = new Set(rows.map((r) => r.employeeId));
  const shiftDays = new Map(shifts.docs.map((d) => [d.id, d.data().workingDays]));
  const hol = (await db.collection("holidays").doc(today).get()).exists;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const expectedToday = hol ? [] : active.filter((e) => (shiftDays.get(e.shiftId) ?? [1, 2, 3, 4, 5, 6]).includes(dow));
  return {
    today,
    totalEmployees: all.length,
    activeEmployees: active.length,
    presentToday: s.present + s.late + s.half_day,
    absentToday: s.absent,
    onLeaveToday: s.leave,
    lateToday: s.late,
    notMarkedToday: expectedToday.filter((e) => !marked.has(e.id)).length,
    pendingLeave: pending.data().count,
    holidayToday: hol,
    payrollMonth: month,
    payrollStatus: money ? (run?.data()?.status ?? "not generated") : null,
    payrollNet: money ? (run?.data()?.totals?.net ?? 0) : null,
    outstandingSalary: money ? sum((approvedSlips?.docs ?? []).map((d) => d.data()), "net") : null,
    pendingPayrollApprovals: money ? (draftRuns?.data().count ?? 0) : null,
  };
}

/* ───────── Reports ───────── */

const monthsIn = (from, to) => {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
    out.push(m);
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return out;
};

/** @param {Record<string, any>} input validated hrReportInput @param {string[]} perms */
export async function hrReport({ report, from, to, employeeId }, perms) {
  if (!canRunHrReport(report, perms)) throw new AppError("permission-denied", "You don't have permission to run this report.");
  const money = "money";
  const num = "number";
  const attendanceIn = async () => {
    const snap = await db.collection("attendance").where("date", ">=", from).where("date", "<=", to).orderBy("date").limit(MAX + 1).get();
    if (snap.size > MAX) throw new AppError("failed-precondition", "That range has too many attendance records. Choose a shorter range.");
    return snap.docs.map((d) => d.data()).filter((r) => !employeeId || r.employeeId === employeeId);
  };

  if (report === "directory") {
    const snap = await employees().limit(1001).get();
    const emps = snap.docs.map(plain).sort((a, b) => a.nameLower.localeCompare(b.nameLower));
    const names = new Map(emps.map((e) => [e.id, e.name]));
    const secs = perms.includes("hr.salary.read") && emps.length ? await db.getAll(...emps.map((e) => secure().doc(e.id))) : [];
    const rows = emps.map((e, i) => ({ no: e.employeeNo, name: e.name, designation: e.designation ?? "", department: e.department ?? "", type: e.employmentType ?? "", phone: e.phone, email: e.email ?? "", joined: e.joiningDate, status: EMPLOYEE_STATUS[e.status] ?? e.status, manager: names.get(e.managerId) ?? "", ...(secs.length ? { basic: secs[i]?.data()?.basicSalary ?? 0 } : {}) }));
    return { title: "Employee directory", from, to, tables: [table("Employees", [col("no", "ID"), col("name", "Name"), col("designation", "Designation"), col("department", "Department"), col("type", "Type"), col("phone", "Phone"), col("email", "Email"), col("joined", "Joined"), col("status", "Status"), col("manager", "Reports to"), ...(secs.length ? [col("basic", "Basic salary", money)] : [])], rows, null)], notes: ["CNIC numbers and documents are never part of this report."] };
  }

  if (report === "attendance_daily") {
    const recs = await attendanceIn();
    if (daysBetween(from, to).length > 93) throw new AppError("failed-precondition", "Choose at most about three months.");
    const byDay = new Map();
    for (const r of recs) (byDay.get(r.date) ?? byDay.set(r.date, []).get(r.date)).push(r);
    const dayRows = daysBetween(from, to).map((date) => ({ date, ...(({ present, late, half_day, absent, leave, weekly_off, holiday }) => ({ present, late, half_day, absent, leave, weekly_off, holiday }))(summarize(byDay.get(date) ?? [])) }));
    const detail = recs.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName)).slice(0, 2000).map((r) => ({ date: r.date, no: r.employeeNo, name: r.employeeName, status: ATTENDANCE_STATUS[r.status] ?? r.status, in: r.checkIn || "—", out: r.checkOut || "—", late: r.lateMinutes ?? 0, overtime: r.overtimeMinutes ?? 0, note: r.note ?? "" }));
    const cols = ["present", "late", "half_day", "absent", "leave", "weekly_off", "holiday"];
    return { title: "Daily attendance report", from, to, tables: [table("By day", [col("date", "Date"), ...cols.map((c) => col(c, ATTENDANCE_STATUS[c], num))], dayRows, { date: "Total", ...Object.fromEntries(cols.map((c) => [c, sum(dayRows, c)])) }), table("Records", [col("date", "Date"), col("no", "ID"), col("name", "Employee"), col("status", "Status"), col("in", "In"), col("out", "Out"), col("late", "Late (min)", num), col("overtime", "Overtime (min)", num), col("note", "Note")], detail)], notes: ["Days with no record are not counted: an employee who was never marked is not shown as absent."] };
  }

  if (report === "attendance_monthly") {
    const month = from.slice(0, 7);
    const m = await monthlyAttendance({ month });
    const rows = m.rows.filter((r) => !employeeId || r.employeeId === employeeId).map((r) => ({ no: r.employeeNo, name: r.name, present: r.present, late: r.late, half: r.half_day, absent: r.absent, leave: r.leave, off: r.weekly_off, holiday: r.holiday, lateMin: r.lateMinutes, otMin: r.overtimeMinutes, hours: Math.round((r.workedMinutes / 60) * 10) / 10 }));
    return { title: `Monthly attendance report — ${month}`, from: monthRange(month).from, to: monthRange(month).to, tables: [table("By employee", [col("no", "ID"), col("name", "Employee"), col("present", "Present", num), col("late", "Late", num), col("half", "Half-day", num), col("absent", "Absent", num), col("leave", "Leave", num), col("off", "Weekly off", num), col("holiday", "Holiday", num), col("lateMin", "Late (min)", num), col("otMin", "Overtime (min)", num), col("hours", "Hours worked", num)], rows, null)], notes: ["Uses the month of the start date. Hours are worked only for days with both arrival and departure times."] };
  }

  if (report === "late") {
    const recs = (await attendanceIn()).filter((r) => (r.lateMinutes ?? 0) > 0);
    const by = new Map();
    for (const r of recs) {
      const x = by.get(r.employeeId) ?? { no: r.employeeNo, name: r.employeeName, times: 0, minutes: 0 };
      x.times += 1;
      x.minutes += r.lateMinutes;
      by.set(r.employeeId, x);
    }
    const sorted = [...by.values()].sort((a, b) => b.times - a.times);
    return { title: "Late arrival report", from, to, tables: [table("By employee", [col("no", "ID"), col("name", "Employee"), col("times", "Times late", num), col("minutes", "Minutes late", num)], sorted, { no: "", name: "Total", times: sum(sorted, "times"), minutes: sum(sorted, "minutes") }), table("Each late arrival", [col("date", "Date"), col("name", "Employee"), col("shift", "Shift start"), col("in", "Arrived"), col("late", "Late (min)", num)], recs.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, name: r.employeeName, shift: r.shift?.start ?? "—", in: r.checkIn, late: r.lateMinutes })))], notes: ["Late = minutes after the shift start, beyond the shift's grace period."] };
  }

  if (report === "overtime") {
    const recs = (await attendanceIn()).filter((r) => (r.overtimeMinutes ?? 0) > 0);
    const by = new Map();
    for (const r of recs) {
      const x = by.get(r.employeeId) ?? { no: r.employeeNo, name: r.employeeName, days: 0, minutes: 0 };
      x.days += 1;
      x.minutes += r.overtimeMinutes;
      by.set(r.employeeId, x);
    }
    const rows = [...by.values()].map((x) => ({ ...x, hours: Math.round((x.minutes / 60) * 10) / 10 })).sort((a, b) => b.minutes - a.minutes);
    return { title: "Overtime report", from, to, tables: [table("By employee", [col("no", "ID"), col("name", "Employee"), col("days", "Days", num), col("hours", "Overtime hours", num)], rows, { no: "", name: "Total", days: sum(rows, "days"), hours: Math.round((sum(rows, "minutes") / 60) * 10) / 10 })], notes: ["Overtime = time after the shift end, counted from the minimum set in HR settings. The amount paid is in the payslips."] };
  }

  if (report === "leave") {
    const snap = await db.collection("leaveRequests").limit(2000).get();
    const rows = snap.docs.map(plain).filter((r) => r.from <= to && r.to >= from && (!employeeId || r.employeeId === employeeId)).sort((a, b) => a.from.localeCompare(b.from)).map((r) => ({ no: r.employeeNo, name: r.employeeName, type: r.typeName, from: r.from, to: r.to, days: r.days, paid: r.paid ? "Paid" : "Unpaid", status: LEAVE_STATUS[r.status] ?? r.status, reason: r.reason }));
    return { title: "Leave report", from, to, tables: [table("Leave requests overlapping the period", [col("no", "ID"), col("name", "Employee"), col("type", "Type"), col("from", "From"), col("to", "To"), col("days", "Days", num), col("paid", "Paid"), col("status", "Status"), col("reason", "Reason")], rows, { no: "", name: "Approved days", type: "", from: "", to: "", days: sum(rows.filter((r) => r.status === "Approved"), "days"), paid: "", status: "", reason: "" })], notes: [] };
  }

  if (report === "payroll_summary") {
    const months = monthsIn(from, to);
    if (months.length > 24) throw new AppError("failed-precondition", "Choose at most two years.");
    const runs = await db.getAll(...months.map((m) => db.collection("payrollRuns").doc(m)));
    const rows = runs.filter((r) => r.exists).map((r) => ({ month: r.id, status: r.data()?.status, employees: r.data()?.employees ?? 0, gross: r.data()?.totals?.gross ?? 0, deductions: r.data()?.totals?.deductions ?? 0, net: r.data()?.totals?.net ?? 0, paid: r.data()?.paidCount ?? 0, journal: r.data()?.journal?.number ?? "—" }));
    const tables = [table("By month", [col("month", "Month"), col("status", "Status"), col("employees", "Employees", num), col("gross", "Gross pay", money), col("deductions", "Deductions", money), col("net", "Net pay", money), col("paid", "Paid", num), col("journal", "Journal")], rows, { month: "Total", status: "", employees: null, gross: sum(rows, "gross"), deductions: sum(rows, "deductions"), net: sum(rows, "net"), paid: null, journal: "" })];
    if (months.length === 1) {
      const slips = await db.collection("payslips").where("month", "==", months[0]).limit(500).get();
      tables.push(table(`Payslips — ${months[0]}`, [col("no", "ID"), col("name", "Employee"), col("basic", "Basic", money), col("allow", "Allowances", money), col("ot", "Overtime", money), col("bonus", "Bonuses", money), col("comm", "Commission", money), col("ded", "Deductions", money), col("net", "Net pay", money), col("status", "Status")], slips.docs.map(plain).sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ no: s.employeeNo, name: s.name, basic: s.calc.basic, allow: s.calc.allowances, ot: s.calc.overtime, bonus: s.calc.bonuses, comm: s.calc.commissions, ded: s.calc.deductions, net: s.calc.net, status: s.status })), null));
    }
    return { title: "Payroll summary", from, to, tables, notes: ["Gross pay = basic + allowances + overtime + bonuses + commissions. Net pay = gross − deductions. Approved payrolls are posted to the accounts (the journal number is shown)."] };
  }

  if (report === "salary_history") {
    if (!employeeId) throw new AppError("invalid-argument", "Choose an employee.", { fields: { employeeId: "Required" } });
    const [e, snap, hist] = await Promise.all([employees().doc(employeeId).get(), db.collection("payslips").where("employeeId", "==", employeeId).limit(60).get(), db.collection("employeeHistory").where("employeeId", "==", employeeId).orderBy("at", "desc").limit(100).get()]);
    if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
    const rows = snap.docs.map(plain).filter((s) => s.month >= from.slice(0, 7) && s.month <= to.slice(0, 7) && ["approved", "paid"].includes(s.status)).sort((a, b) => a.month.localeCompare(b.month)).map((s) => ({ month: s.month, basic: s.calc.basic, allow: s.calc.allowances, ot: s.calc.overtime, bonus: s.calc.bonuses, comm: s.calc.commissions, ded: s.calc.deductions, net: s.calc.net, status: s.status, paid: s.payment?.date ?? "—" }));
    const changes = hist.docs.map(plain).filter((h) => h.kind === "pay").map((h) => ({ at: h.at?.toDate?.().toISOString().slice(0, 10) ?? "", by: h.byName ?? "", what: h.summary }));
    return { title: `Salary history — ${e.data()?.name}`, from, to, tables: [table("Payslips (approved or paid)", [col("month", "Month"), col("basic", "Basic", money), col("allow", "Allowances", money), col("ot", "Overtime", money), col("bonus", "Bonuses", money), col("comm", "Commission", money), col("ded", "Deductions", money), col("net", "Net pay", money), col("status", "Status"), col("paid", "Paid on")], rows, { month: "Total", basic: sum(rows, "basic"), allow: sum(rows, "allow"), ot: sum(rows, "ot"), bonus: sum(rows, "bonus"), comm: sum(rows, "comm"), ded: sum(rows, "ded"), net: sum(rows, "net"), status: "", paid: "" }), table("Changes to salary terms", [col("at", "Date"), col("by", "By"), col("what", "Change")], changes)], notes: [] };
  }

  if (report === "advances") {
    const snap = await db.collection("employeeAdvances").limit(1000).get();
    const rows = snap.docs.map(plain).filter((a) => !employeeId || a.employeeId === employeeId).sort((a, b) => String(a.employeeName).localeCompare(b.employeeName)).map((a) => ({ no: a.employeeNo, name: a.employeeName, kind: a.kind === "loan" ? "Loan" : "Advance", amount: a.amount, months: a.months, repaid: a.repaid ?? 0, outstanding: a.status === "disbursed" ? a.amount - (a.repaid ?? 0) : 0, status: ADVANCE_STATUS[a.status] ?? a.status, paidOn: a.disbursement?.date ?? "—" }));
    return { title: "Advance and loan report", from, to, tables: [table("Advances and loans", [col("no", "ID"), col("name", "Employee"), col("kind", "Kind"), col("amount", "Amount", money), col("months", "Months", num), col("repaid", "Recovered", money), col("outstanding", "Outstanding", money), col("status", "Status"), col("paidOn", "Paid out")], rows, { no: "", name: "Total", kind: "", amount: sum(rows, "amount"), months: null, repaid: sum(rows, "repaid"), outstanding: sum(rows, "outstanding"), status: "", paidOn: "" })], notes: ["Outstanding = what has been paid out and not yet recovered from pay. It should equal the “Employee advances & loans” account in the books."] };
  }

  if (report === "commission") {
    const months = monthsIn(from, to);
    if (months.length > 24) throw new AppError("failed-precondition", "Choose at most two years.");
    const snaps = await Promise.all(months.map((m) => db.collection("payslips").where("month", "==", m).limit(500).get()));
    const rows = snaps.flatMap((s) => s.docs.map(plain)).filter((s) => (s.calc.commissions > 0 || s.salesNet > 0) && (!employeeId || s.employeeId === employeeId)).sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name)).map((s) => ({ month: s.month, no: s.employeeNo, name: s.name, sales: s.salesNet ?? 0, comm: s.calc.commissions, rules: (s.commissionLines ?? []).map((l) => `${l.name} ${(l.amount / 100).toFixed(2)}`).join("; "), status: s.status }));
    return { title: "Commission report", from, to, tables: [table("Commission by month", [col("month", "Month"), col("no", "ID"), col("name", "Employee"), col("sales", "Net sales attributed", money), col("comm", "Commission", money), col("rules", "Rules applied"), col("status", "Payroll status")], rows, { month: "Total", no: "", name: "", sales: sum(rows, "sales"), comm: sum(rows, "comm"), rules: "", status: "" })], notes: ["Net sales are the POS sales rung up by the employee's linked sign-in, less refunds. Commission is worked out by the server from the saved rules; draft payslips show what a month would pay if approved now."] };
  }

  // performance
  const [recs, emps, sales] = await Promise.all([attendanceIn(), employees().limit(1001).get(), inRange("sales", from, to)]);
  const by = new Map();
  for (const e of emps.docs.map(plain).filter((x) => x.status === "active" || recsHas(recs, x.id))) by.set(e.id, { no: e.employeeNo, name: e.name, staffUid: e.staffUid, present: 0, late: 0, absent: 0, leave: 0, marked: 0, otMin: 0, sales: 0, orders: 0 });
  for (const r of recs) {
    const x = by.get(r.employeeId);
    if (!x) continue;
    x.marked += 1;
    if (r.status === "present") x.present += 1;
    if (r.status === "late") x.late += 1;
    if (r.status === "absent") x.absent += 1;
    if (r.status === "leave") x.leave += 1;
    x.otMin += r.overtimeMinutes ?? 0;
  }
  const byUid = new Map([...by.values()].filter((x) => x.staffUid).map((x) => [x.staffUid, x]));
  for (const s of sales) {
    if (UNCOUNTED_SALE_STATUSES.includes(s.status)) continue;
    const x = byUid.get(s.cashierUid);
    if (!x) continue;
    x.sales += Math.max(0, (s.netSales ?? 0) - Math.min(s.netSales ?? 0, s.refundedTotal ?? 0));
    x.orders += 1;
  }
  const rows = [...by.values()].filter((x) => !employeeId || [...by.entries()].some(([id, v]) => v === x && id === employeeId)).map((x) => ({ no: x.no, name: x.name, rate: pct(x.present + x.late, x.present + x.late + x.absent), late: x.late, absent: x.absent, leave: x.leave, ot: Math.round((x.otMin / 60) * 10) / 10, orders: x.orders, sales: x.sales, avg: x.orders ? Math.round(x.sales / x.orders) : 0 })).sort((a, b) => b.sales - a.sales);
  return { title: "Employee performance report", from, to, tables: [table("By employee", [col("no", "ID"), col("name", "Employee"), col("rate", "Attendance rate %", num), col("late", "Late", num), col("absent", "Absent", num), col("leave", "Leave", num), col("ot", "Overtime hours", num), col("orders", "POS sales", num), col("sales", "Net sales", money), col("avg", "Average sale", money)], rows, null)], notes: ["Attendance rate = present or late days ÷ (present, late and absent days). Sales are the POS sales rung up by the employee's linked sign-in. Only recorded days are counted."] };
}

const recsHas = (recs, id) => recs.some((r) => r.employeeId === id);

export const HR_LABELS = HR_REPORT_LABEL;
