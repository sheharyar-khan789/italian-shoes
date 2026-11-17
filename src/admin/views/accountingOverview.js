/**
 * Accounting overview: real figures from the posted journals. A figure that can't be complete says so; nothing is
 * estimated. Before the chart of accounts exists, this page is where it is created (one click, structure only).
 */
import { esc } from "../../lib/format.js";
import { statCard, errorState, toast } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";

export default async function accountingOverview({ main, user }) {
  const canManage = user.perms.includes("accounting.manage");
  main.innerHTML = `<div class="adm-page" data-page><p class="muted">Loading…</p></div>`;
  const page = /** @type {HTMLElement} */ (main.querySelector("[data-page]"));
  const alive = () => main.isConnected && main.querySelector("[data-page]") !== null;

  async function draw() {
    try {
      const o = await call("accountingOverview", {});
      if (!alive()) return;
      page.innerHTML = `
        <header class="adm-page__head"><h1 class="adm-h1">Accounting <em>overview</em></h1>
          <p class="muted">From posted journals, all time up to ${esc(o.asOf)}. Nothing here is estimated.</p></header>
        ${o.incomplete.failedPostings ? `<p class="form-alert" role="alert">${o.incomplete.failedPostings} automatic posting${o.incomplete.failedPostings === 1 ? "" : "s"} failed and need attention. <a class="text-link" href="/admin/journals" data-link>Open Journal Entries</a></p>` : ""}
        <div class="adm-stats">
          ${statCard({ label: "Total revenue", value: money(o.totalRevenue), note: "net of discounts and returns" })}
          ${statCard({ label: "Gross profit", value: money(o.grossProfit), note: o.incomplete.salesWithoutCost ? `incomplete: ${o.incomplete.salesWithoutCost} sale(s) have no recorded cost` : "revenue − cost of goods sold" })}
          ${statCard({ label: "Total expenses", value: money(o.totalExpenses), note: "cost of goods sold + operating expenses" })}
          ${statCard({ label: "Net profit", value: money(o.netProfit), note: o.incomplete.salesWithoutCost ? "overstated: some sales have no recorded cost" : "revenue − all expenses" })}
          ${statCard({ label: "Receivables", value: money(o.receivables), note: "COD and customer balances" })}
          ${statCard({ label: "Payables", value: money(o.payables), note: "owed to suppliers" })}
          ${statCard({ label: "Inventory (books)", value: money(o.inventory), note: "from purchases; see Inventory for stock" })}
          ${statCard({ label: "Cash, bank and wallets", value: money(o.cashTotal), note: "wallet money is clearing, not bank settlement" })}
        </div>
        <h2 class="adm-h2">Cash and bank accounts</h2>
        <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>
          ${o.cashAccounts.map((a) => `<tr><td>${esc(a.code)} · ${esc(a.name)}</td><td><strong>${esc(money(a.balance))}</strong></td></tr>`).join("")}</tbody></table></div>
        <p class="muted">Balances only include what has been posted. Opening balances are not entered for you — set them in <a class="text-link" href="/admin/opening-balances" data-link>Opening Balances</a>. Sales and purchases from before accounting was switched on are added only by the historical backfill, which an administrator runs on request.</p>`;
    } catch (error) {
      if (!alive()) return;
      if (/set up/i.test(/** @type {Error} */ (error).message)) {
        page.innerHTML = `<header class="adm-page__head"><h1 class="adm-h1">Accounting</h1></header>
          <div class="adm-card"><h2 class="adm-h2">Accounting isn't set up yet</h2>
            <p>Creating the chart of accounts adds the standard accounts (Cash in Hand, Bank, Accounts Receivable, Inventory, Accounts Payable, Sales Revenue, Cost of Goods Sold and so on) and switches automatic posting on. <strong>No balances are entered</strong>; you can rename, add and switch off accounts afterwards.</p>
            ${canManage ? `<button type="button" class="btn btn--primary" data-init><span>Create the chart of accounts</span></button>` : `<p class="muted">Ask the owner to set this up.</p>`}</div>`;
        page.querySelector("[data-init]")?.addEventListener("click", async () => {
          try {
            await call("initializeAccounting", {});
            toast("Chart of accounts created.");
            draw();
          } catch (e) {
            toast(/** @type {Error} */ (e).message, "error");
          }
        });
        return;
      }
      page.innerHTML = errorState();
      page.querySelector("[data-retry]")?.addEventListener("click", draw);
    }
  }
  await draw();
}
