/**
 * Report inbox and scheduled reports. Summaries are generated when they become due and someone opens this page (there is no background job and
 * nothing is emailed or messaged); recipients read them here. People who manage reports can add, switch off and run schedules.
 */
import { esc } from "../../lib/format.js";
import { SCHEDULE_REPORTS } from "../../../shared/analytics.js";
import { toast, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { formDialog, row, input, select } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { staffDirectory } from "../data.js";
import { showReport, messageOf } from "../analyticsUi.js";

export default async function analyticsSchedules({ main, user, params }) {
  const canManage = user.perms.includes("analytics.manage");
  if (params[0]) return viewRun(params[0]);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Report <em>inbox</em></h1><p class="muted">Scheduled summaries appear here when they are due. They are built from your real records the first time someone opens this page after the period ends; nothing is sent by email or message.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>Add a schedule</span></button> <button type="button" class="btn btn--ghost" data-run>Run due reports now</button></p>` : ""}</header>
      <h2 class="adm-h2">Your reports</h2><div data-inbox><p class="muted">Loading…</p></div>
      ${canManage ? `<h2 class="adm-h2">Schedules</h2><div data-schedules><p class="muted">Loading…</p></div>` : ""}
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-inbox]") !== null;
  const inbox = /** @type {HTMLElement} */ (main.querySelector("[data-inbox]"));
  const sched = /** @type {HTMLElement | null} */ (main.querySelector("[data-schedules]"));

  async function drawInbox() {
    try {
      const r = await call("reportInbox", { limit: 20 });
      if (!alive()) return;
      inbox.innerHTML = r.runs.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Report</th><th>Period</th><th>Created</th></tr></thead><tbody>${r.runs.map((x) => `<tr><td data-label="Report"><a class="text-link" href="/admin/analytics-schedules/${esc(x.id)}" data-link><strong>${esc(x.scheduleName)}</strong></a><br /><span class="muted">${esc(x.reportLabel)}</span></td><td data-label="Period">${esc(x.from === x.to ? x.from : `${x.from} to ${x.to}`)}</td><td data-label="Created">${esc(formatWhen(x.createdAt))}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No reports yet", text: "When a schedule you receive becomes due, its summary appears here." });
    } catch (e) {
      if (alive()) inbox.innerHTML = errorState(messageOf(e));
    }
  }
  async function drawSchedules() {
    if (!sched) return;
    try {
      const r = await call("listReportSchedules", {});
      if (!alive()) return;
      sched.innerHTML = r.schedules.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Report</th><th>Runs</th><th>Recipients</th><th></th></tr></thead><tbody>${r.schedules.map((s) => `<tr><td data-label="Name">${esc(s.name)}${s.isActive === false ? ` <span class="tag tag--out">Off</span>` : ""}</td><td data-label="Report">${esc(SCHEDULE_REPORTS[s.report]?.label ?? s.report)}</td><td data-label="Runs">${esc(s.frequency)}</td><td data-label="Recipients">${s.recipientUids.length}</td><td><button type="button" class="text-btn" data-toggle="${esc(s.id)}" data-on="${s.isActive === false ? "1" : "0"}">${s.isActive === false ? "Switch on" : "Switch off"}</button></td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No schedules yet", text: "Add one to receive a daily, weekly or monthly summary here." });
      sched.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
        try {
          await call("setReportScheduleActive", { id: /** @type {HTMLElement} */ (b).dataset.toggle, isActive: /** @type {HTMLElement} */ (b).dataset.on === "1" });
          drawSchedules();
        } catch (e) {
          toast(messageOf(e), "error");
        }
      }));
    } catch (e) {
      if (alive()) sched.innerHTML = errorState(messageOf(e));
    }
  }

  main.querySelector("[data-run]")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    try {
      const r = await call("runScheduledReports", {});
      toast(r.created ? `${r.created} report${r.created === 1 ? "" : "s"} created.` : "Nothing was due.");
      if (r.failed?.length) toast(`${r.failed.length} couldn't be built: ${r.failed[0].reason}`, "error");
    } catch (err) {
      toast(messageOf(err), "error");
    }
    btn.disabled = false;
    drawInbox();
  });
  main.querySelector("[data-new]")?.addEventListener("click", async () => {
    const list = (await call("listReportSchedules", {}).catch(() => ({ reports: Object.entries(SCHEDULE_REPORTS).map(([key, v]) => ({ key, label: v.label, frequency: v.frequency })) }))).reports.filter((r) => SCHEDULE_REPORTS[r.key].perms.every((p) => user.perms.includes(p)));
    /** @type {Record<string, string>} */
    const staff = await staffDirectory().catch(() => ({}));
    staff[user.uid] ??= "Me";
    formDialog({
      title: "Add a scheduled report",
      body: `${row("report", "Report", select("report", list.map((r) => [r.key, `${r.label} (${r.frequency})`]), list[0]?.key))}${row("name", "Name", input("name", 'maxlength="60"'))}<fieldset class="field"><legend>Who should receive it</legend>${Object.entries(staff).map(([uid, name]) => `<label class="check"><input type="checkbox" name="rcpt" value="${esc(uid)}" ${uid === user.uid ? "checked" : ""} /> ${esc(name)}</label>`).join(" ")}<p class="field-hint">Recipients read it in their report inbox, and only if their role may see that report.</p></fieldset>`,
      submit: "Add schedule",
      async onSubmit(form, { show, close }) {
        const f = /** @type {any} */ (form.elements);
        const rec = [...form.querySelectorAll('[name="rcpt"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value);
        const pick = list.find((r) => r.key === f.report.value);
        if (!pick) return show("Choose a report.");
        if (f.name.value.trim().length < 2) return show("Give it a name.", { name: "Required" });
        if (!rec.length) return show("Choose at least one recipient.");
        await call("saveReportSchedule", { report: pick.key, name: f.name.value.trim(), frequency: pick.frequency, recipientUids: rec, isActive: true });
        close();
        toast("Schedule added.");
        drawSchedules();
      },
    });
  });
  await Promise.all([drawInbox(), drawSchedules()]);

  async function viewRun(id) {
    main.innerHTML = `<div class="adm-page"><p><a class="text-link" href="/admin/analytics-schedules" data-link>← Report inbox</a></p><div data-run-out><p class="muted">Loading…</p></div></div>`;
    const el = /** @type {HTMLElement} */ (main.querySelector("[data-run-out]"));
    try {
      const r = await call("reportRun", { id });
      const report = { title: `${r.scheduleName}: ${r.reportLabel}`, from: r.from, to: r.to, tables: r.tables, notes: r.notes, estimates: [], report: "scheduled" };
      el.innerHTML = `<h1 class="adm-h1">${esc(r.scheduleName)}</h1><p class="muted">${esc(r.reportLabel)} · ${esc(r.from === r.to ? r.from : `${r.from} to ${r.to}`)} · created ${esc(formatWhen(r.createdAt))}</p><div data-body></div>`;
      showReport(/** @type {HTMLElement} */ (el.querySelector("[data-body]")), report);
    } catch (e) {
      el.innerHTML = errorState(messageOf(e));
    }
  }
}
