/**
 * Salary advances and loans: request, approve, pay out (once), and the monthly instalments taken from pay. Outstanding balances are what has been
 * paid out and not yet recovered; they match the “Employee advances & loans” account in the books.
 */
import { esc } from "../../lib/format.js";
import { statCard, toast, errorState, emptyState } from "../ui/kit.js";
import { money, formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { toPaisa } from "../ui/money.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf, statusTag, thisMonth, todayKey, methodOptions } from "../hrUi.js";

export default async function hrAdvances({ main, user }) {
  const p = user.perms;
  const canManage = p.includes("hr.advances.manage");
  /** @type {any[]} */
  let people = [];
  if (canManage) people = await call("listEmployees", { status: "active", limit: 200 }).then((r) => r.employees).catch(() => []);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Advances &amp; <em>loans</em></h1><p class="muted">Money paid to employees and recovered from their pay in monthly instalments.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>New advance or loan</span></button></p>` : ""}</header>
      <div class="adm-filters"><div class="field"><label for="ad-st">Show</label><select id="ad-st">${[["all", "All"], ["requested", "Waiting for approval"], ["approved", "Approved, not paid out"], ["disbursed", "Paid out (being recovered)"], ["closed", "Fully repaid"], ["rejected", "Rejected"]].map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div></div>
      <div data-out><p class="muted">Loading…</p></div>
    </div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  main.querySelector("#ad-st").addEventListener("change", show);

  async function show() {
    try {
      const r = await call("listAdvances", { status: /** @type {HTMLSelectElement} */ (main.querySelector("#ad-st")).value, limit: 100 });
      if (!alive()) return;
      out.innerHTML = `<div class="adm-stats">${statCard({ label: "Outstanding (paid out, not yet recovered)", value: money(r.outstanding) })}</div>${r.advances.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Employee</th><th>Kind</th><th>Amount</th><th>Instalments</th><th>Recovered</th><th>Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${r.advances.map((a) => `<tr><td data-label="Employee"><strong>${esc(a.employeeName)}</strong><br /><span class="muted">${esc(a.reason)}</span></td><td data-label="Kind">${a.kind === "loan" ? "Loan" : "Advance"}</td><td data-label="Amount">${esc(money(a.amount))}</td><td data-label="Instalments">${a.months} from ${esc(a.startMonth)}</td><td data-label="Recovered">${esc(money(a.repaid ?? 0))}</td><td data-label="Outstanding">${esc(money(a.outstanding))}</td><td data-label="Status">${statusTag(a.status)}</td><td>${canManage && a.status === "requested" ? `<button type="button" class="text-btn" data-ok="${esc(a.id)}">Approve</button> <button type="button" class="text-btn" data-no="${esc(a.id)}">Reject</button>` : ""}${canManage && a.status === "approved" ? `<button type="button" class="text-btn" data-pay="${esc(a.id)}" data-amount="${a.amount}">Pay out</button>` : ""}${["requested", "approved"].includes(a.status) && canManage ? ` <button type="button" class="text-btn" data-cancel="${esc(a.id)}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No advances or loans" })}`;
      labelTables(out);
      const act = async (fn, msg) => {
        try {
          await fn();
          toast(msg);
        } catch (err) {
          toast(messageOf(err), "error");
        }
        show();
      };
      out.querySelectorAll("[data-ok]").forEach((b) => b.addEventListener("click", () => act(() => call("decideAdvance", { id: /** @type {HTMLElement} */ (b).dataset.ok, decision: "approve" }), "Approved.")));
      out.querySelectorAll("[data-no]").forEach((b) => b.addEventListener("click", () => act(() => call("decideAdvance", { id: /** @type {HTMLElement} */ (b).dataset.no, decision: "reject" }), "Rejected.")));
      out.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => act(() => call("cancelAdvance", { id: /** @type {HTMLElement} */ (b).dataset.cancel }), "Cancelled.")));
      out.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => {
        const key = newKey();
        formDialog({
          title: `Pay out ${money(Number(/** @type {HTMLElement} */ (b).dataset.amount))}`,
          intro: "This can be done only once for each advance. It is posted to the accounts as money paid to the employee.",
          body: `${row("method", "Paid by", select("method", methodOptions, "cash"))}${row("date", "Date", input("date", `type="date" value="${todayKey()}" max="${todayKey()}"`))}${row("reference", "Transfer reference (bank and wallet)", input("reference", 'maxlength="80"'))}`,
          submit: "Pay out",
          async onSubmit(form, { close }) {
            const f = /** @type {any} */ (form.elements);
            await call("disburseAdvance", { idempotencyKey: key, id: /** @type {HTMLElement} */ (b).dataset.pay, method: f.method.value, date: f.date.value, reference: f.reference.value.trim() });
            close();
            toast("Paid out.");
            show();
          },
        });
      }));
    } catch (err) {
      if (alive()) {
        out.innerHTML = errorState(messageOf(err));
        out.querySelector("[data-retry]")?.addEventListener("click", show);
      }
    }
  }
  main.querySelector("[data-new]")?.addEventListener("click", () => {
    const key = newKey();
    formDialog({
      title: "New advance or loan",
      body: `${row("employeeId", "Employee", select("employeeId", people.map((x) => [x.id, x.name])))}${row("kind", "Kind", select("kind", [["advance", "Salary advance (up to 6 months)"], ["loan", "Loan"]], "advance"))}${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal"'))}${row("months", "Recover over how many months", input("months", 'type="number" min="1" max="60" value="1"'))}${row("startMonth", "First deduction month", input("startMonth", `type="month" value="${thisMonth()}" min="${thisMonth()}"`))}${row("reason", "Reason", input("reason", 'maxlength="300"'))}`,
      submit: "Create request",
      async onSubmit(form, { show: err, close }) {
        const f = /** @type {any} */ (form.elements);
        const amount = toPaisa(f.amount.value);
        if (!amount || Number.isNaN(amount)) return err("Enter the amount in rupees.", { amount: "Required" });
        if (f.reason.value.trim().length < 3) return err("Give a reason.", { reason: "Required" });
        await call("requestAdvance", { idempotencyKey: key, employeeId: f.employeeId.value, kind: f.kind.value, amount, months: Number(f.months.value), startMonth: f.startMonth.value, reason: f.reason.value.trim() });
        close();
        toast("Request created.");
        show();
      },
    });
  });
  await show();
}
