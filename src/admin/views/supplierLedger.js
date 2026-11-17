/**
 * Supplier ledger: pick a supplier and see every money event with debit, credit and the running balance
 * (what the store owes), newest first, one page at a time.
 */
import { esc } from "../../lib/format.js";
import { errorState } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { getRow, listSuppliers } from "../purchData.js";
import { ledgerView } from "./purchasingDialogs.js";

export default async function supplierLedger({ main, params }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Supplier <em>ledger</em></h1>
        <p class="muted">Debit = paid or returned (you owe less). Credit = goods received or opening balance (you owe more). The balance is what you owe the supplier after that entry.</p>
      </header>
      <div class="adm-filters"><label class="visually-hidden" for="sl-sup">Supplier</label><select id="sl-sup"><option value="">Choose a supplier…</option></select></div>
      <p data-summary></p>
      <div data-ledger></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-ledger]") !== null;
  const supEl = /** @type {HTMLSelectElement} */ (main.querySelector("#sl-sup"));
  const summary = /** @type {HTMLElement} */ (main.querySelector("[data-summary]"));
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-ledger]"));
  const show = async () => {
    summary.textContent = "";
    box.innerHTML = "";
    if (!supEl.value) return;
    const s = await getRow("suppliers", supEl.value).catch(() => null);
    if (!alive()) return;
    if (s) summary.innerHTML = `<strong>${esc(s.name)}</strong> — we owe <strong>${esc(money(s.balance ?? 0))}</strong> · purchased ${esc(money(s.totalPurchased ?? 0))} · returned ${esc(money(s.totalReturned ?? 0))} · paid ${esc(money(s.totalPaid ?? 0))}`;
    await ledgerView(box, supEl.value);
  };
  supEl.addEventListener("change", show);
  try {
    const suppliers = await listSuppliers(true);
    supEl.insertAdjacentHTML("beforeend", suppliers.map((s) => `<option value="${esc(s.id)}" ${s.id === params[0] ? "selected" : ""}>${esc(s.name)}</option>`).join(""));
  } catch {
    box.innerHTML = errorState();
    return;
  }
  if (supEl.value) await show();
}
