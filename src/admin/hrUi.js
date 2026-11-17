/** Shared helpers for the HR screens: server calls, month and date inputs, status tags, file upload, and printing a payslip. */
import { esc } from "../lib/format.js";
import { uploadPrivate } from "./privateFileUi.js";
import { ATTENDANCE_STATUS, LEAVE_STATUS, ADVANCE_STATUS, PAYROLL_STATUS, EMPLOYEE_STATUS, SALARY_METHODS } from "../../shared/hr.js";
import { toPrintHtml } from "../../shared/reportFormat.js";
import { call, getRow } from "./purchData.js";
import { messageOf, todayKey } from "./financeUi.js";

export { call, messageOf, todayKey };

export const thisMonth = () => todayKey().slice(0, 7);
export const addMonths = (month, n) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const METHOD_NAME = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
export const methodOptions = SALARY_METHODS.map((m) => [m, METHOD_NAME[m]]);

const TONE = { present: "", late: "tag--low", half_day: "tag--low", absent: "tag--out", leave: "", weekly_off: "", holiday: "", pending: "tag--low", approved: "", rejected: "tag--out", cancelled: "tag--out", requested: "tag--low", disbursed: "", closed: "", draft: "tag--low", paid: "", reversed: "tag--out", active: "", inactive: "tag--out", terminated: "tag--out" };
const LABELS = { ...ATTENDANCE_STATUS, ...LEAVE_STATUS, ...ADVANCE_STATUS, ...PAYROLL_STATUS, ...EMPLOYEE_STATUS };
/** A small coloured status tag. @param {string} key */
export const statusTag = (key) => `<span class="tag ${TONE[key] ?? ""}">${esc(LABELS[key] ?? key)}</span>`;

/** Upload an employee document (folder "hr") or photo (folder "hrphoto"): PDF / image, up to 5 MB, to the PRIVATE store. `url` is a private path. @param {File} file @param {"hr" | "hrphoto"} [folder] */
export const uploadHrFile = (file, folder = "hr") => uploadPrivate(folder, file);

/** A payslip as a printable report (the same shape every report uses). @param {Record<string, any>} p a payslip from the server */
export function payslipReport(p) {
  const c = p.calc;
  const col = [{ key: "item", label: "Item", type: "text" }, { key: "amount", label: "Amount", type: "money" }];
  const lines = (list) => (list ?? []).map((x) => ({ item: x.name ?? x.label, amount: x.amount }));
  const earnings = [{ item: "Basic salary", amount: c.basic }, ...lines(p.allowanceLines), ...(c.overtime ? [{ item: "Overtime", amount: c.overtime }] : []), ...lines(p.bonusLines), ...lines(p.commissionLines)];
  const deductions = [...(c.absentDeduction ? [{ item: "Absent days", amount: c.absentDeduction }] : []), ...(c.halfDeduction ? [{ item: "Half days", amount: c.halfDeduction }] : []), ...(c.lateDeduction ? [{ item: "Late arrivals", amount: c.lateDeduction }] : []), ...(c.notEmployedDeduction ? [{ item: "Days not employed", amount: c.notEmployedDeduction }] : []), ...(c.leaveDeduction ? [{ item: "Unpaid leave", amount: c.leaveDeduction }] : []), ...(c.advances ?? []).filter((a) => a.amount > 0).map((a) => ({ item: a.label, amount: a.amount })), ...lines(p.deductionLines)];
  const a = p.attendance ?? {};
  return {
    title: `Payslip — ${p.name} — ${p.month}`,
    report: "payslip",
    from: `${p.month}-01`,
    to: `${p.month}-28`,
    tables: [
      { title: `${p.name} (${p.employeeNo}) · ${p.designation || "—"}${p.department ? ` · ${p.department}` : ""}`, columns: [{ key: "item", label: "Attendance", type: "text" }, { key: "value", label: "Days / minutes", type: "mixed" }], rows: [{ item: "Present days", value: a.presentDays ?? 0 }, { item: "Absent days", value: a.absentDays ?? 0 }, { item: "Half days", value: a.halfDays ?? 0 }, { item: "Late arrivals", value: a.lateCount ?? 0 }, { item: "Days on leave", value: a.leaveDays ?? 0 }, { item: "Overtime minutes", value: a.overtimeMinutes ?? 0 }], totals: null },
      { title: "Earnings", columns: col, rows: earnings, totals: { item: "Gross pay", amount: c.gross } },
      { title: "Deductions", columns: col, rows: deductions, totals: { item: "Total deductions", amount: c.deductions } },
      { title: "Net salary", columns: col, rows: [{ item: "Net payable (gross − deductions)", amount: c.net }], totals: null },
    ],
    notes: [p.payment ? `Paid on ${p.payment.date} by ${METHOD_NAME[p.payment.method] ?? p.payment.method}${p.payment.reference ? `, reference ${p.payment.reference}` : ""}.` : `Status: ${PAYROLL_STATUS[p.status] ?? p.status}.`, "This payslip was calculated by the system from the recorded attendance, leave and pay terms."],
    estimates: [],
  };
}

/** Print a report in a new window without a server round trip (people printing THEIR OWN payslip). @param {any} report */
export async function printLocal(report) {
  const s = await getRow("settings", "public").catch(() => null);
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return "Your browser blocked the print window. Allow pop-ups for this site and try again.";
  w.document.write(toPrintHtml(report, { businessName: s?.storeName ?? "", logoUrl: s?.logoUrl ?? "" }));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
  return "";
}
