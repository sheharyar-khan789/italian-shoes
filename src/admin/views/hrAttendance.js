/**
 * Attendance: the daily sheet (mark everyone for a day, or one person at a time), corrections with a reason, and the monthly summary.
 * One record per employee per day: someone already marked is shown, never overwritten; a change is a correction that keeps the old values.
 */
import { esc } from "../../lib/format.js";
import { ATTENDANCE_STATUS, MANUAL_STATUSES } from "../../../shared/hr.js";
import { toast, errorState, emptyState } from "../ui/kit.js";
import { formDialog, row, input, select } from "../ui/purchasing.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf, statusTag, todayKey, thisMonth } from "../hrUi.js";

const opts = (selected) => `<option value="">— choose —</option>${MANUAL_STATUSES.map((s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${ATTENDANCE_STATUS[s]}</option>`).join("")}`;

export default async function hrAttendance({ main, user }) {
  const canMark = user.perms.includes("hr.attendance");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Atten<em>dance</em></h1><p class="muted">Mark who came in, who was late and who was away. Each person has one record a day; to change one, make a correction (the old value and your reason are kept).</p></header>
      <div class="adm-tabs" role="tablist" aria-label="Attendance"><button type="button" role="tab" aria-selected="true" data-tab="0">Daily sheet</button><button type="button" role="tab" aria-selected="false" data-tab="1">Monthly summary</button></div>
      <div data-panel></div>
    </div>`;
  const panel = /** @type {HTMLElement} */ (main.querySelector("[data-panel]"));
  const alive = () => main.isConnected && main.querySelector("[data-panel]") !== null;
  let date = todayKey();
  let month = thisMonth();

  async function daily() {
    panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="ad-date">Date</label><input id="ad-date" type="date" value="${date}" max="${todayKey()}" /></div></div><div data-sheet><p class="muted">Loading…</p></div>`;
    const box = /** @type {HTMLElement} */ (panel.querySelector("[data-sheet]"));
    panel.querySelector("#ad-date").addEventListener("change", (e) => {
      date = /** @type {HTMLInputElement} */ (e.target).value || todayKey();
      daily();
    });
    try {
      const d = await call("attendanceDay", { date });
      if (!alive()) return;
      const s = d.summary;
      const unmarked = d.rows.filter((r) => !r.record);
      box.innerHTML = `
        ${d.holiday ? `<p class="notice" role="status">Holiday: ${esc(d.holiday)}</p>` : ""}${d.locked ? `<p class="notice" role="status">Payroll for this month is approved, so its attendance is locked.</p>` : ""}
        <p class="muted">Present ${s.present} · Late ${s.late} · Half-day ${s.half_day} · Absent ${s.absent} · Leave ${s.leave} · Not marked ${unmarked.length}</p>
        ${d.rows.length ? `${canMark && !d.locked && unmarked.length ? `<p><button type="button" class="btn btn--ghost" data-allpresent>Mark everyone not yet marked as present</button> <button type="button" class="btn btn--primary" data-save><span>Save marked rows</span></button></p>` : ""}
        <div class="adm-table-wrap hr-sheet"><table class="adm-table"><thead><tr><th>Employee</th><th>Shift</th><th>Status</th><th>In</th><th>Out</th><th></th></tr></thead><tbody>${d.rows.map((r) => `<tr data-emp="${esc(r.employeeId)}"><td data-label="Employee"><strong>${esc(r.name)}</strong><br /><span class="muted">${esc(r.employeeNo)}${r.designation ? ` · ${esc(r.designation)}` : ""}</span></td><td data-label="Shift">${r.shift ? `${esc(r.shift.start)}–${esc(r.shift.end)}` : "—"}<br /><span class="muted">${r.expected === "working" ? "" : r.expected === "holiday" ? "Holiday" : "Weekly off"}</span></td>${r.record ? `<td data-label="Status">${statusTag(r.record.status)}${r.record.lateMinutes ? `<br /><span class="muted">${r.record.lateMinutes} min late</span>` : ""}${r.record.overtimeMinutes ? `<br /><span class="muted">${r.record.overtimeMinutes} min overtime</span>` : ""}${r.record.corrections?.length ? `<br /><span class="muted">corrected</span>` : ""}</td><td data-label="In">${esc(r.record.checkIn || "—")}</td><td data-label="Out">${esc(r.record.checkOut || "—")}</td><td>${canMark && !d.locked && !r.record.leaveId ? `<button type="button" class="text-btn" data-correct="${esc(r.employeeId)}">Correct</button>` : ""}</td>` : `<td data-label="Status"><select data-st aria-label="Status of ${esc(r.name)}" ${canMark && !d.locked ? "" : "disabled"}>${opts(r.expected === "weekly_off" ? "weekly_off" : r.expected === "holiday" ? "holiday" : "")}</select></td><td data-label="In"><input type="time" data-in aria-label="Arrived" ${canMark && !d.locked ? "" : "disabled"} /></td><td data-label="Out"><input type="time" data-out aria-label="Left" ${canMark && !d.locked ? "" : "disabled"} /></td><td></td>`}</tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No employees to mark", text: "Nobody was employed on this date." })}`;
      labelTables(box);
      box.querySelector("[data-allpresent]")?.addEventListener("click", () => box.querySelectorAll("[data-st]").forEach((x) => {
        const sel = /** @type {HTMLSelectElement} */ (x);
        if (!sel.value) sel.value = "present";
      }));
      box.querySelector("[data-save]")?.addEventListener("click", async (ev) => {
        const entries = [...box.querySelectorAll("tr[data-emp]")].map((tr) => ({ employeeId: /** @type {HTMLElement} */ (tr).dataset.emp, status: /** @type {HTMLSelectElement | null} */ (tr.querySelector("[data-st]"))?.value ?? "", checkIn: /** @type {HTMLInputElement | null} */ (tr.querySelector("[data-in]"))?.value ?? "", checkOut: /** @type {HTMLInputElement | null} */ (tr.querySelector("[data-out]"))?.value ?? "" })).filter((x) => x.status);
        if (!entries.length) return toast("Choose a status for at least one person.", "error");
        const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
        btn.disabled = true;
        try {
          const r = await call("bulkMarkAttendance", { date, entries });
          toast(`${r.created} marked${r.skipped.length ? `, ${r.skipped.length} skipped: ${r.skipped[0].reason}` : ""}.`, r.skipped.length ? "error" : "ok");
          daily();
        } catch (err) {
          toast(messageOf(err), "error");
          btn.disabled = false;
        }
      });
      box.querySelectorAll("[data-correct]").forEach((b) => b.addEventListener("click", () => {
        const r = d.rows.find((x) => x.employeeId === /** @type {HTMLElement} */ (b).dataset.correct);
        formDialog({
          title: `Correct ${r.name} — ${date}`,
          intro: `Now: ${ATTENDANCE_STATUS[r.record.status]}${r.record.checkIn ? `, ${r.record.checkIn}–${r.record.checkOut || "?"}` : ""}. The old value and your reason are kept.`,
          body: `${row("status", "Status", select("status", MANUAL_STATUSES.map((x) => [x, ATTENDANCE_STATUS[x]]), r.record.status))}${row("checkIn", "Arrived", input("checkIn", `type="time" value="${esc(r.record.checkIn ?? "")}"`))}${row("checkOut", "Left", input("checkOut", `type="time" value="${esc(r.record.checkOut ?? "")}"`))}${row("reason", "Reason for the correction", input("reason", 'maxlength="200"'))}`,
          submit: "Save correction",
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
            await call("correctAttendance", { employeeId: r.employeeId, date, status: f.status.value, checkIn: f.checkIn.value, checkOut: f.checkOut.value, reason: f.reason.value.trim() });
            close();
            toast("Corrected.");
            daily();
          },
        });
      }));
    } catch (err) {
      if (alive()) {
        box.innerHTML = errorState(messageOf(err));
        box.querySelector("[data-retry]")?.addEventListener("click", daily);
      }
    }
  }

  async function monthly() {
    panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="am-m">Month</label><input id="am-m" type="month" value="${month}" /></div></div><div data-sum><p class="muted">Loading…</p></div>`;
    panel.querySelector("#am-m").addEventListener("change", (e) => {
      month = /** @type {HTMLInputElement} */ (e.target).value || thisMonth();
      monthly();
    });
    const box = /** @type {HTMLElement} */ (panel.querySelector("[data-sum]"));
    try {
      const r = await call("monthlyAttendance", { month });
      if (!alive()) return;
      box.innerHTML = r.rows.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Employee</th><th>Present</th><th>Late</th><th>Half-day</th><th>Absent</th><th>Leave</th><th>Late (min)</th><th>Overtime (min)</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td data-label="Employee"><a class="text-link" href="/admin/hr-employees/${esc(x.employeeId)}" data-link>${esc(x.name)}</a> <span class="muted">${esc(x.employeeNo)}</span></td><td data-label="Present">${x.present}</td><td data-label="Late">${x.late}</td><td data-label="Half-day">${x.half_day}</td><td data-label="Absent">${x.absent}</td><td data-label="Leave">${x.leave}</td><td data-label="Late (min)">${x.lateMinutes}</td><td data-label="Overtime (min)">${x.overtimeMinutes}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No attendance this month" });
    } catch (err) {
      if (alive()) box.innerHTML = errorState(messageOf(err));
    }
  }

  main.querySelector(".adm-tabs").addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
    if (!b) return;
    main.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    if (/** @type {HTMLElement} */ (b).dataset.tab === "0") daily();
    else monthly();
  });
  await daily();
}
