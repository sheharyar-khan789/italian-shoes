/** Financial dashboard: every figure comes from the posted books (server-side), for a chosen period. */
import { esc } from "../../lib/format.js";
import { rangeFor } from "../../../shared/finance.js";
import { statCard, errorState } from "../ui/kit.js";
import { call } from "../purchData.js";
import { todayKey, money, messageOf } from "../financeUi.js";

const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["year", "This year"], ["custom", "Custom range"]];

export default async function finance({ main }) {
  let preset = "month";
  let range = rangeFor("month", todayKey());
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Financial <em>dashboard</em></h1>
        <p class="muted">Figures come from your posted accounting records. Income is recognised when a sale is recorded; transfers between your own cash and bank accounts are not income or expenses.</p></header>
      <div class="fin-presets" role="group" aria-label="Period">${PRESETS.map(([k, l]) => `<button type="button" class="btn ${k === preset ? "btn--primary" : "btn--ghost"}" data-preset="${k}"><span>${l}</span></button>`).join("")}</div>
      <form class="adm-filters" data-range novalidate hidden>
        <div class="field"><label for="fd-from">From</label><input id="fd-from" type="date" /></div>
        <div class="field"><label for="fd-to">To</label><input id="fd-to" type="date" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <p class="muted" data-period></p>
      <div data-body><p class="muted">Loading…</p></div>
    </div>`;
  const body = /** @type {HTMLElement} */ (main.querySelector("[data-body]"));
  const form = /** @type {HTMLFormElement} */ (main.querySelector("[data-range]"));
  const alive = () => main.isConnected && main.querySelector("[data-body]") !== null;

  async function show() {
    /** @type {HTMLElement} */ (main.querySelector("[data-period]")).textContent = `${range.from} to ${range.to}`;
    body.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const d = await call("financeDashboard", range);
      if (!alive()) return;
      body.innerHTML = `
        <h2 class="adm-h2">Profit</h2>
        <div class="adm-stats">
          ${statCard({ label: "Total income", value: money(d.income.total), note: `Sales ${money(d.income.sales)} · other ${money(d.income.other)}` })}
          ${statCard({ label: "Total expenses", value: money(d.totalExpenses), note: `Cost of sales ${money(d.costOfSales)} · operating ${money(d.operatingExpenses)}` })}
          ${statCard({ label: "Gross profit", value: money(d.grossProfit), note: "income − cost of sales" })}
          ${statCard({ label: "Net profit", value: money(d.netProfit), note: "income − all expenses" })}
        </div>
        <h2 class="adm-h2">Today (${esc(d.today.date)})</h2>
        <div class="adm-stats">${statCard({ label: "Today's income", value: money(d.today.income) })}${statCard({ label: "Today's expenses", value: money(d.today.expenses) })}</div>
        <h2 class="adm-h2">Money right now</h2>
        <div class="adm-stats">
          ${statCard({ label: "Cash in hand", value: money(d.cash.inHand) })}
          ${statCard({ label: "Bank balance", value: money(d.cash.bank), note: `${d.cash.accounts.filter((a) => a.kind === "bank").length} account(s)` })}
          ${statCard({ label: "Wallet clearing", value: money(d.cash.wallet), note: "JazzCash / Easypaisa not yet in the bank" })}
          ${statCard({ label: "Outstanding receivables", value: money(d.receivables), note: "owed to you by customers" })}
          ${statCard({ label: "Outstanding payables", value: money(d.payables), note: "owed by you to suppliers" })}
        </div>
        ${d.incomplete.salesWithoutCost || d.incomplete.failedPostings ? `<p class="notice">${d.incomplete.salesWithoutCost ? `${d.incomplete.salesWithoutCost} sale(s) have no recorded cost, so profit may be overstated. ` : ""}${d.incomplete.failedPostings ? `${d.incomplete.failedPostings} accounting posting(s) failed and need attention in Accounting.` : ""}</p>` : ""}`;
    } catch (e) {
      if (alive()) {
        body.innerHTML = errorState(/set up/i.test(e?.message ?? "") ? "Accounting isn't set up yet. Create the chart of accounts first (Accounting → Chart of Accounts)." : messageOf(e));
        body.querySelector("[data-retry]")?.addEventListener("click", show);
      }
    }
  }
  main.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      preset = /** @type {HTMLElement} */ (b).dataset.preset;
      main.querySelectorAll("[data-preset]").forEach((x) => (x.className = `btn ${/** @type {HTMLElement} */ (x).dataset.preset === preset ? "btn--primary" : "btn--ghost"}`));
      form.hidden = preset !== "custom";
      if (preset === "custom") {
        /** @type {HTMLInputElement} */ (form.querySelector("#fd-from")).value = range.from;
        /** @type {HTMLInputElement} */ (form.querySelector("#fd-to")).value = range.to;
        return;
      }
      range = rangeFor(/** @type {any} */ (preset), todayKey());
      show();
    }),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const from = /** @type {HTMLInputElement} */ (form.querySelector("#fd-from")).value;
    const to = /** @type {HTMLInputElement} */ (form.querySelector("#fd-to")).value;
    if (!from || !to || to < from) return void (body.innerHTML = errorState("Choose a valid start and end date."));
    range = { from, to };
    show();
  });
  await show();
}
