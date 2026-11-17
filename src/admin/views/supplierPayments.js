/**
 * Supplier payments: every payment recorded against a supplier, one page at a time, with a printable receipt.
 * These screens RECORD payments made outside the system; they never move money.
 */
import { esc } from "../../lib/format.js";
import { errorState, dataTable, formatWhen } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { pageOf, listSuppliers } from "../purchData.js";
import { paymentDialog, printPaymentReceipt } from "./purchasingDialogs.js";
import { loadSettings } from "../data.js";

export default async function supplierPayments({ main, user }) {
  const canPay = user.perms.includes("suppliers.pay");
  const canAdjust = user.perms.includes("suppliers.adjust");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Supplier <em>payments</em></h1>
        <p class="muted">A record of what you have paid your suppliers — cash, bank transfer, JazzCash or Easypaisa. Recording a payment does <strong>not</strong> send or charge any money; make the payment yourself, then record it here.</p>
        ${canPay ? `<p><button type="button" class="btn btn--primary" data-new><span>Record a payment</span></button></p>` : ""}
      </header>
      <div class="adm-filters"><label class="visually-hidden" for="sp-sup">Supplier</label><select id="sp-sup"><option value="">All suppliers</option></select></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = main.querySelector("[data-list]");
  const supEl = /** @type {HTMLSelectElement} */ (main.querySelector("#sp-sup"));
  const rows = new Map();
  let last = null;
  let ticket = 0;
  const table = dataTable({
    caption: "Supplier payments",
    empty: { title: "No payments recorded yet" },
    columns: [
      { key: "number", label: "Payment", render: (r) => `<strong>${esc(r.number)}</strong>` },
      { key: "paidAt", label: "Date paid", render: (r) => esc(r.paidAt?.toDate ? r.paidAt.toDate().toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }) : "—") },
      { key: "supplierName", label: "Supplier", render: (r) => `<a class="text-link" href="/admin/suppliers/${esc(r.supplierId)}" data-link>${esc(r.supplierName)}</a>` },
      { key: "amount", label: "Amount", render: (r) => `<strong>${esc(money(r.amount))}</strong>` },
      { key: "method", label: "Method", render: (r) => esc(r.methodLabel ?? r.method) },
      { key: "reference", label: "Reference", render: (r) => esc(r.reference || "—") },
      { key: "purchaseOrderNumber", label: "Against", render: (r) => esc(r.purchaseOrderNumber ?? "Account") },
      { key: "createdAt", label: "Recorded", render: (r) => esc(r.createdAt?.toDate ? formatWhen(r.createdAt) : "—") },
      { key: "actions", label: "", render: (r) => `<button type="button" class="text-btn" data-print="${esc(r.id)}">Print receipt</button>` },
    ],
  });
  async function load(reset = true) {
    const mine = ++ticket;
    try {
      const p = await pageOf("supplierPayments", { where: supEl.value ? [["supplierId", "==", supEl.value]] : [], after: reset ? null : last });
      if (mine !== ticket || !alive()) return;
      last = p.last;
      p.rows.forEach((r) => rows.set(r.id, r));
      if (reset) table.set(p.rows, p.hasMore);
      else table.append(p.rows, p.hasMore);
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }
  table.onMore(() => load(false));
  supEl.addEventListener("change", () => load(true));
  main.querySelector("[data-new]")?.addEventListener("click", () => paymentDialog({ canAdvance: canAdjust, onDone: () => load(true) }));
  main.addEventListener("click", async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-print]");
    if (!b) return;
    const settings = await loadSettings().catch(() => ({ public: null }));
    printPaymentReceipt(rows.get(/** @type {HTMLElement} */ (b).dataset.print), settings.public?.storeName);
  });
  try {
    supEl.insertAdjacentHTML("beforeend", (await listSuppliers()).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  } catch {
    /* filter stays on "All suppliers" */
  }
  await load(true);
}
