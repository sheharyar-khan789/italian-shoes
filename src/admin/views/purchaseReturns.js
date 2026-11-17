/**
 * Purchase returns: goods sent back to a supplier, one page at a time. A return is made against a goods
 * receipt; it takes the pairs out of the warehouse they went into and reduces what you owe the supplier.
 */
import { esc } from "../../lib/format.js";
import { errorState, dataTable, formatWhen } from "../ui/kit.js";
import { money, formDialog } from "../ui/purchasing.js";
import { pageOf, listSuppliers } from "../purchData.js";
import { returnDialog } from "./purchasingDialogs.js";

export default async function purchaseReturns({ main, user }) {
  const canManage = user.perms.includes("purchases.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Purchase <em>returns</em></h1>
        <p class="muted">Pairs you send back to a supplier. You can only return what a goods receipt accepted and hasn't already been returned.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>New return</span></button></p>` : ""}
      </header>
      <div class="adm-filters"><label class="visually-hidden" for="pr-sup">Supplier</label><select id="pr-sup"><option value="">All suppliers</option></select></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = main.querySelector("[data-list]");
  const supEl = /** @type {HTMLSelectElement} */ (main.querySelector("#pr-sup"));
  const rows = new Map();
  let last = null;
  let ticket = 0;
  const table = dataTable({
    caption: "Purchase returns",
    empty: { title: "No returns yet" },
    columns: [
      { key: "number", label: "Return", render: (r) => `<strong>${esc(r.number)}</strong>` },
      { key: "createdAt", label: "Date", render: (r) => esc(r.createdAt?.toDate ? formatWhen(r.createdAt) : "—") },
      { key: "supplierName", label: "Supplier" },
      { key: "grnNumber", label: "Receipt", render: (r) => esc(`${r.grnNumber} · ${r.purchaseOrderNumber}`) },
      { key: "warehouseName", label: "From warehouse" },
      { key: "units", label: "Pairs" },
      { key: "value", label: "Credit", render: (r) => esc(money(r.value)) },
      { key: "reason", label: "Reason", render: (r) => `${esc(r.reason)}${r.supplierReference ? `<br /><span class="muted">${esc(r.supplierReference)}</span>` : ""}` },
      { key: "actions", label: "", render: (r) => `<button type="button" class="text-btn" data-view="${esc(r.id)}">View</button>` },
    ],
  });
  async function load(reset = true) {
    const mine = ++ticket;
    try {
      const p = await pageOf("purchaseReturns", { where: supEl.value ? [["supplierId", "==", supEl.value]] : [], after: reset ? null : last });
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
  main.querySelector("[data-new]")?.addEventListener("click", () => returnDialog({ onDone: () => load(true) }));
  main.addEventListener("click", (e) => {
    const v = /** @type {HTMLElement} */ (e.target).closest("[data-view]");
    const r = v && rows.get(/** @type {HTMLElement} */ (v).dataset.view);
    if (!r) return;
    const d = formDialog({
      title: `${r.number} — ${r.supplierName}`,
      intro: `${esc(r.grnNumber)} · taken from ${esc(r.warehouseName)} · ${esc(r.reason)}`,
      submit: "Close",
      body: `<ul class="adm-feed">${r.lines.map((l) => `<li><span><strong>${l.qty}</strong> × ${esc(l.productName)} · ${esc(l.variantLabel)}<br /><span class="muted"><code>${esc(l.sku ?? "")}</code> · ${esc(money(l.value))}</span></span></li>`).join("")}</ul><p><strong>Credit ${esc(money(r.value))}</strong></p>`,
      onSubmit: (_f, { close }) => close(),
    });
    d.querySelector("[data-close]")?.remove();
  });
  try {
    supEl.insertAdjacentHTML("beforeend", (await listSuppliers()).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  } catch {
    /* filter stays on "All suppliers" */
  }
  await load(true);
}
