/** Trial balance: opening, debit, credit and closing for every account over a period; the totals must balance. */
import { esc } from "../../lib/format.js";
import { errorState, statCard } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const side = (n) => (n === 0 ? "—" : `${esc(money(Math.abs(n)))} ${n > 0 ? "Dr" : "Cr"}`);

export default async function trialBalance({ main }) {
  const now = new Date();
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Trial <em>balance</em></h1>
        <p class="muted">Opening = everything posted before the start date. Closing = everything up to the end date. Dr / Cr show which side each balance is on.</p></header>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="tb-from">From</label><input id="tb-from" type="date" value="${ymd(new Date(now.getFullYear(), 0, 1))}" /></div>
        <div class="field"><label for="tb-to">To (as at)</label><input id="tb-to" type="date" value="${ymd(now)}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <div data-report><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-report]"));
  const alive = () => main.isConnected && main.querySelector("[data-report]") !== null;
  async function show() {
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("trialBalance", { from: /** @type {HTMLInputElement} */ (main.querySelector("#tb-from")).value, to: /** @type {HTMLInputElement} */ (main.querySelector("#tb-to")).value });
      if (!alive()) return;
      box.innerHTML = `
        <div class="adm-stats">${statCard({ label: "Closing debits", value: money(r.totals.closingDebit) })}${statCard({ label: "Closing credits", value: money(r.totals.closingCredit) })}${statCard({ label: r.balanced ? "Balanced" : "NOT BALANCED", value: r.balanced ? "✓" : "✗", note: r.balanced ? "debits equal credits" : "see Reconciliation under Accounting Reports" })}</div>
        ${r.rows.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account</th><th>Opening</th><th>Debit</th><th>Credit</th><th>Closing</th></tr></thead><tbody>
          ${r.rows.map((a) => `<tr><td><code>${esc(a.code)}</code> ${esc(a.name)}</td><td>${side(a.openingNet)}</td><td>${a.debit ? esc(money(a.debit)) : "—"}</td><td>${a.credit ? esc(money(a.credit)) : "—"}</td><td><strong>${side(a.closingNet)}</strong></td></tr>`).join("")}
          <tr><td><strong>Total</strong></td><td></td><td><strong>${esc(money(r.totals.debit))}</strong></td><td><strong>${esc(money(r.totals.credit))}</strong></td><td></td></tr></tbody></table></div>` : `<p class="muted">Nothing has been posted up to this date.</p>`}`;
    } catch (error) {
      if (alive()) box.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : undefined);
    }
  }
  main.querySelector("[data-range]").addEventListener("submit", (e) => {
    e.preventDefault();
    show();
  });
  await show();
}
