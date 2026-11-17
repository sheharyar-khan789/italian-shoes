/**
 * Purchase reports, computed by the server from the real goods received, returns and payments in a date range.
 * "Purchased" counts only ACCEPTED goods; "we owe" is the supplier balances right now.
 */
import { esc } from "../../lib/format.js";
import { statCard, errorState, emptyState } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { SUPPLIER_PAY_LABEL } from "../../../shared/purchase.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function purchaseReports({ main }) {
  const to0 = new Date();
  const from0 = new Date(Date.now() - 30 * 86400000);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Purchase <em>reports</em></h1>
        <p class="muted">Figures come straight from your goods received notes, returns and payments. Rejected or damaged pairs are not counted as purchases.</p>
      </header>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="pr-from">From</label><input id="pr-from" type="date" value="${ymd(from0)}" /></div>
        <div class="field"><label for="pr-to">To</label><input id="pr-to" type="date" value="${ymd(to0)}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show report</span></button>
      </form>
      <div data-report><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-report]"));
  const alive = () => main.isConnected && main.querySelector("[data-report]") !== null;

  async function show() {
    const from = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#pr-from")).value}T00:00:00`);
    const to = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#pr-to")).value}T23:59:59`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      box.innerHTML = errorState("Choose a valid start and end date.");
      return;
    }
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("purchaseReport", { from: from.toISOString(), to: to.toISOString() });
      if (!alive()) return;
      const table = (head, rows) => (rows.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : emptyState({ title: "Nothing in this period" }));
      box.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Purchased", value: money(r.purchased), note: `${r.receipts} goods received note${r.receipts === 1 ? "" : "s"}` })}
          ${statCard({ label: "Returned", value: money(r.returned) })}
          ${statCard({ label: "Net purchases", value: money(r.netPurchases) })}
          ${statCard({ label: "Paid to suppliers", value: money(r.paid) })}
          ${statCard({ label: "We owe suppliers now", value: money(r.payable), note: "all suppliers, today" })}
          ${statCard({ label: "Pairs accepted", value: r.acceptedUnits, note: r.rejectedUnits ? `${r.rejectedUnits} rejected` : "" })}
        </div>
        <h2 class="adm-h2">By supplier</h2>
        ${table(["Supplier", "Purchased", "Returned", "Paid"], r.bySupplier.map((s) => [`<a class="text-link" href="/admin/suppliers/${esc(s.supplierId)}" data-link>${esc(s.name)}</a>`, esc(money(s.purchased)), esc(money(s.returned)), esc(money(s.paid))]))}
        <h2 class="adm-h2">Most purchased items</h2>
        ${table(["Item", "Pairs", "Value"], r.topItems.map((i) => [`${esc(i.name)}<br /><span class="muted">${esc(i.label)}</span>`, String(i.units), esc(money(i.value))]))}
        <h2 class="adm-h2">Payments by method</h2>
        ${table(["Method", "Paid"], Object.entries(r.paidByMethod).map(([m, v]) => [esc(SUPPLIER_PAY_LABEL[m] ?? m), esc(money(/** @type {number} */ (v)))]))}
        <h2 class="adm-h2">Suppliers with a balance</h2>
        ${table(["Supplier", "We owe"], r.owing.map((s) => [`<a class="text-link" href="/admin/suppliers/${esc(s.supplierId)}" data-link>${esc(s.name)}</a>${s.isActive ? "" : ` <span class="tag tag--out">Off</span>`}`, esc(money(s.balance))]))}`;
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
