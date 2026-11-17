/**
 * My HR: an employee's own profile, attendance, leave (apply and track), advances and payslips. Nothing here can reach anyone else's records:
 * the server finds "me" from the sign-in, never from the page.
 */
import { esc } from "../../lib/format.js";
import { privateImage, wirePrivateFiles } from "../privateFileUi.js";
import { ATTENDANCE_STATUS, weekdayOf } from "../../../shared/hr.js";
import { toast, errorState, emptyState } from "../ui/kit.js";
import { money, formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { toPaisa } from "../ui/money.js";
import { adminTable } from "../analyticsUi.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf, statusTag, thisMonth, payslipReport, printLocal } from "../hrUi.js";

const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(head[i])}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

export default async function hrSelf({ main }) {
  main.innerHTML = `<div class="adm-page"><header class="adm-page__head"><h1 class="adm-h1">My <em>HR</em></h1><p class="muted">Your own profile, attendance, leave and payslips.</p></header><div data-out><p class="muted">Loading…</p></div></div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  let me;
  /** @type {any} */
  let settings;
  try {
    [me, settings] = await Promise.all([call("hrMyProfile", {}), call("getHrSettings", {})]);
  } catch (err) {
    out.innerHTML = errorState(messageOf(err));
    return;
  }
  const e = me.employee;
  let month = thisMonth();
  let tab = 0;
  const names = ["Profile", "Attendance", "Leave", "Advances", "Payslips"];
  out.innerHTML = `<p>${e.photoUrl ? `${privateImage(e.photoUrl, "hr-photo")} ` : ""}<strong>${esc(e.name)}</strong> <span class="muted">${esc(e.employeeNo)}${e.designation ? ` · ${esc(e.designation)}` : ""}</span></p><div class="adm-tabs" role="tablist" aria-label="My HR">${names.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${t}</button>`).join("")}</div><div data-panel></div>`;
  const panel = /** @type {HTMLElement} */ (out.querySelector("[data-panel]"));
  wirePrivateFiles(out);

  const views = [
    () => {
      panel.innerHTML = `<dl class="adm-card adm-details"><dt>Phone</dt><dd>${esc(e.phone)}</dd><dt>Email</dt><dd>${esc(e.email || "—")}</dd><dt>Department</dt><dd>${esc(e.department || "—")}</dd><dt>Employment type</dt><dd>${esc(e.employmentType || "—")}</dd><dt>Joined</dt><dd>${esc(e.joiningDate)}</dd><dt>Shift</dt><dd>${me.shift ? `${esc(me.shift.name)} (${esc(me.shift.start)}–${esc(me.shift.end)})` : "—"}</dd><dt>Emergency contact</dt><dd>${esc([e.emergencyContact?.name, e.emergencyContact?.phone].filter(Boolean).join(" · ") || "—")}</dd></dl>`;
    },
    async () => {
      panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="sm">Month</label><input id="sm" type="month" value="${month}" /></div></div><div data-cal><p class="muted">Loading…</p></div>`;
      const draw = async () => {
        const box = /** @type {HTMLElement} */ (panel.querySelector("[data-cal]"));
        try {
          const m = await call("myAttendance", { month });
          const lead = (weekdayOf(`${month}-01`) + 6) % 7;
          const cells = [...Array(lead).fill(`<div class="hr-day hr-day--blank"></div>`), ...m.days.map((x) => `<div class="hr-day hr-day--${esc(x.record?.status ?? x.expected)}"><strong>${Number(x.date.slice(8))}</strong><span>${esc(x.record ? ATTENDANCE_STATUS[x.record.status] : x.expected === "working" ? "—" : x.expected === "holiday" ? "Holiday" : "Off")}</span></div>`)];
          const s = m.summary;
          box.innerHTML = `<p class="muted">Present ${s.present} · Late ${s.late} · Half-day ${s.half_day} · Absent ${s.absent} · Leave ${s.leave}</p><div class="hr-cal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="hr-dow">${d}</div>`).join("")}${cells.join("")}</div>`;
        } catch (err) {
          box.innerHTML = errorState(messageOf(err));
        }
      };
      panel.querySelector("#sm").addEventListener("change", (ev) => {
        month = /** @type {HTMLInputElement} */ (ev.target).value || thisMonth();
        draw();
      });
      draw();
    },
    async () => {
      panel.innerHTML = `<p><button type="button" class="btn btn--primary" data-apply><span>Apply for leave</span></button></p><div data-lv><p class="muted">Loading…</p></div>`;
      const box = /** @type {HTMLElement} */ (panel.querySelector("[data-lv]"));
      const draw = async () => {
        try {
          const [b, l] = await Promise.all([call("leaveBalance", { year: Number(thisMonth().slice(0, 4)) }), call("myLeave", { limit: 50 })]);
          box.innerHTML = `<h2 class="adm-h2">My balances</h2>${table(["Leave type", "Allowance", "Used", "Pending", "Left"], b.balances.map((x) => [esc(x.name + (x.paid ? "" : " (unpaid)")), x.unlimited ? "—" : String(x.allowance + x.adjustments), String(x.used), String(x.pending), x.unlimited ? "No limit" : `<strong>${x.remaining}</strong>`]))}<h2 class="adm-h2">My requests</h2>${l.requests.length ? table(["Type", "From", "To", "Days", "Status", "", ""], l.requests.map((x) => [esc(x.typeName), esc(x.from), esc(x.to), String(x.days), statusTag(x.status) + (x.decisionNote ? `<br /><span class="muted">${esc(x.decisionNote)}</span>` : ""), esc(x.reason), ["pending", "approved"].includes(x.status) ? `<button type="button" class="text-btn" data-cancel="${esc(x.id)}">Cancel</button>` : ""])) : `<p class="muted">You haven't applied for any leave.</p>`}`;
          labelTables(box);
          box.querySelectorAll("[data-cancel]").forEach((c) => c.addEventListener("click", async () => {
            try {
              await call("cancelLeave", { id: /** @type {HTMLElement} */ (c).dataset.cancel });
              draw();
            } catch (err) {
              toast(messageOf(err), "error");
            }
          }));
        } catch (err) {
          box.innerHTML = errorState(messageOf(err));
        }
      };
      panel.querySelector("[data-apply]").addEventListener("click", () => {
        const key = newKey();
        formDialog({
          title: "Apply for leave",
          body: `${row("type", "Leave type", select("type", settings.leaveTypes.map((l) => [l.key, `${l.name}${l.paid ? "" : " (unpaid)"}`]), settings.leaveTypes[0]?.key))}${row("from", "From", input("from", 'type="date"'))}${row("to", "To", input("to", 'type="date"'))}<label class="check"><input type="checkbox" name="half" /> Half day (one date only)</label>${row("reason", "Reason", input("reason", 'maxlength="300"'))}`,
          submit: "Send application",
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            if (!f.from.value || !f.to.value) return show("Choose the dates.");
            if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
            const r = await call("applyLeave", { idempotencyKey: key, type: f.type.value, from: f.from.value, to: f.to.value, halfDay: f.half.checked, reason: f.reason.value.trim() });
            close();
            toast(`Applied for ${r.days} day${r.days === 1 ? "" : "s"}.`);
            draw();
          },
        });
      });
      draw();
    },
    async () => {
      panel.innerHTML = `<p><button type="button" class="btn btn--primary" data-ask><span>Ask for an advance or loan</span></button></p><div data-adv><p class="muted">Loading…</p></div>`;
      const box = /** @type {HTMLElement} */ (panel.querySelector("[data-adv]"));
      const draw = async () => {
        try {
          const r = await call("myAdvances", { status: "all", limit: 50 });
          box.innerHTML = r.advances.length ? table(["Kind", "Amount", "Instalments", "Recovered", "Outstanding", "Status"], r.advances.map((a) => [a.kind === "loan" ? "Loan" : "Advance", esc(money(a.amount)), `${a.months} from ${esc(a.startMonth)}`, esc(money(a.repaid ?? 0)), esc(money(a.outstanding)), statusTag(a.status)])) : emptyState({ title: "No advances or loans" });
          labelTables(box);
        } catch (err) {
          box.innerHTML = errorState(messageOf(err));
        }
      };
      panel.querySelector("[data-ask]").addEventListener("click", () => {
        const key = newKey();
        formDialog({
          title: "Ask for an advance or loan",
          intro: "HR reviews the request. If it is paid, the instalments are taken from your salary.",
          body: `${row("kind", "Kind", select("kind", [["advance", "Salary advance"], ["loan", "Loan"]], "advance"))}${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal"'))}${row("months", "Recover over how many months", input("months", 'type="number" min="1" max="60" value="1"'))}${row("startMonth", "First deduction month", input("startMonth", `type="month" value="${thisMonth()}" min="${thisMonth()}"`))}${row("reason", "Reason", input("reason", 'maxlength="300"'))}`,
          submit: "Send request",
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            const amount = toPaisa(f.amount.value);
            if (!amount || Number.isNaN(amount)) return show("Enter the amount in rupees.", { amount: "Required" });
            if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
            await call("requestAdvance", { idempotencyKey: key, kind: f.kind.value, amount, months: Number(f.months.value), startMonth: f.startMonth.value, reason: f.reason.value.trim() });
            close();
            toast("Request sent.");
            draw();
          },
        });
      });
      draw();
    },
    async () => {
      panel.innerHTML = `<p class="muted">Loading…</p>`;
      try {
        const r = await call("myPayslips", { limit: 24 });
        panel.innerHTML = r.payslips.length ? table(["Month", "Gross", "Deductions", "Net", "Status", ""], r.payslips.map((s) => [esc(s.month), esc(money(s.gross)), esc(money(s.deductions)), `<strong>${esc(money(s.net))}</strong>`, statusTag(s.status) + (s.paidOn ? `<br /><span class="muted">${esc(s.paidOn)}</span>` : ""), `<button type="button" class="text-btn" data-slip="${esc(s.month)}">View</button>`])) : emptyState({ title: "No payslips yet", text: "A payslip appears here once the month's payroll is approved." });
        labelTables(panel);
        panel.querySelectorAll("[data-slip]").forEach((b) => b.addEventListener("click", async () => {
          try {
            const { payslip } = await call("getPayslip", { month: /** @type {HTMLElement} */ (b).dataset.slip });
            const rep = payslipReport(payslip);
            const d = document.createElement("dialog");
            d.className = "adm-dialog adm-dialog--wide";
            d.setAttribute("aria-label", "Payslip");
            d.innerHTML = `<div>${rep.tables.map((t) => adminTable(t)).join("")}<p class="muted">${rep.notes.map(esc).join(" ")}</p><p><button type="button" class="btn btn--ghost" data-print>Print</button> <button type="button" class="btn btn--primary" data-close>Close</button></p></div>`;
            document.body.append(d);
            d.addEventListener("close", () => d.remove());
            d.querySelector("[data-close]")?.addEventListener("click", () => d.close());
            d.querySelector("[data-print]")?.addEventListener("click", () => printLocal(rep));
            d.showModal();
          } catch (err) {
            toast(messageOf(err), "error");
          }
        }));
      } catch (err) {
        panel.innerHTML = errorState(messageOf(err));
      }
    },
  ];
  out.querySelector(".adm-tabs").addEventListener("click", (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest("[data-tab]");
    if (!b) return;
    tab = Number(/** @type {HTMLElement} */ (b).dataset.tab);
    out.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    views[tab]();
  });
  if (alive()) views[0]();
}
