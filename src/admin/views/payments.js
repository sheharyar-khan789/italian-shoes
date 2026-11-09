/**
 * Payments: the Cash on Delivery switch, which online gateways are (not) connected, the cash still
 * to collect, and every payment. Recording cash and refunds happens on each order's page.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { PAYMENT_STATUSES } from "../../../shared/orderStatus.js";
import { PAYMENT_GATEWAYS } from "../../../shared/paymentGateways.js";
import { toast, confirmDialog, errorState, dataTable, formatWhen, statCard } from "../ui/kit.js";
import { PAYMENT_LABEL, METHOD_LABEL } from "../../ui/orderLabels.js";
import { call, listPayments, pendingCash, codSetting } from "../payData.js";
import { fnResult } from "./catalogue.js";

export default async function payments({ main, user }) {
  const canSwitch = user.perms.includes("settings.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Payments</h1>
        <p class="muted">Customers pay in cash when the order is delivered. Record the cash on each order's page once it's dispatched or delivered.</p>
      </header>
      <section class="adm-section"><h2 class="adm-h2">Payment methods</h2><div data-methods><p class="muted">Loading…</p></div></section>
      <section class="adm-section"><h2 class="adm-h2">Cash to collect</h2><div class="adm-stats" data-stats><p class="muted">Loading…</p></div></section>
      <section class="adm-section"><h2 class="adm-h2">All payments</h2>
        <div class="adm-filters adm-filters--one"><label class="visually-hidden" for="pay-status">Status</label>
          <select id="pay-status"><option value="">All statuses</option>${PAYMENT_STATUSES.map((s) => `<option value="${s}">${esc(PAYMENT_LABEL[s])}</option>`).join("")}</select></div>
        <div data-table><p class="muted">Loading…</p></div></section>
    </div>`;

  /* Methods */
  const drawMethods = async () => {
    const box = main.querySelector("[data-methods]");
    let cod;
    try {
      cod = await codSetting();
    } catch {
      box.innerHTML = errorState();
      box.querySelector("[data-retry]")?.addEventListener("click", drawMethods);
      return;
    }
    box.innerHTML = `
      <div class="adm-card adm-method"><div><strong>${esc(METHOD_LABEL.cod)}</strong>
        <p class="muted">${cod.isEnabled ? "Customers can choose this at checkout." : "Turned off — customers can't place orders."}</p></div>
        ${canSwitch ? `<button type="button" class="btn btn--ghost" data-toggle-cod>${cod.isEnabled ? "Turn off" : "Turn on"}</button>` : `<span class="tag">${cod.isEnabled ? "On" : "Off"}</span>`}</div>
      ${PAYMENT_GATEWAYS.map(
        (g) => `<div class="adm-card adm-method adm-method--off"><div><strong>${esc(g.name)}</strong> <span class="tag">Not connected</span>
          <p class="muted">${esc(g.note)}</p></div></div>`,
      ).join("")}
      <p class="fine">Online payments can only be turned on once a merchant account is connected and tested. Until then the site never pretends to accept them.</p>`;
    box.querySelector("[data-toggle-cod]")?.addEventListener("click", async () => {
      const next = !cod.isEnabled;
      if (!next && !(await confirmDialog({ title: "Turn off Cash on Delivery?", body: "Customers won't be able to place any orders until you turn it back on.", confirm: "Turn off", danger: true }))) return;
      try {
        await call("setPaymentMethod", { key: "cod", isEnabled: next });
        toast(next ? "Cash on Delivery is on." : "Cash on Delivery is off.");
        drawMethods();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    });
  };

  /* Cash to collect */
  const drawStats = async () => {
    const box = main.querySelector("[data-stats]");
    try {
      const { count, total } = await pendingCash();
      box.innerHTML = statCard({ label: "Waiting to be collected", value: formatPKR(total), note: `${count} order${count === 1 ? "" : "s"} — cancelled orders aren't counted` });
    } catch {
      box.innerHTML = statCard({ label: "Waiting to be collected", value: "—", note: "Couldn't load — refresh to try again" });
    }
  };

  /* Table */
  const wrap = main.querySelector("[data-table]");
  const table = dataTable({
    caption: "Payments",
    empty: { title: "No payments yet", text: "A payment is created for every order." },
    columns: [
      { key: "orderNumber", label: "Order", render: (p) => `<a class="text-link" href="/admin/orders/${esc(p.orderId)}" data-link>${esc(p.orderNumber)}</a>`, className: "nowrap" },
      { key: "createdAt", label: "Placed", render: (p) => esc(formatWhen(p.createdAt)), className: "nowrap" },
      { key: "method", label: "Method", render: (p) => esc(METHOD_LABEL[p.method] ?? p.method) },
      { key: "amount", label: "Amount", render: (p) => esc(formatPKR(p.amount)), className: "nowrap" },
      { key: "status", label: "Status", render: (p) => `<span class="tag tag--p-${esc(p.status)}">${esc(PAYMENT_LABEL[p.status] ?? p.status)}</span>` },
      { key: "refunded", label: "Refunded", render: (p) => (p.refundedTotal ? esc(formatPKR(p.refundedTotal)) : "—") },
    ],
  });
  let last = null;
  const load = async (more = false) => {
    const status = /** @type {HTMLSelectElement} */ (main.querySelector("#pay-status")).value || undefined;
    try {
      const page = await listPayments({ status, after: more ? last : undefined });
      last = page.last;
      if (!wrap.contains(table.el)) wrap.replaceChildren(table.el);
      (more ? table.append : table.set)(page.items, page.hasMore);
    } catch {
      wrap.innerHTML = errorState();
      wrap.querySelector("[data-retry]")?.addEventListener("click", () => load(false));
    }
  };
  table.onMore(() => load(true));
  main.querySelector("#pay-status").addEventListener("change", () => load(false));

  await Promise.all([drawMethods(), drawStats(), load()]);
}
