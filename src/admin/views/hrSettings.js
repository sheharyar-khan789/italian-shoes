/**
 * HR settings. Nothing about your organisation is built in: departments, designations, employment types, leave types, shifts, holidays and
 * commission rules are all yours to define. The attendance, overtime and payroll rules decide how deductions and overtime are calculated.
 */
import { esc } from "../../lib/format.js";
import { WEEKDAYS } from "../../../shared/hr.js";
import { hrSettingsInput, saveShiftInput, saveCommissionRuleInput, fieldErrors } from "../../../shared/schemas/index.js";
import { toast, errorState, emptyState } from "../ui/kit.js";
import { money, formDialog, row, input, select } from "../ui/purchasing.js";
import { toPaisa } from "../ui/money.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf } from "../hrUi.js";

const lines = (t) => String(t).split("\n").map((x) => x.trim()).filter(Boolean);
const n = (v) => (String(v).trim() === "" ? Number.NaN : Number(v));

export default async function hrSettings({ main, user }) {
  const p = user.perms;
  const canManage = p.includes("hr.manage");
  const canShift = p.includes("hr.attendance");
  main.innerHTML = `<div class="adm-page"><header class="adm-page__head"><h1 class="adm-h1">HR <em>settings</em></h1><p class="muted">Define your own departments, designations, leave types, shifts, holidays and pay rules.</p></header><div data-out><p class="muted">Loading…</p></div></div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  const year = new Date().getFullYear();

  async function show() {
    let cfg;
    let shifts;
    let holidays;
    let rules = [];
    try {
      [cfg, shifts, holidays] = await Promise.all([call("getHrSettings", {}), call("listShifts", {}).then((r) => r.shifts), call("listHolidays", { year }).then((r) => r.holidays)]);
      if (p.includes("hr.salary.read")) rules = (await call("listCommissionRules", {})).rules;
    } catch (err) {
      if (alive()) {
        out.innerHTML = errorState(messageOf(err));
        out.querySelector("[data-retry]")?.addEventListener("click", show);
      }
      return;
    }
    if (!alive()) return;
    const dis = canManage ? "" : "disabled";
    const f = (id, label, value, attrs = "") => `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${id}" value="${esc(value)}" ${attrs} ${dis} /></div>`;
    out.innerHTML = `
      <form data-form novalidate>
        <p class="form-alert" role="alert" data-alert hidden></p>
        <section class="adm-card"><h2 class="adm-h2">Organisation</h2>
          <div class="field"><label for="departments">Departments (one per line)</label><textarea id="departments" name="departments" rows="4" ${dis}>${esc(cfg.departments.join("\n"))}</textarea></div>
          <div class="field"><label for="designations">Designations (one per line)</label><textarea id="designations" name="designations" rows="4" ${dis}>${esc(cfg.designations.join("\n"))}</textarea></div>
          <div class="field"><label for="employmentTypes">Employment types (one per line)</label><textarea id="employmentTypes" name="employmentTypes" rows="3" ${dis}>${esc(cfg.employmentTypes.join("\n"))}</textarea></div></section>
        <section class="adm-card"><h2 class="adm-h2">Leave types</h2><p class="muted">One per line as <code>key | name | days a year | paid or unpaid</code>, for example <code>casual | Casual leave | 10 | paid</code>. Unpaid leave is deducted from salary; 0 days with unpaid means no limit.</p>
          <div class="field"><label for="leaveTypes" class="visually-hidden">Leave types</label><textarea id="leaveTypes" name="leaveTypes" rows="5" ${dis}>${esc(cfg.leaveTypes.map((l) => `${l.key} | ${l.name} | ${l.days} | ${l.paid ? "paid" : "unpaid"}`).join("\n"))}</textarea></div></section>
        <section class="adm-card"><h2 class="adm-h2">Attendance and pay rules</h2>
          ${f("absentDeductDays", "An absent day deducts this many days of pay", cfg.attendance.absentDeductDays, 'inputmode="decimal"')}
          ${f("halfDayDeductDays", "A half-day deducts this many days", cfg.attendance.halfDayDeductDays, 'inputmode="decimal"')}
          ${f("lateEvery", "Every this many late arrivals…  (0 = no late deduction)", cfg.attendance.lateEvery, 'inputmode="numeric"')}
          ${f("lateDeductDays", "…deducts this many days", cfg.attendance.lateDeductDays, 'inputmode="decimal"')}
          <label class="check"><input type="checkbox" name="otOn" ${cfg.overtime.enabled ? "checked" : ""} ${dis} /> Pay overtime</label>
          ${f("otMultiplier", "Overtime rate (× the hourly rate)", cfg.overtime.multiplier, 'inputmode="decimal"')}
          ${f("otMin", "Overtime counts from (minutes after the shift ends)", cfg.overtime.minMinutes, 'inputmode="numeric"')}
          <div class="field"><label for="basis">A day's pay is the monthly salary divided by</label><select id="basis" name="basis" ${dis}>${[["30", "30"], ["calendar", "The days in that month"], ["working", "That employee's working days"]].map(([k, l]) => `<option value="${k}" ${cfg.payroll.dailyRateBasis === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="field"><label for="unmarked">Working days with no attendance record</label><select id="unmarked" name="unmarked" ${dis}>${[["block", "Block payroll approval until they are marked"], ["present", "Count them as present"], ["absent", "Count them as absent"]].map(([k, l]) => `<option value="${k}" ${cfg.payroll.unmarked === k ? "selected" : ""}>${l}</option>`).join("")}</select></div></section>
        ${canManage ? `<p><button type="submit" class="btn btn--primary"><span>Save settings</span></button></p>` : `<p class="muted">You can view these settings but not change them.</p>`}
      </form>
      <section><h2 class="adm-h2">Shifts</h2>${canShift ? `<p><button type="button" class="btn btn--primary" data-shift>Add a shift</button></p>` : ""}${shifts.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Shift</th><th>Hours</th><th>Break</th><th>Grace</th><th>Working days</th><th>Employees</th><th></th></tr></thead><tbody>${shifts.map((s) => `<tr><td data-label="Shift">${esc(s.name)}${s.isActive === false ? ` <span class="tag tag--out">Off</span>` : ""}</td><td data-label="Hours">${esc(s.start)}–${esc(s.end)}</td><td data-label="Break">${s.breakMinutes} min</td><td data-label="Grace">${s.graceMinutes} min</td><td data-label="Working days">${s.workingDays.map((d) => WEEKDAYS[d].slice(0, 3)).join(", ")}</td><td data-label="Employees">${s.employees}</td><td>${canShift ? `<button type="button" class="text-btn" data-edit-shift="${esc(s.id)}">Edit</button> <button type="button" class="text-btn" data-assign="${esc(s.id)}">Assign people</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No shifts yet", text: "Create a shift to track late arrivals and overtime." })}</section>
      <section><h2 class="adm-h2">Holidays ${year}</h2>${canShift ? `<p><button type="button" class="btn btn--primary" data-holiday>Add a holiday</button></p>` : ""}${holidays.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Holiday</th><th></th></tr></thead><tbody>${holidays.map((h) => `<tr><td data-label="Date">${esc(h.date)}</td><td data-label="Holiday">${esc(h.name)}</td><td>${canShift ? `<button type="button" class="text-btn" data-rm-holiday="${esc(h.date)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No holidays added" })}</section>
      ${p.includes("hr.salary.read") ? `<section><h2 class="adm-h2">Commission and incentives</h2><p class="muted">Worked out by the server from POS sales rung up by each employee's linked sign-in. Nothing here can be typed into a payslip.</p>${canManage ? `<p><button type="button" class="btn btn--primary" data-rule>Add a rule</button></p>` : ""}${rules.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Rule</th><th>Kind</th><th>For</th><th>Pays</th><th></th></tr></thead><tbody>${rules.map((r) => `<tr><td data-label="Rule">${esc(r.name)}${r.isActive === false ? ` <span class="tag tag--out">Off</span>` : ""}</td><td data-label="Kind">${esc({ percent: "% of sales", fixed: "Fixed bonus", target: "Target incentive" }[r.type])}</td><td data-label="For">${esc(r.scope === "all" ? "Everyone" : r.scope === "designation" ? r.designation : "One employee")}</td><td data-label="Pays">${r.type === "percent" ? `${r.rate}%` : `${esc(money(r.amount))}${r.target ? ` when sales reach ${esc(money(r.target))}` : ""}${r.aboveRate ? ` + ${r.aboveRate}% above` : ""}`}</td><td>${canManage ? `<button type="button" class="text-btn" data-toggle-rule="${esc(r.id)}" data-on="${r.isActive === false ? "1" : "0"}">${r.isActive === false ? "Switch on" : "Switch off"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No commission rules" })}</section>` : ""}
      ${p.includes("staff.manage") ? `<section><h2 class="adm-h2">Roles</h2><p class="muted">Create the HR Manager, Payroll Accountant and Employee roles (existing roles are left alone), then give them to people in Staff &amp; Roles.</p><p><button type="button" class="btn btn--ghost" data-roles>Create HR roles</button></p></section>` : ""}`;
    labelTables(out);

    const form = /** @type {HTMLFormElement} */ (out.querySelector("[data-form]"));
    const alert = /** @type {HTMLElement} */ (form.querySelector("[data-alert]"));
    const v = (id) => /** @type {HTMLInputElement} */ (form.elements.namedItem(id)).value;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!canManage) return;
      alert.hidden = true;
      const leaveTypes = lines(v("leaveTypes")).map((l) => {
        const [key, name, days, paid] = l.split("|").map((x) => x.trim());
        return { key, name, days: n(days), paid: (paid ?? "paid").toLowerCase() !== "unpaid" };
      });
      const parsed = hrSettingsInput.safeParse({ departments: lines(v("departments")), designations: lines(v("designations")), employmentTypes: lines(v("employmentTypes")), leaveTypes, attendance: { absentDeductDays: n(v("absentDeductDays")), halfDayDeductDays: n(v("halfDayDeductDays")), lateEvery: n(v("lateEvery")), lateDeductDays: n(v("lateDeductDays")) }, overtime: { enabled: /** @type {HTMLInputElement} */ (form.elements.namedItem("otOn")).checked, multiplier: n(v("otMultiplier")), minMinutes: n(v("otMin")) }, payroll: { dailyRateBasis: v("basis"), unmarked: v("unmarked") } });
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        alert.textContent = `Please check the settings: ${i?.message ?? "a value isn't valid"} (${i?.path.join(" › ")}).`;
        alert.hidden = false;
        return;
      }
      try {
        await call("saveHrSettings", parsed.data);
        toast("Settings saved.");
        show();
      } catch (err) {
        alert.textContent = messageOf(err);
        alert.hidden = false;
      }
    });

    const shiftDialog = (s) => {
      const d = s ?? { name: "", start: "09:00", end: "18:00", breakMinutes: 60, graceMinutes: 10, workingDays: [1, 2, 3, 4, 5, 6], isActive: true };
      formDialog({
        title: s ? "Edit shift" : "Add a shift",
        body: `${row("name", "Name", input("name", `maxlength="40" value="${esc(d.name)}"`))}${row("start", "Starts", input("start", `type="time" value="${esc(d.start)}"`))}${row("end", "Ends (earlier than the start = runs past midnight)", input("end", `type="time" value="${esc(d.end)}"`))}${row("breakMinutes", "Break (minutes)", input("breakMinutes", `type="number" min="0" value="${d.breakMinutes}"`))}${row("graceMinutes", "Grace period before “late” (minutes)", input("graceMinutes", `type="number" min="0" value="${d.graceMinutes}"`))}<fieldset class="field"><legend>Working days</legend>${WEEKDAYS.map((w, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${d.workingDays.includes(i) ? "checked" : ""} /> ${w}</label>`).join(" ")}</fieldset><label class="check"><input type="checkbox" name="active" ${d.isActive !== false ? "checked" : ""} /> In use</label>`,
        async onSubmit(fm, { show: err, close }) {
          const g = /** @type {any} */ (fm.elements);
          const parsed = saveShiftInput.safeParse({ ...(s ? { id: s.id } : {}), name: g.name.value, start: g.start.value, end: g.end.value, breakMinutes: n(g.breakMinutes.value), graceMinutes: n(g.graceMinutes.value), workingDays: [...fm.querySelectorAll('[name="day"]:checked')].map((x) => Number(/** @type {HTMLInputElement} */ (x).value)), isActive: g.active.checked });
          if (!parsed.success) return err("Please check the highlighted fields.", fieldErrors(parsed.error));
          await call("saveShift", parsed.data);
          close();
          toast("Saved.");
          show();
        },
      });
    };
    out.querySelector("[data-shift]")?.addEventListener("click", () => shiftDialog(null));
    out.querySelectorAll("[data-edit-shift]").forEach((b) => b.addEventListener("click", () => shiftDialog(shifts.find((s) => s.id === /** @type {HTMLElement} */ (b).dataset.editShift))));
    out.querySelectorAll("[data-assign]").forEach((b) => b.addEventListener("click", async () => {
      const people = (await call("listEmployees", { status: "active", limit: 200 })).employees;
      const sid = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.assign);
      formDialog({
        title: "Put people on this shift",
        body: `<fieldset class="field"><legend>Employees</legend>${people.map((x) => `<label class="check"><input type="checkbox" name="emp" value="${esc(x.id)}" ${x.shiftId === sid ? "checked" : ""} /> ${esc(x.name)}</label>`).join(" ")}</fieldset>`,
        submit: "Assign",
        async onSubmit(fm, { show: err, close }) {
          const ids = [...fm.querySelectorAll('[name="emp"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value);
          if (!ids.length) return err("Tick at least one person.");
          await call("assignShift", { employeeIds: ids, shiftId: sid });
          close();
          toast("Assigned.");
          show();
        },
      });
    }));
    out.querySelector("[data-holiday]")?.addEventListener("click", () => formDialog({
      title: "Add a holiday",
      body: `${row("date", "Date", input("date", 'type="date"'))}${row("name", "Name", input("name", 'maxlength="60"'))}`,
      async onSubmit(fm, { show: err, close }) {
        const g = /** @type {any} */ (fm.elements);
        if (!g.date.value || g.name.value.trim().length < 2) return err("Enter the date and a name.");
        await call("saveHoliday", { date: g.date.value, name: g.name.value.trim() });
        close();
        show();
      },
    }));
    out.querySelectorAll("[data-rm-holiday]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await call("deleteHoliday", { date: /** @type {HTMLElement} */ (b).dataset.rmHoliday });
        show();
      } catch (err) {
        toast(messageOf(err), "error");
      }
    }));
    out.querySelector("[data-rule]")?.addEventListener("click", async () => {
      const people = (await call("listEmployees", { status: "active", limit: 200 })).employees;
      formDialog({
        title: "Add a commission or incentive rule",
        wide: true,
        body: `${row("name", "Name", input("name", 'maxlength="60"'))}${row("type", "Kind", select("type", [["percent", "Percentage of net sales"], ["fixed", "Fixed bonus"], ["target", "Target incentive (bonus when sales reach a target)"]], "percent"))}${row("rate", "Percentage (for % rules)", input("rate", 'inputmode="decimal"'))}${row("amount", "Bonus amount (Rs, for bonus and target rules)", input("amount", 'inputmode="decimal"'))}${row("target", "Sales target (Rs, for target rules and optional for bonuses)", input("target", 'inputmode="decimal"'))}${row("aboveRate", "Extra % of sales above the target (target rules)", input("aboveRate", 'inputmode="decimal"'))}${row("scope", "Who gets it", select("scope", [["all", "Everyone"], ["designation", "A designation"], ["employee", "One employee"]], "all"))}${row("designation", "Designation", select("designation", [["", "—"], ...cfg.designations.map((x) => [x, x])], ""))}${row("employeeId", "Employee", select("employeeId", [["", "—"], ...people.map((x) => [x.id, x.name])], ""))}`,
        async onSubmit(fm, { show: err, close }) {
          const g = /** @type {any} */ (fm.elements);
          const parsed = saveCommissionRuleInput.safeParse({ name: g.name.value, type: g.type.value, rate: n(g.rate.value) || 0, amount: toPaisa(g.amount.value) ?? 0, target: toPaisa(g.target.value) ?? 0, aboveRate: n(g.aboveRate.value) || 0, scope: g.scope.value, designation: g.designation.value, employeeId: g.employeeId.value || null, isActive: true });
          if (!parsed.success) return err("Please check the highlighted fields.", fieldErrors(parsed.error));
          await call("saveCommissionRule", parsed.data);
          close();
          toast("Rule added.");
          show();
        },
      });
    });
    out.querySelectorAll("[data-toggle-rule]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await call("setCommissionRuleActive", { id: /** @type {HTMLElement} */ (b).dataset.toggleRule, isActive: /** @type {HTMLElement} */ (b).dataset.on === "1" });
        show();
      } catch (err) {
        toast(messageOf(err), "error");
      }
    }));
    out.querySelector("[data-roles]")?.addEventListener("click", async () => {
      try {
        const r = await call("createHrRoles", {});
        toast(r.created.length ? `Created: ${r.created.join(", ")}.` : "The HR roles already exist.");
      } catch (err) {
        toast(messageOf(err), "error");
      }
    });
  }
  await show();
}
