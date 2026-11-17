/**
 * Cash & bank: the balance of every cash, bank and mobile-wallet account from the books, and where the money came
 * from and went in a period. Wallet money is held in a CLEARING account: a recorded wallet payment is not confirmed
 * bank settlement, so it is not shown as bank money.
 */
import { esc } from "../../lib/format.js";
import { errorState, statCard } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const SOURCE = { sale: "Sales", payment: "Customer payments", refund: "Refunds to customers", grn: "Goods received", supplierpayment: "Supplier payments", purchasereturn: "Purchase returns", manual: "Manual entries", opening: "Opening balances", reversal: "Reversals" };

export default async function cashBank({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Cash <em>&amp; bank</em></h1>
        <p class="muted">Balances come from posted journals. Cash on delivery counts as cash only once it is recorded as collected; mobile-wallet money stays in clearing until you move it to the bank with a journal entry.</p></header>
      <div data-balances><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Money in and out</h2>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="cb-from">From</label><input id="cb-from" type="date" value="${ymd(new Date(Date.now() - 30 * 86400000))}" /></div>
        <div class="field"><label for="cb-to">To</label><input id="cb-to" type="date" value="${ymd(new Date())}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <div data-flow></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-flow]") !== null;
  const bal = /** @type {HTMLElement} */ (main.querySelector("[data-balances]"));
  const flow = /** @type {HTMLElement} */ (main.querySelector("[data-flow]"));
  const KIND = { cash: "Cash in hand", bank: "Bank", wallet: "Wallet clearing" };

  try {
    const o = await call("accountingOverview", {});
    if (alive()) bal.innerHTML = `<div class="adm-stats">${statCard({ label: "Total cash, bank and wallets", value: money(o.cashTotal) })}</div><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account</th><th>Kind</th><th>Balance</th></tr></thead><tbody>${o.cashAccounts.map((a) => `<tr><td><code>${esc(a.code)}</code> ${esc(a.name)}</td><td>${esc(KIND[a.kind])}</td><td><strong>${esc(money(a.balance))}</strong></td></tr>`).join("")}</tbody></table></div>`;
  } catch (error) {
    bal.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : undefined);
  }

  async function show() {
    flow.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("cashFlow", { from: /** @type {HTMLInputElement} */ (main.querySelector("#cb-from")).value, to: /** @type {HTMLInputElement} */ (main.querySelector("#cb-to")).value });
      if (!alive()) return;
      flow.innerHTML = `<div class="adm-stats">${statCard({ label: "Opening", value: money(r.openingTotal) })}${statCard({ label: "Received", value: money(r.received) })}${statCard({ label: "Paid out", value: money(r.paid) })}${statCard({ label: "Closing", value: money(r.closingTotal), note: r.consistent ? "opening + received − paid" : "does not add up — see Reconciliation" })}</div>
        ${Object.keys(r.bySource).length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Source</th><th>In</th><th>Out</th></tr></thead><tbody>${Object.entries(r.bySource).map(([k, v]) => `<tr><td>${esc(SOURCE[k] ?? k)}</td><td>${v.in ? esc(money(v.in)) : "—"}</td><td>${v.out ? esc(money(v.out)) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No cash movements in this period.</p>`}
        <p class="muted">${esc(r.note)}</p>`;
    } catch (error) {
      if (alive()) flow.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : /** @type {Error} */ (error).message);
    }
  }
  main.querySelector("[data-range]").addEventListener("submit", (e) => {
    e.preventDefault();
    show();
  });
  await show();
}
