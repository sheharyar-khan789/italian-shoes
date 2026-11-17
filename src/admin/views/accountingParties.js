/**
 * Accounts receivable (customers) and accounts payable (suppliers): the control-account balance from the books and
 * the per-person balances, a page at a time. Receivables include cash-on-delivery sales not yet collected.
 */
import { esc } from "../../lib/format.js";
import { errorState, dataTable, statCard } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";

/** @param {{ main: HTMLElement }} ctx @param {"customer" | "supplier"} partyType */
export async function partiesView({ main }, partyType) {
  const isCustomer = partyType === "customer";
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">${isCustomer ? "Accounts <em>receivable</em>" : "Accounts <em>payable</em>"}</h1>
        <p class="muted">${isCustomer ? "What customers owe you, from posted journals. A cash-on-delivery sale is a receivable until the cash is recorded as collected." : "What you owe suppliers, from posted journals. It should agree with the supplier ledger."}</p></header>
      <div data-summary></div><div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const sumEl = /** @type {HTMLElement} */ (main.querySelector("[data-summary]"));
  let next = null;
  const table = dataTable({
    caption: isCustomer ? "Customer balances" : "Supplier balances",
    empty: { title: "No balances", text: "Nothing is owed " + (isCustomer ? "by customers" : "to suppliers") + " in the posted journals." },
    columns: [
      { key: "name", label: isCustomer ? "Customer" : "Supplier", render: (r) => (isCustomer ? esc(r.name ?? r.partyId) : `<a class="text-link" href="/admin/suppliers/${esc(r.partyId)}" data-link>${esc(r.name ?? r.partyId)}</a>`) },
      { key: "debit", label: "Debits", render: (r) => esc(money(r.debit ?? 0)) },
      { key: "credit", label: "Credits", render: (r) => esc(money(r.credit ?? 0)) },
      { key: "balance", label: isCustomer ? "Owes you" : "You owe", render: (r) => `<strong>${esc(money(r.balance))}</strong>` },
    ],
  });
  async function load(reset = true) {
    try {
      const r = await call("partyBalances", { partyType, after: reset ? null : next });
      if (!alive()) return;
      next = r.next;
      if (reset) {
        sumEl.innerHTML = `<div class="adm-stats">${statCard({ label: isCustomer ? "Total receivable (books)" : "Total payable (books)", value: money(r.control) })}</div>${r.note ? `<p class="muted">${esc(r.note)}</p>` : ""}`;
        table.set(r.rows, Boolean(next));
      } else table.append(r.rows, Boolean(next));
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
    } catch (error) {
      if (alive()) listEl.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : undefined);
    }
  }
  table.onMore(() => load(false));
  await load(true);
}
