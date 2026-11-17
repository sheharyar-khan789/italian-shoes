/** HR reports with date filters; CSV, Excel and print / PDF exports (permission-checked and audited on the server). */
import { esc } from "../../lib/format.js";
import { HR_REPORT_LABEL, canRunHrReport } from "../../../shared/hr.js";
import { errorState } from "../ui/kit.js";
import { call } from "../hrUi.js";
import { PRESETS, presetDates, showReport, exportButtons, wireExports, messageOf } from "../analyticsUi.js";

export default async function hrReports({ main, user }) {
  const runnable = Object.entries(HR_REPORT_LABEL).filter(([k]) => canRunHrReport(k, user.perms));
  if (!runnable.length) {
    main.innerHTML = `<div class="adm-page">${errorState("Your role can't run HR reports.")}</div>`;
    return;
  }
  const q = new URLSearchParams(location.search);
  const start = runnable.some(([k]) => k === q.get("report")) ? /** @type {string} */ (q.get("report")) : runnable[0][0];
  const d0 = presetDates("month");
  /** @type {any[]} */
  let people = [];
  if (user.perms.includes("hr.read")) people = await call("listEmployees", { status: "all", limit: 200 }).then((r) => r.employees).catch(() => []);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">HR <em>reports</em></h1><p class="muted">Worked out from your real HR records. Salary reports need salary access, and every export is recorded.</p></header>
      <form class="adm-filters an-filters" data-form novalidate>
        <div class="field"><label for="hr-report">Report</label><select id="hr-report">${runnable.map(([k, l]) => `<option value="${k}" ${k === start ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
        <div class="field"><label for="hr-preset">Period</label><select id="hr-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === "month" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="hr-from">From</label><input id="hr-from" type="date" value="${d0.from}" /></div>
        <div class="field"><label for="hr-to">To</label><input id="hr-to" type="date" value="${d0.to}" /></div>
        <div class="field"><label for="hr-emp">Employee (optional; needed for salary history)</label><select id="hr-emp"><option value="">All</option>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === q.get("employee") ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
        <button type="submit" class="btn btn--primary"><span>Show report</span></button>
      </form>
      ${exportButtons(user.perms, "hr.export")}
      <div data-out><p class="muted">Choose a report and press “Show report”.</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLInputElement} */ (main.querySelector(s));
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  /** @type {any} */
  let current = null;
  $("#hr-preset").addEventListener("change", (e) => {
    const r = presetDates(/** @type {HTMLSelectElement} */ (e.target).value);
    if (!r) return;
    $("#hr-from").value = r.from;
    $("#hr-to").value = r.to;
  });
  main.querySelector("[data-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = $("#hr-from").value;
    const to = $("#hr-to").value;
    if (!from || !to || to < from) return void (out.innerHTML = errorState("Choose a valid start and end date."));
    out.innerHTML = `<p class="muted">Calculating…</p>`;
    const exp = main.querySelector("[data-exports]");
    if (exp) /** @type {HTMLElement} */ (exp).hidden = true;
    try {
      current = await call("hrReport", { report: $("#hr-report").value, from, to, ...($("#hr-emp").value ? { employeeId: $("#hr-emp").value } : {}) });
      if (!alive()) return;
      out.innerHTML = `<h2 class="adm-h2">${esc(current.title)}</h2><p class="muted">${esc(current.from)} to ${esc(current.to)}</p><div data-body></div>`;
      showReport(/** @type {HTMLElement} */ (out.querySelector("[data-body]")), current);
      if (exp) /** @type {HTMLElement} */ (exp).hidden = false;
    } catch (err) {
      if (alive()) out.innerHTML = errorState(messageOf(err));
    }
  });
  wireExports(main, () => current, "hrExport");
}
