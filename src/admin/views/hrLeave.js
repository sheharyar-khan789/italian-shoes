/**
 * Leave: requests (approve / reject), applying for an employee, balances (with audited adjustments) and the leave calendar.
 * Approving fills the attendance days as leave and uses up the balance in one step; balances change only through these actions.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState, emptyState } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf, statusTag, thisMonth } from "../hrUi.js";

const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(head[i])}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

export default async function hrLeave({ main, user }) {
  const canDecide = user.perms.includes("hr.leave.manage");
  const canApply = user.perms.includes("hr.write") || canDecide;
  /** @type {any} */
  let settings;
  /** @type {any[]} */
  let people = [];
  try {
    [settings, people] = await Promise.all([call("getHrSettings", {}), call("listEmployees", { status: "active", limit: 200 }).then((r) => r.employees)]);
  } catch (err) {
    main.innerHTML = `<div class="adm-page">${errorState(messageOf(err))}</div>`;
    return;
  }
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Leave <em>management</em></h1><p class="muted">Applications, approvals, balances and the calendar. Weekly offs and holidays don't use up leave.</p>
        ${canApply ? `<p><button type="button" class="btn btn--primary" data-apply><span>Apply for an employee</span></button></p>` : ""}</header>
      <div class="adm-tabs" role="tablist" aria-label="Leave"><button type="button" role="tab" aria-selected="true" data-tab="0">Requests</button><button type="button" role="tab" aria-selected="false" data-tab="1">Calendar</button><button type="button" role="tab" aria-selected="false" data-tab="2">Balances</button></div>
      <div data-panel></div>
    </div>`;
  const panel = /** @type {HTMLElement} */ (main.querySelector("[data-panel]"));
  const alive = () => main.isConnected && main.querySelector("[data-panel]") !== null;
  let tab = 0;
  let status = "pending";
  let month = thisMonth();
  let who = people[0]?.id ?? "";

  async function requests() {
    panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="lv-st">Show</label><select id="lv-st">${[["pending", "Waiting for a decision"], ["approved", "Approved"], ["rejected", "Rejected"], ["cancelled", "Cancelled"], ["all", "All"]].map(([k, l]) => `<option value="${k}" ${k === status ? "selected" : ""}>${l}</option>`).join("")}</select></div></div><div data-list><p class="muted">Loading…</p></div>`;
    panel.querySelector("#lv-st").addEventListener("change", (e) => {
      status = /** @type {HTMLSelectElement} */ (e.target).value;
      requests();
    });
    const box = /** @type {HTMLElement} */ (panel.querySelector("[data-list]"));
    try {
      const r = await call("listLeave", { status, limit: 100 });
      if (!alive()) return;
      box.innerHTML = r.requests.length ? table(["Employee", "Type", "From", "To", "Days", "Status", "Reason", ""], r.requests.map((x) => [`<strong>${esc(x.employeeName)}</strong><br /><span class="muted">${esc(x.employeeNo)}</span>`, esc(x.typeName + (x.paid ? "" : " (unpaid)")), esc(x.from), esc(x.to), String(x.days), statusTag(x.status) + (x.decisionNote ? `<br /><span class="muted">${esc(x.decisionNote)}</span>` : ""), esc(x.reason), x.status === "pending" && canDecide ? `<button type="button" class="text-btn" data-approve="${esc(x.id)}">Approve</button> <button type="button" class="text-btn" data-reject="${esc(x.id)}">Reject</button>` : x.status === "approved" && canDecide ? `<button type="button" class="text-btn" data-cancel="${esc(x.id)}">Cancel</button>` : ""])) : emptyState({ title: "Nothing here", text: status === "pending" ? "No leave is waiting for a decision." : "" });
      labelTables(box);
      box.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
        try {
          await call("decideLeave", { id: /** @type {HTMLElement} */ (b).dataset.approve, decision: "approve", note: "" });
          toast("Approved.");
          requests();
        } catch (err) {
          toast(messageOf(err), "error");
        }
      }));
      box.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => formDialog({
        title: "Reject this leave",
        body: row("note", "Reason (the employee sees it)", input("note", 'maxlength="300"')),
        submit: "Reject",
        async onSubmit(form, { close }) {
          await call("decideLeave", { id: /** @type {HTMLElement} */ (b).dataset.reject, decision: "reject", note: String(new FormData(form).get("note") ?? "") });
          close();
          toast("Rejected.");
          requests();
        },
      })));
      box.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: "Cancel this approved leave?", body: "Its days are removed from attendance and the balance is given back. Leave that has already started can't be cancelled.", confirm: "Cancel leave", danger: true }))) return;
        try {
          await call("cancelLeave", { id: /** @type {HTMLElement} */ (b).dataset.cancel });
          requests();
        } catch (err) {
          toast(messageOf(err), "error");
        }
      }));
    } catch (err) {
      if (alive()) box.innerHTML = errorState(messageOf(err));
    }
  }

  async function calendar() {
    panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="lc-m">Month</label><input id="lc-m" type="month" value="${month}" /></div></div><div data-cal><p class="muted">Loading…</p></div>`;
    panel.querySelector("#lc-m").addEventListener("change", (e) => {
      month = /** @type {HTMLInputElement} */ (e.target).value || thisMonth();
      calendar();
    });
    const box = /** @type {HTMLElement} */ (panel.querySelector("[data-cal]"));
    try {
      const r = await call("leaveCalendar", { month });
      if (!alive()) return;
      box.innerHTML = r.leave.length ? table(["Employee", "Type", "From", "To", "Days", "Status"], r.leave.sort((a, b) => a.from.localeCompare(b.from)).map((x) => [esc(x.name), esc(x.type), esc(x.from), esc(x.to), String(x.days), statusTag(x.status)])) : emptyState({ title: "Nobody is on leave this month" });
      labelTables(box);
    } catch (err) {
      if (alive()) box.innerHTML = errorState(messageOf(err));
    }
  }

  async function balances() {
    const year = Number(month.slice(0, 4));
    panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="lb-e">Employee</label><select id="lb-e">${people.map((p) => `<option value="${esc(p.id)}" ${p.id === who ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div></div><div data-bal><p class="muted">Loading…</p></div>`;
    panel.querySelector("#lb-e").addEventListener("change", (e) => {
      who = /** @type {HTMLSelectElement} */ (e.target).value;
      balances();
    });
    const box = /** @type {HTMLElement} */ (panel.querySelector("[data-bal]"));
    if (!who) return void (box.innerHTML = emptyState({ title: "No employees yet" }));
    try {
      const r = await call("leaveBalance", { employeeId: who, year });
      if (!alive()) return;
      box.innerHTML = `<h2 class="adm-h2">${year}</h2>${table(["Leave type", "Allowance", "Adjusted", "Used", "Pending", "Left", ""], r.balances.map((x) => [esc(x.name + (x.paid ? "" : " (unpaid)")), x.unlimited ? "—" : String(x.allowance), String(x.adjustments), String(x.used), String(x.pending), x.unlimited ? "No limit" : `<strong>${x.remaining}</strong>`, canDecide ? `<button type="button" class="text-btn" data-adjust="${esc(x.type)}">Adjust</button>` : ""]))}`;
      labelTables(box);
      box.querySelectorAll("[data-adjust]").forEach((b) => b.addEventListener("click", () => {
        const key = newKey();
        formDialog({
          title: "Adjust leave balance",
          intro: "Use a negative number to take days away. Every adjustment is recorded with your name and the reason.",
          body: `${row("days", "Days (+ or −)", input("days", 'type="number" step="0.5"'))}${row("reason", "Reason", input("reason", 'maxlength="200"'))}`,
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            const days = Number(f.days.value);
            if (!days) return show("Enter a number other than zero.", { days: "Required" });
            if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
            await call("adjustLeaveBalance", { idempotencyKey: key, employeeId: who, year, type: /** @type {HTMLElement} */ (b).dataset.adjust, days, reason: f.reason.value.trim() });
            close();
            toast("Balance adjusted.");
            balances();
          },
        });
      }));
    } catch (err) {
      if (alive()) box.innerHTML = errorState(messageOf(err));
    }
  }

  main.querySelector(".adm-tabs").addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
    if (!b) return;
    tab = Number(/** @type {HTMLElement} */ (b).dataset.tab);
    main.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    [requests, calendar, balances][tab]();
  });
  main.querySelector("[data-apply]")?.addEventListener("click", () => {
    const key = newKey();
    formDialog({
      title: "Apply for leave on behalf of an employee",
      body: `${row("employeeId", "Employee", select("employeeId", people.map((p) => [p.id, p.name]), who))}${row("type", "Leave type", select("type", settings.leaveTypes.map((l) => [l.key, `${l.name}${l.paid ? "" : " (unpaid)"}`]), settings.leaveTypes[0]?.key))}${row("from", "From", input("from", 'type="date"'))}${row("to", "To", input("to", 'type="date"'))}<label class="check"><input type="checkbox" name="half" /> Half day (one date only)</label>${row("reason", "Reason", input("reason", 'maxlength="300"'))}`,
      submit: "Apply",
      async onSubmit(form, { show, close }) {
        const f = /** @type {any} */ (form.elements);
        if (!f.from.value || !f.to.value) return show("Choose the dates.");
        if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
        const r = await call("applyLeave", { idempotencyKey: key, employeeId: f.employeeId.value, type: f.type.value, from: f.from.value, to: f.to.value, halfDay: f.half.checked, reason: f.reason.value.trim() });
        close();
        toast(`Applied for ${r.days} day${r.days === 1 ? "" : "s"}.`);
        tab = 0;
        status = "pending";
        main.querySelectorAll("[data-tab]").forEach((x, i) => x.setAttribute("aria-selected", String(i === 0)));
        requests();
      },
    });
  });
  await requests();
}
