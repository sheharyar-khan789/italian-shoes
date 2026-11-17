/**
 * Accounting reports: profit & loss, balance sheet, cash flow and reconciliation — all derived from posted journals.
 * Any figure that can't be complete is labelled; the reconciliation reports problems and repairs nothing.
 */
import { esc } from "../../lib/format.js";
import { errorState, statCard } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { RECONCILE_STAGES } from "../../../shared/schemas/index.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TABS = ["Profit & loss", "Balance sheet", "Cash flow", "Reconciliation"];
const STAGE_LABEL = { journals: "Journal integrity", sales: "Sales", grn: "Goods received", supplierPayments: "Supplier payments", purchaseReturns: "Purchase returns", customerPayments: "Customer payments", suppliers: "Supplier balances" };

export default async function accountingReports({ main }) {
  const now = new Date();
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Accounting <em>reports</em></h1>
        <p class="muted">Derived from posted journals only. Figures excluded for lack of data are explained on each report.</p></header>
      <div class="adm-tabs" role="tablist" aria-label="Reports">${TABS.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${t}</button>`).join("")}</div>
      <form class="adm-filters" data-range novalidate>
        <div class="field" data-from><label for="ar-from">From</label><input id="ar-from" type="date" value="${ymd(new Date(now.getFullYear(), now.getMonth(), 1))}" /></div>
        <div class="field"><label for="ar-to">To / as at</label><input id="ar-to" type="date" value="${ymd(now)}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <div data-report><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-report]"));
  const alive = () => main.isConnected && main.querySelector("[data-report]") !== null;
  let tab = 0;
  const val = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id)).value;
  const table = (head, rows) => (rows.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nothing in this period.</p>`);
  const acct = (r) => [`<code>${esc(r.code)}</code> ${esc(r.name)}`, esc(money(r.amount))];

  async function reconcile() {
    box.innerHTML = `<p class="muted">Checking…</p>`;
    const issues = [];
    let scanned = 0;
    for (const stage of RECONCILE_STAGES) {
      let cursor = null;
      do {
        const r = await call("reconcile", { stage, cursor });
        if (!alive()) return;
        issues.push(...r.issues.map((i) => ({ ...i, stage })));
        scanned += r.scanned;
        cursor = r.nextCursor;
        box.innerHTML = `<p class="muted">Checking ${esc(STAGE_LABEL[stage])}… ${scanned} records checked</p>`;
      } while (cursor);
    }
    const errors = issues.filter((i) => i.severity === "error");
    box.innerHTML = `<div class="adm-stats">${statCard({ label: "Records checked", value: scanned })}${statCard({ label: "Problems", value: errors.length, note: errors.length ? "need attention" : "none found" })}${statCard({ label: "Notes", value: issues.length - errors.length, note: "expected gaps, e.g. before accounting began" })}</div>
      <p class="muted">This only reports. Nothing is changed or repaired automatically; missing journals from before accounting began are added with the historical backfill, which is run on request.</p>
      ${issues.length ? table(["Level", "Type", "Record", "Detail"], issues.map((i) => [`<span class="tag ${i.severity === "error" ? "tag--out" : "tag--low"}">${esc(i.severity)}</span>`, esc(i.type), esc(`${i.sourceType} ${i.sourceId}`), esc(i.message)])) : `<p>Everything checked agrees.</p>`}`;
  }

  async function show() {
    main.querySelector("[data-from]").toggleAttribute("hidden", tab === 1 || tab === 3);
    if (tab === 3) return reconcile();
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      if (tab === 0) {
        const r = await call("profitAndLoss", { from: val("#ar-from"), to: val("#ar-to") });
        if (!alive()) return;
        box.innerHTML = `<div class="adm-stats">${statCard({ label: "Net revenue", value: money(r.netRevenue) })}${statCard({ label: "Gross profit", value: money(r.grossProfit), note: r.incomplete.salesWithoutCost ? "incomplete — see note" : "" })}${statCard({ label: "Operating expenses", value: money(r.operatingExpensesTotal) })}${statCard({ label: "Net profit", value: money(r.netProfit), note: r.incomplete.salesWithoutCost ? "overstated — see note" : "" })}</div>
          ${r.incomplete.note ? `<p class="form-alert">${esc(r.incomplete.note)}</p>` : ""}
          <h2 class="adm-h2">Revenue</h2>${table(["Account", "Amount"], r.revenue.map(acct))}
          <h2 class="adm-h2">Cost of sales</h2>${table(["Account", "Amount"], r.costOfSales.map(acct))}
          <h2 class="adm-h2">Operating expenses</h2>${table(["Account", "Amount"], r.operatingExpenses.map(acct))}
          <p class="muted">Gross profit = net revenue − cost of sales. Net profit = gross profit − operating expenses. Both use only what has been posted.</p>`;
      } else if (tab === 1) {
        const r = await call("balanceSheet", { asOf: val("#ar-to") });
        if (!alive()) return;
        box.innerHTML = `<div class="adm-stats">${statCard({ label: "Assets", value: money(r.totals.assets) })}${statCard({ label: "Liabilities", value: money(r.totals.liabilities) })}${statCard({ label: "Equity + current earnings", value: money(r.totals.equity + r.totals.currentEarnings) })}${statCard({ label: r.balanced ? "Balanced" : "NOT BALANCED", value: r.balanced ? "✓" : "✗" })}</div>
          <h2 class="adm-h2">Assets</h2>${table(["Account", "Amount"], r.assets.map(acct))}
          <h2 class="adm-h2">Liabilities</h2>${table(["Account", "Amount"], r.liabilities.map(acct))}
          <h2 class="adm-h2">Equity</h2>${table(["Account", "Amount"], [...r.equity.map(acct), ["Current earnings (revenue − expenses to date)", esc(money(r.totals.currentEarnings))]])}
          <p class="muted">${esc(r.note)}</p>`;
      } else {
        const r = await call("cashFlow", { from: val("#ar-from"), to: val("#ar-to") });
        if (!alive()) return;
        box.innerHTML = `<div class="adm-stats">${statCard({ label: "Opening", value: money(r.openingTotal) })}${statCard({ label: "Received", value: money(r.received) })}${statCard({ label: "Paid out", value: money(r.paid) })}${statCard({ label: "Closing", value: money(r.closingTotal) })}</div>
          ${table(["Account", "Opening", "Closing"], r.accounts.map((a) => [`<code>${esc(a.code)}</code> ${esc(a.name)}`, esc(money(a.opening)), esc(money(a.closing))]))}
          <p class="muted">${esc(r.note)}</p>`;
      }
    } catch (error) {
      if (alive()) box.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : /** @type {Error} */ (error).message);
    }
  }
  main.querySelector(".adm-tabs").addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
    if (!b) return;
    tab = Number(/** @type {HTMLElement} */ (b).dataset.tab);
    main.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    show();
  });
  main.querySelector("[data-range]").addEventListener("submit", (e) => {
    e.preventDefault();
    show();
  });
  await show();
}
