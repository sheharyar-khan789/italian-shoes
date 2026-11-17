/**
 * Purchase dashboard and reports. Every figure comes from the saved goods receipts, returns, payments, refunds, orders
 * and the supplier ledger (worked out on the server). Reports have date filters, CSV export and a print / PDF view.
 */
import { esc } from "../../lib/format.js";
import { rangeFor } from "../../../shared/finance.js";
import { statCard, errorState } from "../ui/kit.js";
import { printDocument } from "../ui/purchasing.js";
import { call, listSuppliers } from "../purchData.js";
import { todayKey, money, tableHtml, reportCsv, downloadText, messageOf, labelTables } from "../financeUi.js";

const REPORTS = [["register", "Purchase register"], ["supplier", "Supplier-wise purchases"], ["product", "Product-wise purchases"], ["returns", "Purchase returns"], ["outstanding", "Supplier outstanding"], ["ledger", "Supplier ledger"], ["grn", "Goods receiving"]];
const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["year", "This year"], ["custom", "Custom"]];

export default async function purchaseDashboard({ main }) {
  let range = rangeFor("month", todayKey());
  /** @type {any} */
  let current = null;
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Purchase <em>dashboard</em></h1>
        <p class="muted">Purchases are counted when goods are received (accepted pairs), not when an order is placed. Figures are worked out from your saved records.</p></header>
      <form class="adm-filters" data-form novalidate>
        <div class="field"><label for="pd-preset">Period</label><select id="pd-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === "month" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="pd-from">From</label><input id="pd-from" type="date" value="${range.from}" /></div>
        <div class="field"><label for="pd-to">To</label><input id="pd-to" type="date" value="${range.to}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <div data-dash><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Reports</h2>
      <form class="adm-filters" data-report-form novalidate>
        <div class="field"><label for="pd-report">Report</label><select id="pd-report">${REPORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
        <div class="field" data-supplier-field hidden><label for="pd-supplier">Supplier</label><select id="pd-supplier"><option value="">Choose a supplier…</option></select></div>
        <button type="submit" class="btn btn--ghost"><span>Show report (uses the period above)</span></button>
      </form>
      <p data-actions hidden><button type="button" class="btn btn--ghost" data-csv>Download CSV</button> <button type="button" class="btn btn--ghost" data-print>Print / save as PDF</button></p>
      <div data-out></div>
    </div>`;
  const $ = (s) => /** @type {HTMLElement} */ (main.querySelector(s));
  const alive = () => main.isConnected && main.querySelector("[data-dash]") !== null;

  async function showDash() {
    const box = $("[data-dash]");
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const d = await call("purchaseDashboard", range);
      if (!alive()) return;
      box.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Total purchases", value: money(d.purchases), note: `${d.receipts} goods receipt${d.receipts === 1 ? "" : "s"}` })}
          ${statCard({ label: "Pending orders", value: String(d.pendingOrders.count), note: `${money(d.pendingOrders.value)} still to arrive · ${d.drafts} draft${d.drafts === 1 ? "" : "s"}` })}
          ${statCard({ label: "Partially received", value: String(d.partiallyReceived.count), note: `${money(d.partiallyReceived.value)} still to arrive` })}
          ${statCard({ label: "Supplier payables", value: money(d.payables), note: d.supplierCredits ? `plus ${money(d.supplierCredits)} held as supplier credit` : "owed to suppliers now" })}
          ${statCard({ label: "Supplier payments", value: money(d.payments), note: d.advancePayments ? `${money(d.advancePayments)} paid in advance` : "paid in this period" })}
          ${statCard({ label: "Purchase returns", value: money(d.returns), note: d.refunds ? `${money(d.refunds)} refunded by suppliers` : "credit notes in this period" })}
        </div>
        <h2 class="adm-h2">Recent purchases</h2>
        ${d.recent.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>GRN</th><th>Order</th><th>Supplier</th><th>Accepted</th><th>Rejected</th><th>Value</th></tr></thead><tbody>${d.recent.map((r) => `<tr><td>${esc(r.date)}</td><td><code>${esc(r.number)}</code></td><td>${esc(r.order ?? "")}</td><td>${esc(r.supplier)}</td><td>${r.acceptedUnits}</td><td>${r.rejectedUnits}</td><td>${esc(money(r.value))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No goods have been received yet.</p>`}`;
      labelTables(box);
    } catch (e) {
      if (alive()) {
        box.innerHTML = errorState(messageOf(e));
        box.querySelector("[data-retry]")?.addEventListener("click", showDash);
      }
    }
  }

  $("#pd-preset").addEventListener("change", (e) => {
    const p = /** @type {HTMLSelectElement} */ (e.target).value;
    if (p === "custom") return;
    range = rangeFor(/** @type {any} */ (p), todayKey());
    /** @type {HTMLInputElement} */ ($("#pd-from")).value = range.from;
    /** @type {HTMLInputElement} */ ($("#pd-to")).value = range.to;
    showDash();
  });
  $("[data-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const from = /** @type {HTMLInputElement} */ ($("#pd-from")).value;
    const to = /** @type {HTMLInputElement} */ ($("#pd-to")).value;
    if (!from || !to || to < from) return void ($("[data-dash]").innerHTML = errorState("Choose a valid start and end date."));
    range = { from, to };
    showDash();
  });
  $("#pd-report").addEventListener("change", (e) => {
    $("[data-supplier-field]").hidden = /** @type {HTMLSelectElement} */ (e.target).value !== "ledger";
  });
  listSuppliers()
    .then((list) => $("#pd-supplier").insertAdjacentHTML("beforeend", list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")))
    .catch(() => {});

  $("[data-report-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("[data-out]");
    const report = /** @type {HTMLSelectElement} */ ($("#pd-report")).value;
    const supplierId = /** @type {HTMLSelectElement} */ ($("#pd-supplier")).value;
    if (report === "ledger" && !supplierId) return void (out.innerHTML = errorState("Choose a supplier for the ledger."));
    out.innerHTML = `<p class="muted">Loading…</p>`;
    $("[data-actions]").hidden = true;
    try {
      current = await call("purchaseReportTables", { report, ...range, ...(report === "ledger" ? { supplierId } : {}) });
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
    if (!ok) $("[data-out]").insertAdjacentHTML("afterbegin", `<p class="form-alert" role="alert">Your browser blocked the print window. Allow pop-ups for this site and try again.</p>`);
  });
  await showDash();
}
