/** General ledger: one account's rows in a date range, a page at a time, with the running balance. */
import { esc } from "../../lib/format.js";
import { errorState, dataTable } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call, pageOf } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function generalLedger({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">General <em>ledger</em></h1>
        <p class="muted">Every posted line of one account. The balance column follows the account's normal side (debit for assets and expenses, credit for liabilities, equity and revenue).</p></header>
      <form class="adm-filters" data-filters novalidate>
        <div class="field"><label for="gl-acc">Account</label><select id="gl-acc"><option value="">Choose…</option></select></div>
        <div class="field"><label for="gl-from">From</label><input id="gl-from" type="date" value="${ymd(new Date(Date.now() - 30 * 86400000))}" /></div>
        <div class="field"><label for="gl-to">To</label><input id="gl-to" type="date" value="${ymd(new Date())}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <p data-summary></p><div data-list></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const summary = /** @type {HTMLElement} */ (main.querySelector("[data-summary]"));
  const sel = /** @type {HTMLSelectElement} */ (main.querySelector("#gl-acc"));
  const val = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id)).value;
  let next = null;
  let all = [];

  const table = dataTable({
    caption: "General ledger",
    empty: { title: "No entries in this period" },
    columns: [
      { key: "dateKey", label: "Date" },
      { key: "number", label: "Journal", render: (r) => `<strong>${esc(r.number)}</strong><br /><span class="muted">${esc(r.sourceType)}</span>` },
      { key: "memo", label: "Description", render: (r) => esc(r.memo) },
      { key: "debit", label: "Debit", render: (r) => (r.debit ? esc(money(r.debit)) : "") },
      { key: "credit", label: "Credit", render: (r) => (r.credit ? esc(money(r.credit)) : "") },
      { key: "running", label: "Balance", render: (r) => `<strong>${esc(money(r.running))}</strong>` },
    ],
  });

  async function show(reset = true) {
    if (!sel.value) return;
    try {
      const r = await call("generalLedger", { accountCode: sel.value, from: val("#gl-from"), to: val("#gl-to"), after: reset ? null : next });
      if (!alive()) return;
      next = r.next;
      all = reset ? r.rows : all.concat(r.rows);
      if (reset) summary.innerHTML = `<strong>${esc(r.account.code)} ${esc(r.account.name)}</strong> · opening balance <strong>${esc(money(r.opening ?? 0))}</strong>`;
      if (r.closing !== null) summary.innerHTML += ` · closing balance <strong>${esc(money(r.closing))}</strong>`;
      if (reset) table.set(r.rows, Boolean(next));
      else table.append(r.rows, Boolean(next));
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
    } catch (error) {
      listEl.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : undefined);
    }
  }
  table.onMore(() => show(false));
  main.querySelector("[data-filters]").addEventListener("submit", (e) => {
    e.preventDefault();
    show(true);
  });
  try {
    const p = await pageOf("accounts", { orderBy: ["code", "asc"], size: 300 });
    sel.insertAdjacentHTML("beforeend", p.rows.filter((a) => !a.isGroup).map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join(""));
  } catch {
    listEl.innerHTML = errorState();
  }
}
