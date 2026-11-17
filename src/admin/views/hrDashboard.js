/** HR dashboard: today's attendance, leave waiting, and (for those who may see money) this month's payroll. Every number is read from the records. */
import { esc } from "../../lib/format.js";
import { statCard, errorState } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call, messageOf } from "../hrUi.js";

export default async function hrDashboard({ main }) {
  main.innerHTML = `<div class="adm-page"><header class="adm-page__head"><h1 class="adm-h1">HR <em>dashboard</em></h1><p class="muted">People, attendance, leave and payroll at a glance.</p></header><div data-out><p class="muted">Loading…</p></div></div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  async function show() {
    try {
      const d = await call("hrDashboard", {});
      if (!alive()) return;
      out.innerHTML = `
        <h2 class="adm-h2">People</h2>
        <div class="adm-stats">${statCard({ label: "Total employees", value: d.totalEmployees, href: "/admin/hr-employees" })}${statCard({ label: "Active employees", value: d.activeEmployees })}</div>
        <h2 class="adm-h2">Today <span class="muted">${esc(d.today)}${d.holidayToday ? " · holiday" : ""}</span></h2>
        <div class="adm-stats">${statCard({ label: "Present", value: d.presentToday, href: "/admin/hr-attendance" })}${statCard({ label: "Absent", value: d.absentToday })}${statCard({ label: "On leave", value: d.onLeaveToday })}${statCard({ label: "Late arrivals", value: d.lateToday })}${statCard({ label: "Not marked yet", value: d.notMarkedToday, note: "expected to work today" })}</div>
        <h2 class="adm-h2">Waiting for a decision</h2>
        <div class="adm-stats">${statCard({ label: "Pending leave applications", value: d.pendingLeave, href: "/admin/hr-leave" })}${d.pendingPayrollApprovals === null ? "" : statCard({ label: "Pending payroll approvals", value: d.pendingPayrollApprovals, href: "/admin/hr-payroll" })}</div>
        ${d.payrollStatus === null ? "" : `<h2 class="adm-h2">Payroll <span class="muted">${esc(d.payrollMonth)}</span></h2><div class="adm-stats">${statCard({ label: "This month's payroll", value: money(d.payrollNet), note: d.payrollStatus === "not generated" ? "not generated yet" : d.payrollStatus, href: "/admin/hr-payroll" })}${statCard({ label: "Outstanding salary payments", value: money(d.outstandingSalary), note: "approved, not yet paid" })}</div>`}`;
    } catch (err) {
      if (alive()) {
        out.innerHTML = errorState(messageOf(err));
        out.querySelector("[data-retry]")?.addEventListener("click", show);
      }
    }
  }
  await show();
}
