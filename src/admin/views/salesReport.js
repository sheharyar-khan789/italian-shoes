/**
 * Sales report: online, POS (a placeholder until the POS exists) and combined figures from the saved sales,
 * payment-method breakdown, and (for staff who may see costs) gross profit from the cost saved with each sale.
 */
import { esc } from "../../lib/format.js";
import { statCard, errorState } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { SALE_PAYMENT_LABEL, SALE_STATUS_LABEL } from "../../../shared/sales.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function salesReport({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Sales <em>report</em></h1>
        <p class="muted">From your saved sales. Counted sales exclude cancelled, returned and refunded ones. Net sales = list prices − discounts (delivery and tax are shown separately).</p>
      </header>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="sr-from">From</label><input id="sr-from" type="date" value="${ymd(new Date(Date.now() - 30 * 86400000))}" /></div>
        <div class="field"><label for="sr-to">To</label><input id="sr-to" type="date" value="${ymd(new Date())}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show report</span></button>
      </form>
      <div data-report><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-report]"));
  const alive = () => main.isConnected && main.querySelector("[data-report]") !== null;
  const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const channel = (t) => [String(t.sales), esc(money(t.grossSales)), esc(money(t.itemDiscounts + t.couponDiscounts)), `<strong>${esc(money(t.netSales))}</strong>`, esc(money(t.deliveryCharges)), esc(money(t.total))];

  async function show() {
    const from = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#sr-from")).value}T00:00:00`);
    const to = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#sr-to")).value}T23:59:59`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      box.innerHTML = errorState("Choose a valid start and end date.");
      return;
    }
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("salesSummary", { from: from.toISOString(), to: to.toISOString() });
      if (!alive()) return;
      const p = r.profit;
      box.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Combined net sales", value: money(r.combined.netSales), note: `${r.combined.sales} sale${r.combined.sales === 1 ? "" : "s"} · ${r.combined.units} pairs` })}
          ${statCard({ label: "Combined total (with delivery)", value: money(r.combined.total) })}
          ${statCard({ label: "Money received", value: money(r.collected), note: "recorded payments less refunds" })}
          ${statCard({ label: "Still to collect", value: money(r.stillDue) })}
        </div>
        <h2 class="adm-h2">By channel</h2>
        ${table(["Channel", "Sales", "Gross sales", "Discounts", "Net sales", "Delivery", "Total"], [["Online", ...channel(r.online)], ["POS", ...(r.pos.sales ? channel(r.pos) : ["0", "—", "—", "—", "—", "—"])], ["<strong>Combined</strong>", ...channel(r.combined)]])}
        ${r.pos.note ? `<p class="muted">${esc(r.pos.note)}</p>` : ""}
        <h2 class="adm-h2">Payment method</h2>
        ${Object.keys(r.byMethod).length ? table(["Method (as chosen)", "Sales", "Total"], Object.entries(r.byMethod).map(([m, v]) => [esc(SALE_PAYMENT_LABEL[m] ?? m), String(v.sales), esc(money(v.total))])) : `<p class="muted">No sales in this period.</p>`}
        <h2 class="adm-h2">All sales by status</h2>
        ${Object.keys(r.byStatus).length ? table(["Status", "Sales"], Object.entries(r.byStatus).map(([k, v]) => [esc(SALE_STATUS_LABEL[k] ?? k), String(v)])) : `<p class="muted">No sales in this period.</p>`}
        ${
          p
            ? `<h2 class="adm-h2">Cost and gross profit</h2>
        <div class="adm-stats">
          ${statCard({ label: "Cost of goods sold", value: money(p.costOfGoods), note: `${p.salesWithCost} sale${p.salesWithCost === 1 ? "" : "s"} with a recorded cost` })}
          ${statCard({ label: "Gross profit", value: money(p.grossProfit), note: p.marginPercent === null ? "" : `${p.marginPercent}% of net sales` })}
        </div>
        ${p.salesWithoutCost ? `<p class="muted">${p.salesWithoutCost} sale${p.salesWithoutCost === 1 ? "" : "s"} (net ${esc(money(p.netSalesWithoutCost))}) have no recorded cost, so they are left out of the profit figures rather than guessed.</p>` : ""}
        <p class="muted"><strong>Gross profit is not net profit.</strong> It is net sales minus the cost of the goods, using the cost saved with each sale. Expenses, salaries, rent and other accounts come in a later phase.</p>`
            : ""
        }`;
    } catch {
      if (alive()) {
        box.innerHTML = errorState();
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
