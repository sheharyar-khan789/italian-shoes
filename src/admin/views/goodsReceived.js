/**
 * Goods received: the orders still waiting for goods (receive them here) and the history of goods received
 * notes, one page at a time. Stock only increases when goods are received and accepted.
 */
import { esc } from "../../lib/format.js";
import { errorState, dataTable, formatWhen } from "../ui/kit.js";
import { money, formDialog, tag, PO_STATUS } from "../ui/purchasing.js";
import { pageOf, listSuppliers } from "../purchData.js";
import { receiveDialog } from "./purchasingDialogs.js";

const dateOf = (t) => (t?.toDate ? formatWhen(t) : "—");

export default async function goodsReceived({ main, user }) {
  const canManage = user.perms.includes("purchases.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Goods <em>received</em></h1>
        <p class="muted">Receive a delivery against an approved purchase order. Accepted pairs go into the order's warehouse; damaged or rejected pairs are recorded separately and are not stocked or paid for.</p>
      </header>
      <h2 class="adm-h2">Waiting for goods</h2>
      <div data-waiting><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Goods received notes</h2>
      <div class="adm-filters"><label class="visually-hidden" for="gr-sup">Supplier</label><select id="gr-sup"><option value="">All suppliers</option></select></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const waitingEl = main.querySelector("[data-waiting]");
  const listEl = main.querySelector("[data-list]");
  const supEl = /** @type {HTMLSelectElement} */ (main.querySelector("#gr-sup"));
  /** @type {Map<string, any>} */
  const orders = new Map();
  const grns = new Map();

  const waiting = dataTable({
    caption: "Purchase orders waiting for goods",
    empty: { title: "Nothing is waiting", text: "Approved purchase orders that still have pairs to receive appear here." },
    columns: [
      { key: "number", label: "Order", render: (r) => `<a class="text-link" href="/admin/purchase-orders/${esc(r.id)}" data-link><strong>${esc(r.number)}</strong></a>` },
      { key: "supplierName", label: "Supplier" },
      { key: "warehouseName", label: "Into" },
      { key: "status", label: "Status", render: (r) => tag(PO_STATUS, r.status) },
      { key: "pending", label: "Pending pairs", render: (r) => String(r.lines.reduce((n, l) => n + l.qty - l.receivedQty - l.rejectedQty, 0)) },
      { key: "actions", label: "", render: (r) => (canManage ? `<button type="button" class="text-btn" data-receive="${esc(r.id)}">Receive</button>` : "") },
    ],
  });
  const table = dataTable({
    caption: "Goods received notes",
    empty: { title: "No goods received yet" },
    columns: [
      { key: "number", label: "GRN", render: (r) => `<strong>${esc(r.number)}</strong>` },
      { key: "createdAt", label: "Date", render: (r) => esc(dateOf(r.createdAt)) },
      { key: "supplierName", label: "Supplier" },
      { key: "purchaseOrderNumber", label: "Order", render: (r) => `<a class="text-link" href="/admin/purchase-orders/${esc(r.purchaseOrderId)}" data-link>${esc(r.purchaseOrderNumber)}</a>` },
      { key: "warehouseName", label: "Warehouse" },
      { key: "acceptedUnits", label: "Accepted" },
      { key: "rejectedUnits", label: "Rejected", render: (r) => String(r.rejectedUnits ?? 0) },
      { key: "value", label: "Value", render: (r) => esc(money(r.value)) },
      { key: "actions", label: "", render: (r) => `<button type="button" class="text-btn" data-view="${esc(r.id)}">View</button>` },
    ],
  });

  async function loadWaiting() {
    try {
      const p = await pageOf("purchaseOrders", { where: [["status", "in", ["ordered", "partially_received"]]], size: 50 });
      if (!alive()) return;
      orders.clear();
      p.rows.forEach((r) => orders.set(r.id, r));
      waiting.set(p.rows);
      waitingEl.replaceChildren(waiting.el);
    } catch {
      if (alive()) waitingEl.innerHTML = errorState();
    }
  }
  let last = null;
  let ticket = 0;
  async function load(reset = true) {
    const mine = ++ticket;
    try {
      const p = await pageOf("goodsReceipts", { where: supEl.value ? [["supplierId", "==", supEl.value]] : [], after: reset ? null : last });
      if (mine !== ticket || !alive()) return;
      last = p.last;
      p.rows.forEach((r) => grns.set(r.id, r));
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

  main.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const rec = t.closest("[data-receive]");
    if (rec) {
      const po = orders.get(/** @type {HTMLElement} */ (rec).dataset.receive);
      if (po) receiveDialog(po, () => Promise.all([loadWaiting(), load(true)]));
      return;
    }
    const v = t.closest("[data-view]");
    const g = v && grns.get(/** @type {HTMLElement} */ (v).dataset.view);
    if (g) {
      const d = formDialog({
        title: `${g.number} — ${g.supplierName}`,
        intro: `${esc(g.purchaseOrderNumber)} · into ${esc(g.warehouseName)} · received ${esc(dateOf(g.createdAt))}${g.supplierInvoiceNo ? ` · invoice ${esc(g.supplierInvoiceNo)}` : ""}`,
        submit: "Close",
        wide: true,
        body: `<ul class="adm-feed">${g.lines.map((l) => `<li><span><strong>${l.acceptedQty}</strong> accepted${l.rejectedQty ? `, <strong>${l.rejectedQty}</strong> rejected (${esc(l.rejectReason)})` : ""}${l.returnedQty ? `, ${l.returnedQty} returned` : ""} × ${esc(l.productName)} · ${esc(l.variantLabel)}<br /><span class="muted"><code>${esc(l.sku ?? "")}</code> · value ${esc(money(l.value))}${l.costAfter != null ? ` · average cost ${esc(money(l.costBefore ?? 0))} → ${esc(money(l.costAfter))}` : ""}</span></span></li>`).join("")}</ul><p><strong>Total ${esc(money(g.value))}</strong></p>`,
        onSubmit: (_form, { close }) => close(),
      });
      d.querySelector("[data-close]")?.remove();
    }
  });

  try {
    const suppliers = await listSuppliers();
    supEl.insertAdjacentHTML("beforeend", suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  } catch {
    /* the filter just stays on "All suppliers" */
  }
  await Promise.all([loadWaiting(), load(true)]);
}
