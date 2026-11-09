/**
 * Analytics & reports, computed from real orders and stock when you open the page.
 * Nothing is estimated; with no orders every number is zero and the page says so.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { statCard, errorState, emptyState } from "../ui/kit.js";
import { call } from "../engageData.js";
import { fnResult } from "./catalogue.js";
import { STATUS_LABEL } from "../../ui/orderLabels.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function reports({ main, user }) {
  const canSales = user.perms.includes("reports.sales");
  const canStock = user.perms.includes("reports.inventory");
  const today = new Date();
  const monthAgo = new Date(Date.now() - 29 * 86400000);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Analytics <em>&amp; reports</em></h1>
        <p class="muted">Figures come straight from your orders. Cancelled orders are left out of sales; returned orders are left out of best sellers.</p>
      </header>
      ${
        canSales
          ? `<form class="adm-filters" data-range novalidate>
        <div class="field"><label for="rp-from">From</label><input id="rp-from" type="date" value="${ymd(monthAgo)}" /></div>
        <div class="field"><label for="rp-to">To</label><input id="rp-to" type="date" value="${ymd(today)}" /></div>
        <button class="btn btn--primary" type="submit">Show report</button></form>
      <p class="form-alert" role="alert" data-error hidden></p>
      <div data-sales><p class="muted">Loading…</p></div>`
          : ""
      }
      ${canStock ? `<section class="adm-section"><h2 class="adm-h2">Stock position</h2><div data-stock><p class="muted">Loading…</p></div></section>` : ""}
    </div>`;

  async function showSales() {
    const box = main.querySelector("[data-sales]");
    const err = main.querySelector("[data-error]");
    err.hidden = true;
    const from = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#rp-from")).value}T00:00:00`);
    const to = new Date(`${/** @type {HTMLInputElement} */ (main.querySelector("#rp-to")).value}T23:59:59.999`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      err.textContent = "Choose both dates.";
      err.hidden = false;
      return;
    }
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("salesReport", { from: from.toISOString(), to: to.toISOString() });
      if (!r.orders && !Object.keys(r.byStatus).length) {
        box.innerHTML = emptyState({ title: "No orders in this period", text: "Pick another range, or come back once customers have ordered." });
        return;
      }
      box.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Orders", value: r.orders })}
          ${statCard({ label: "Sales", value: formatPKR(r.sales), note: r.discounts ? `after ${formatPKR(r.discounts)} of discounts` : "" })}
          ${statCard({ label: "Average order", value: formatPKR(r.averageOrder) })}
          ${statCard({ label: "Pairs sold", value: r.units })}
          ${statCard({ label: "Customers", value: r.customers })}
          ${statCard({ label: "Cash collected", value: formatPKR(Math.max(0, r.cashCollected)), note: "after refunds" })}
        </div>
        <section class="adm-section"><h2 class="adm-h2">Orders by status</h2>
          <p>${Object.entries(r.byStatus).map(([s, n]) => `<span class="tag">${esc(STATUS_LABEL[s] ?? s)}: ${n}</span>`).join(" ")}</p></section>
        <section class="adm-section"><h2 class="adm-h2">Best sellers</h2>${
          r.bestSellers.length
            ? `<div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Best selling products</caption><thead><tr><th scope="col">Product</th><th scope="col">Pairs</th><th scope="col">Revenue</th></tr></thead><tbody>${r.bestSellers
                .map((p) => `<tr><td data-label="Product">${esc(p.name)}</td><td data-label="Pairs">${p.units}</td><td data-label="Revenue">${esc(formatPKR(p.revenue))}</td></tr>`)
                .join("")}</tbody></table></div>`
            : `<p class="muted">No pairs sold in this period.</p>`
        }</section>
        <section class="adm-section"><h2 class="adm-h2">By day</h2><div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Orders and sales by day</caption><thead><tr><th scope="col">Day</th><th scope="col">Orders</th><th scope="col">Sales</th></tr></thead><tbody>${r.daily
          .map((d) => `<tr><td data-label="Day">${esc(d.day)}</td><td data-label="Orders">${d.orders}</td><td data-label="Sales">${esc(formatPKR(d.sales))}</td></tr>`)
          .join("")}</tbody></table></div></section>`;
    } catch (error) {
      box.innerHTML = "";
      err.textContent = fnResult(error).message;
      err.hidden = false;
    }
  }

  async function showStock() {
    const box = main.querySelector("[data-stock]");
    try {
      const r = await call("inventoryReport", {});
      const list = (rows, empty) =>
        rows.length ? `<ul class="adm-list">${rows.map((x) => `<li><a href="/admin/products/${esc(x.productId)}">${esc(x.productId)}</a> · ${esc(x.variantId)} · ${x.onHand} on hand</li>`).join("")}</ul>` : `<p class="muted">${empty}</p>`;
      box.innerHTML = `
        <div class="adm-stats">${statCard({ label: "Pairs in stock", value: r.unitsOnHand })}${statCard({ label: "Size/colour options", value: r.variants })}${statCard({ label: "Sold out", value: r.outOfStock.length })}${statCard({ label: "Running low", value: r.lowStock.length, note: `at or below ${r.threshold}` })}</div>
        <h3 class="adm-h3">Sold out</h3>${list(r.outOfStock, "Nothing is sold out.")}
        <h3 class="adm-h3">Running low</h3>${list(r.lowStock, "Nothing is running low.")}`;
    } catch {
      box.innerHTML = errorState();
      box.querySelector("[data-retry]")?.addEventListener("click", showStock);
    }
  }

  main.querySelector("[data-range]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    showSales();
  });
  if (canSales) showSales();
  if (canStock) showStock();
}
