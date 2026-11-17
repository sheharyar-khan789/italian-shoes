/** Inventory reports with date and warehouse filters, CSV export and a print / save-as-PDF view. All figures come from the server. */
import { esc } from "../../lib/format.js";
import { rangeFor } from "../../../shared/finance.js";
import { errorState } from "../ui/kit.js";
import { printDocument } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { todayKey, tableHtml, reportCsv, downloadText, messageOf, labelTables } from "../financeUi.js";

const REPORTS = [["summary", "Stock summary"], ["product", "Product stock"], ["size", "Size-wise stock"], ["colour", "Colour-wise stock"], ["warehouse", "Warehouse stock"], ["movements", "Stock movement ledger"], ["adjustments", "Stock adjustments"], ["transfers", "Stock transfers"], ["counts", "Physical stock counts"], ["valuation", "Inventory valuation"], ["low", "Low stock"], ["slow", "Slow-moving & dead stock"]];

export default async function inventoryReports({ main }) {
  const r0 = rangeFor("month", todayKey());
  /** @type {any} */
  let current = null;
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Inventory <em>reports</em></h1><p class="muted">Worked out by the server from the real inventory, cost, movement, adjustment, transfer and count records. Stock and valuation reports show stock now; movement, adjustment, transfer and count reports use the dates.</p></header>
      <form class="adm-filters" data-form novalidate>
        <div class="field"><label for="ir-report">Report</label><select id="ir-report">${REPORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
        <div class="field"><label for="ir-preset">Period</label><select id="ir-preset"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">This week</option><option value="month" selected>This month</option><option value="year">This year</option><option value="custom">Custom</option></select></div>
        <div class="field"><label for="ir-from">From</label><input id="ir-from" type="date" value="${r0.from}" /></div>
        <div class="field"><label for="ir-to">To</label><input id="ir-to" type="date" value="${r0.to}" /></div>
        <div class="field"><label for="ir-wh">Warehouse</label><select id="ir-wh"><option value="">All warehouses</option></select></div>
        <button type="submit" class="btn btn--primary"><span>Show report</span></button>
      </form>
      <p data-actions hidden><button type="button" class="btn btn--ghost" data-csv>Download CSV</button> <button type="button" class="btn btn--ghost" data-print>Print / save as PDF</button></p>
      <div data-out><p class="muted">Choose a report and press “Show report”.</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLElement} */ (main.querySelector(s));
  const out = $("[data-out]");
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  call("inventoryItems", {}).then((r) => $("#ir-wh").insertAdjacentHTML("beforeend", r.warehouses.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join(""))).catch(() => {});

  $("#ir-preset").addEventListener("change", (e) => {
    const p = /** @type {HTMLSelectElement} */ (e.target).value;
    if (p === "custom") return;
    const r = rangeFor(/** @type {any} */ (p), todayKey());
    /** @type {HTMLInputElement} */ ($("#ir-from")).value = r.from;
    /** @type {HTMLInputElement} */ ($("#ir-to")).value = r.to;
  });
  $("[data-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = /** @type {HTMLInputElement} */ ($("#ir-from")).value;
    const to = /** @type {HTMLInputElement} */ ($("#ir-to")).value;
    if (!from || !to || to < from) return void (out.innerHTML = errorState("Choose a valid start and end date."));
    const warehouseId = /** @type {HTMLSelectElement} */ ($("#ir-wh")).value;
    out.innerHTML = `<p class="muted">Loading…</p>`;
    $("[data-actions]").hidden = true;
    try {
      current = await call("inventoryReport", { report: /** @type {HTMLSelectElement} */ ($("#ir-report")).value, from, to, ...(warehouseId ? { warehouseId } : {}) });
      if (!alive()) return;
      out.innerHTML = `<h2 class="adm-h2">${esc(current.title)}</h2><p class="muted">${esc(current.from)} to ${esc(current.to)}</p>${current.tables.map(tableHtml).join("")}${current.notes?.length ? `<p class="muted">${current.notes.map(esc).join(" ")}</p>` : ""}`;
      labelTables(out);
      $("[data-actions]").hidden = false;
    } catch (err) {
      if (alive()) out.innerHTML = errorState(messageOf(err));
    }
  });
  $("[data-csv]").addEventListener("click", () => current && downloadText(`${current.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${current.from}_${current.to}.csv`, reportCsv(current)));
  $("[data-print]").addEventListener("click", () => {
    if (!current) return;
    const ok = printDocument(current.title, `<h1>${esc(current.title)}</h1><p class="muted">${esc(current.from)} to ${esc(current.to)}</p>${current.tables.map(tableHtml).join("")}${(current.notes ?? []).map((n) => `<p class="muted">${esc(n)}</p>`).join("")}`);
    if (!ok) out.insertAdjacentHTML("afterbegin", `<p class="form-alert" role="alert">Your browser blocked the print window. Allow pop-ups for this site and try again.</p>`);
  });
}
