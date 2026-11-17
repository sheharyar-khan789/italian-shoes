/** POS reports: from the saved POS sales and register sessions, aggregated on the server for a chosen date range. */
import { esc } from "../../lib/format.js";
import { statCard, errorState, formatWhen } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const METHOD = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
const diff = (v) => (v === null || v === undefined ? "—" : v === 0 ? "Exact" : v < 0 ? `Shortage ${money(-v)}` : `Excess ${money(v)}`);

export default async function posReports({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">POS <em>reports</em></h1><p class="muted">From saved POS sales and register sessions. Cancelled sales are not excluded here; each sale is listed as it was rung up.</p></header>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="pr-from">From</label><input id="pr-from" type="date" value="${ymd(new Date(Date.now() - 7 * 86400000))}" /></div>
        <div class="field"><label for="pr-to">To</label><input id="pr-to" type="date" value="${ymd(new Date())}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show report</span></button>
      </form>
      <div data-report><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-report]"));
  const alive = () => main.isConnected && main.querySelector("[data-report]") !== null;
  const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const group = (t) => [String(t.sales), String(t.units), esc(money(t.grossSales)), esc(money(t.discounts)), `<strong>${esc(money(t.netSales))}</strong>`, esc(money(t.total))];
  const GH = ["Sales", "Pairs", "Gross", "Discounts", "Net sales", "Total"];

  async function show() {
    const from = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#pr-from")).value}T00:00:00`);
    const to = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#pr-to")).value}T23:59:59`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return void (box.innerHTML = errorState("Choose a valid start and end date."));
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("posReport", { from: from.toISOString(), to: to.toISOString() });
      if (!alive()) return;
      box.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "POS sales", value: String(r.totals.sales), note: `${r.totals.units} pairs` })}
          ${statCard({ label: "Net sales", value: money(r.totals.netSales) })}
          ${statCard({ label: "Money received", value: money(r.collected), note: "recorded payments less refunds" })}
          ${statCard({ label: "Still to collect", value: money(r.stillDue) })}
        </div>
        <h2 class="adm-h2">By day</h2>${r.byDay.length ? table(["Day", ...GH], r.byDay.map((d) => [esc(d.day), ...group(d)])) : `<p class="muted">No POS sales in this period.</p>`}
        <h2 class="adm-h2">By cashier</h2>${r.byCashier.length ? table(["Cashier", ...GH], r.byCashier.map((c) => [esc(c.name ?? c.uid), ...group(c)])) : `<p class="muted">None.</p>`}
        <h2 class="adm-h2">By warehouse</h2>${r.byWarehouse.length ? table(["Warehouse", ...GH], r.byWarehouse.map((w) => [esc(w.name), ...group(w)])) : `<p class="muted">None.</p>`}
        <h2 class="adm-h2">By payment method</h2>${Object.keys(r.byMethod).length ? table(["Method", "Taken"], Object.entries(r.byMethod).map(([m, v]) => [esc(METHOD[m] ?? m), esc(money(v))])) : `<p class="muted">None.</p>`}
        <h2 class="adm-h2">Cash shortages and excesses</h2>
        <div class="adm-stats">
          ${statCard({ label: "Shortages", value: money(-r.cash.shortages), note: `${r.cash.sessionsWithShortage} register${r.cash.sessionsWithShortage === 1 ? "" : "s"}` })}
          ${statCard({ label: "Excesses", value: money(r.cash.excesses), note: `${r.cash.sessionsWithExcess} register${r.cash.sessionsWithExcess === 1 ? "" : "s"}` })}
        </div>
        <h2 class="adm-h2">Register sessions</h2>${r.sessions.length ? table(["Register", "Cashier", "Warehouse", "Opened", "Status", "Sales", "Expected", "Counted", "Difference"], r.sessions.map((s) => [`<strong>${esc(s.number)}</strong>`, esc(s.cashierName), esc(s.warehouseName ?? ""), esc(s.openedAt ? formatWhen(new Date(s.openedAt)) : "—"), s.status === "open" ? `<span class="tag">Open</span>` : "Closed", `${s.saleCount ?? 0} · ${esc(money(s.salesTotal ?? 0))}`, esc(money(s.expectedCash ?? 0)), esc(s.countedCash === null ? "—" : money(s.countedCash)), esc(diff(s.variance))])) : `<p class="muted">No registers in this period.</p>`}`;
    } catch (e) {
      if (alive()) {
        box.innerHTML = errorState(e?.code && e.code !== "functions/internal" ? e.message : undefined);
        box.querySelector("[data-retry]")?.addEventListener("click", show);
      }
    }
  }
  main.querySelector("[data-range]").addEventListener("submit", (e) => {
    e.preventDefault();
    show();
  });
  await show();
}
