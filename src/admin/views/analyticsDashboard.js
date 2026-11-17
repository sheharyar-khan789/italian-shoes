/**
 * Executive business dashboard (Owner only). Sales, stock and customer figures come from the saved records; revenue, cost of goods sold, expenses,
 * profit, cash, bank, receivables and payables come only from posted journals. The page says which is which and shows the reconciliation
 * between the two instead of hiding differences.
 */
import { esc } from "../../lib/format.js";
import { statCard, errorState } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { PRESETS, presetDates, comparisonFor, adminTable, showReport, exportButtons, wireExports, messageOf } from "../analyticsUi.js";

const pctNote = (g, what = "previous period") => (g === null || g === undefined ? "nothing to compare with" : `${g > 0 ? "+" : ""}${g}% vs ${what}`);
const num = (v) => (v === null || v === undefined ? "—" : v);
const row = (item, value) => ({ item, value });

/** The dashboard in the shared report shape (for the screen's tables and for CSV / Excel / print). */
function asReport(e) {
  const s = e.sales;
  const f = e.financial;
  const i = e.inventory;
  const c = e.customers;
  const m = (v) => (v === null || v === undefined ? "—" : { money: v });
  const col = [{ key: "item", label: "Measure", type: "text" }, { key: "value", label: "Value", type: "mixed" }];
  const tables = [
    { title: "Sales performance (from the saved sales)", columns: col, rows: [row("Total sales (incl. delivery and tax)", m(s.totalSales)), row("Net sales (before delivery and tax)", m(s.netSales)), row("Total orders", s.orders), row("Pairs sold", s.units), row("Average order value", m(s.averageOrder)), row("Discounts given", m(s.discounts)), row("Sales returns (refunded)", m(s.returns)), row("Sales growth vs previous period %", num(s.growth))], totals: null },
    ...(f ? [{ title: "Financial performance (from posted journals — verified)", columns: col, rows: [row("Total revenue (net)", m(f.revenue)), row("Cost of goods sold", m(f.cogs)), row("Gross profit", m(f.grossProfit)), row("Operating expenses", m(f.operatingExpenses)), row("Net profit", m(f.netProfit)), row("Gross margin %", num(f.grossMargin)), row("Net margin %", num(f.netMargin)), row("Cash in hand", m(f.cash)), row("Bank balance", m(f.bank)), row("Mobile-wallet clearing", m(f.wallet)), row("Accounts receivable", m(f.receivables)), row("Accounts payable", m(f.payables))], totals: null }, { title: "Reconciliation: sale records against the books", columns: [{ key: "item", label: "Line", type: "text" }, { key: "amount", label: "Amount", type: "money" }], rows: e.reconciliation, totals: null }] : []),
    { title: "Inventory performance", columns: col, rows: [row("Total stock (pairs)", i.units), row("Inventory valuation (weighted average cost)", m(i.valuation)), row("Inventory in the books", m(i.books)), row("Low-stock variants", num(i.low)), row("Out-of-stock variants", num(i.out)), row("Fast-moving variants (estimate, 90 days)", i.fast), row("Slow-moving variants (estimate, 90 days)", i.slow), row("Dead-stock variants (estimate, 90 days)", i.dead), row("Dead-stock value (estimate)", m(i.deadValue)), row("Stock turnover (cost of goods ÷ average inventory)", num(i.turnover))], totals: null },
    { title: "Customer performance", columns: col, rows: [row("Total customers", num(c.total)), row("New customers", num(c.newCustomers)), row("Returning customers", num(c.returning)), row("VIP customers", num(c.vip)), row("Inactive customers", num(c.inactive)), row("Registered customers who bought in the period", c.buyers), row("Customer retention % (bought last period and again)", num(c.retention)), row("Repeat purchase rate %", num(c.repeatRate)), row("Average customer spending", m(c.averageSpending)), row("Customer lifetime value (average total spent)", m(c.lifetimeValue))], totals: null },
  ];
  return { title: "Executive business dashboard", report: "executive", from: e.from, to: e.to, tables, charts: e.charts, notes: [...(e.financialNote ? [e.financialNote] : []), ...e.notes], estimates: [] };
}

export default async function analyticsDashboard({ main, user }) {
  const t0 = presetDates("month");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Business <em>dashboard</em></h1><p class="muted">One view of sales, profit, cash, stock and customers. Every figure is calculated from your real records; nothing is typed in.</p></header>
      <form class="adm-filters an-filters" data-form novalidate>
        <div class="field"><label for="ex-preset">Period</label><select id="ex-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === "month" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="ex-from">From</label><input id="ex-from" type="date" value="${t0.from}" /></div>
        <div class="field"><label for="ex-to">To</label><input id="ex-to" type="date" value="${t0.to}" /></div>
        <label class="check"><input id="ex-compare" type="checkbox" checked /> Compare with the period before</label>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      ${exportButtons(user.perms)}
      <div data-out><p class="muted">Loading…</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLInputElement} */ (main.querySelector(s));
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  /** @type {any} */
  let current = null;

  async function show() {
    const from = $("#ex-from").value;
    const to = $("#ex-to").value;
    if (!from || !to || to < from) return void (out.innerHTML = errorState("Choose a valid start and end date."));
    out.innerHTML = `<p class="muted">Calculating…</p>`;
    const exp = main.querySelector("[data-exports]");
    if (exp) /** @type {HTMLElement} */ (exp).hidden = true;
    try {
      const e = await call("analyticsExecutive", { from, to, ...($("#ex-compare").checked ? comparisonFor(from, to) : { compareFrom: "", compareTo: "" }) });
      if (!alive()) return;
      current = asReport(e);
      const s = e.sales;
      const f = e.financial;
      const i = e.inventory;
      const c = e.customers;
      out.innerHTML = `
        <h2 class="adm-h2">Sales performance</h2>
        <div class="adm-stats">
          ${statCard({ label: "Total sales", value: money(s.totalSales), note: pctNote(s.growth) })}
          ${statCard({ label: "Net sales", value: money(s.netSales), note: "before delivery and tax" })}
          ${statCard({ label: "Orders", value: s.orders, note: pctNote(s.ordersGrowth) })}
          ${statCard({ label: "Average order", value: money(s.averageOrder) })}
          ${statCard({ label: "Discounts given", value: money(s.discounts) })}
          ${statCard({ label: "Refunded to customers", value: money(s.returns) })}
        </div>
        ${f ? `<h2 class="adm-h2">Financial performance <span class="muted">(posted journals)</span></h2>
        <div class="adm-stats">
          ${statCard({ label: "Revenue", value: money(f.revenue), note: pctNote(f.revenueGrowth) })}
          ${statCard({ label: "Cost of goods sold", value: money(f.cogs) })}
          ${statCard({ label: "Gross profit", value: money(f.grossProfit), note: f.grossMargin === null ? "" : `${f.grossMargin}% margin` })}
          ${statCard({ label: "Operating expenses", value: money(f.operatingExpenses) })}
          ${statCard({ label: "Net profit", value: money(f.netProfit), note: f.netMargin === null ? "" : `${f.netMargin}% margin` })}
          ${statCard({ label: "Cash in hand", value: money(f.cash) })}
          ${statCard({ label: "Bank balance", value: money(f.bank), note: f.wallet ? `+ ${money(f.wallet)} in mobile wallets` : "" })}
          ${statCard({ label: "Receivable", value: money(f.receivables), note: "owed by customers" })}
          ${statCard({ label: "Payable", value: money(f.payables), note: "owed to suppliers" })}
        </div>
        ${f.incomplete?.note ? `<p class="form-alert" role="status">${esc(f.incomplete.note)}</p>` : ""}` : `<p class="form-alert" role="status">${esc(e.financialNote)}</p>`}
        <h2 class="adm-h2">Inventory performance</h2>
        <div class="adm-stats">
          ${statCard({ label: "Pairs in stock", value: i.units })}
          ${statCard({ label: "Inventory valuation", value: money(i.valuation), note: i.books === null ? "" : `books: ${money(i.books)}` })}
          ${statCard({ label: "Low stock", value: num(i.low), href: "/admin/inventory-dashboard" })}
          ${statCard({ label: "Out of stock", value: num(i.out), href: "/admin/inventory-dashboard" })}
          ${statCard({ label: "Fast moving", value: i.fast, note: "estimate, last 90 days" })}
          ${statCard({ label: "Slow moving", value: i.slow, note: "estimate, last 90 days" })}
          ${statCard({ label: "Dead stock", value: i.dead, note: i.deadValue ? `${money(i.deadValue)} (estimate)` : "estimate" })}
          ${statCard({ label: "Stock turnover", value: i.turnover === null ? "—" : `${i.turnover}×`, note: "cost of goods ÷ average stock" })}
        </div>
        ${i.unitsWithoutCost ? `<p class="muted">${i.unitsWithoutCost} pairs have no recorded cost and are valued at zero.</p>` : ""}
        <h2 class="adm-h2">Customer performance</h2>
        <div class="adm-stats">
          ${statCard({ label: "Customers", value: num(c.total), href: "/admin/crm" })}
          ${statCard({ label: "New customers", value: num(c.newCustomers) })}
          ${statCard({ label: "Returning", value: num(c.returning) })}
          ${statCard({ label: "VIP", value: num(c.vip) })}
          ${statCard({ label: "Retention", value: c.retention === null ? "—" : `${c.retention}%`, note: "bought last period and again" })}
          ${statCard({ label: "Average spending", value: money(c.averageSpending), note: "per buying customer" })}
          ${statCard({ label: "Lifetime value", value: c.lifetimeValue === null ? "—" : money(c.lifetimeValue), note: "average total spent" })}
        </div>
        <div data-detail></div>`;
      const detail = /** @type {HTMLElement} */ (out.querySelector("[data-detail]"));
      showReport(detail, { ...current, tables: [] });
      if (e.reconciliation) detail.insertAdjacentHTML("beforeend", adminTable(current.tables.find((t) => t.title.startsWith("Reconciliation"))));
      if (e.cached) out.insertAdjacentHTML("afterbegin", `<p class="muted">Served from a short-lived cache: nothing it depends on has changed since it was calculated.</p>`);
      if (exp) /** @type {HTMLElement} */ (exp).hidden = false;
    } catch (err) {
      if (alive()) {
        out.innerHTML = errorState(messageOf(err));
        out.querySelector("[data-retry]")?.addEventListener("click", show);
      }
    }
  }
  $("#ex-preset").addEventListener("change", (ev) => {
    const r = presetDates(/** @type {HTMLSelectElement} */ (ev.target).value);
    if (!r) return;
    $("#ex-from").value = r.from;
    $("#ex-to").value = r.to;
  });
  main.querySelector("[data-form]")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    show();
  });
  wireExports(main, () => current);
  await show();
}
