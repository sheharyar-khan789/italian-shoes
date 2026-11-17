/**
 * Unified sales: every sale, whatever channel it came from, one page at a time; and one sale's page with its
 * snapshot lines, totals, payments (several payments and corrections are recorded here) and, for staff who may
 * see costs, the saved cost and gross profit. Online sales link to their order.
 */
import { esc } from "../../lib/format.js";
import { normalizePkMobile } from "../../../shared/phone.js";
import { SALE_CHANNELS, SALE_PAYMENT_LABEL, SALE_PAYMENT_METHODS, SALE_STATUS_LABEL } from "../../../shared/sales.js";
import { recordSalePaymentInput, reverseSalePaymentInput, posReturnInput, fieldErrors } from "../../../shared/schemas/index.js";
import { toast, errorState, dataTable, formatWhen } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call, pageOf, getRow } from "../purchData.js";
import { listWarehouses, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { loadSettings } from "../data.js";
import { printInvoice } from "../../ui/invoice.js";
import { PAYMENT_LABEL } from "../../ui/orderLabels.js";

const CHANNEL_LABEL = { online: "Online", pos: "POS" };
const dateOf = (t) => (t?.toDate ? formatWhen(t) : "—");
const payTag = (status) => `<span class="${["collected", "paid"].includes(status) ? "tag" : ["void", "failed", "refunded"].includes(status) ? "tag tag--out" : "tag tag--low"}">${esc(PAYMENT_LABEL[status] ?? status)}</span>`;
const statusTag = (status) => `<span class="${["delivered", "completed"].includes(status) ? "tag" : ["cancelled", "returned", "refunded"].includes(status) ? "tag tag--out" : "tag tag--low"}">${esc(SALE_STATUS_LABEL[status] ?? status)}</span>`;

export default async function sales({ main, user, params }) {
  /** @type {Map<string, any>} */
  const names = new Map();
  try {
    for (const w of await listWarehouses()) names.set(w.id, w.name);
  } catch {
    /* ids are shown instead */
  }
  if (!names.has("main")) names.set("main", VIRTUAL_DEFAULT_WAREHOUSE.name);
  if (params[0]) return detail(params[0]);
  const whLabel = (s) => (s.warehouseIds?.length > 1 ? "Several" : names.get(s.warehouseId) ?? s.warehouseId);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Sales</h1>
        <p class="muted">Every sale in one list. Online orders appear here automatically. Walk-in (POS) sales will appear here once the POS exists.</p>
      </header>
      <form class="adm-filters" data-filters novalidate>
        <label class="visually-hidden" for="sl-q">Search</label>
        <input id="sl-q" type="search" placeholder="Sale no. (SL-000012), order no. or customer phone" />
        <label class="visually-hidden" for="sl-channel">Channel</label>
        <select id="sl-channel"><option value="">All channels</option>${SALE_CHANNELS.map((c) => `<option value="${c}">${CHANNEL_LABEL[c]}</option>`).join("")}</select>
        <label class="visually-hidden" for="sl-pay">Payment</label>
        <select id="sl-pay"><option value="">Any payment status</option>${["pending", "partially_paid", "collected", "paid", "partially_refunded", "refunded", "void"].map((s) => `<option value="${s}">${esc(PAYMENT_LABEL[s])}</option>`).join("")}</select>
        <label class="visually-hidden" for="sl-status">Status</label>
        <select id="sl-status"><option value="">Any status</option>${Object.entries(SALE_STATUS_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <label for="sl-from">From</label><input id="sl-from" type="date" />
        <label for="sl-to">To</label><input id="sl-to" type="date" />
        <button type="submit" class="btn btn--primary"><span>Search</span></button>
      </form>
      <p class="muted" data-note hidden></p>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = main.querySelector("[data-list]");
  const noteEl = /** @type {HTMLElement} */ (main.querySelector("[data-note]"));
  const el = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id));
  let last = null;
  let ticket = 0;

  const table = dataTable({
    caption: "Sales",
    empty: { title: "No sales match", text: "Try other filters, or a wider date range." },
    columns: [
      { key: "number", label: "Sale", render: (r) => `<a class="text-link" href="/admin/sales/${esc(r.id)}" data-link><strong>${esc(r.number)}</strong></a>${r.orderNumber ? `<br /><span class="muted">${esc(r.orderNumber)}</span>` : ""}` },
      { key: "channel", label: "Channel", render: (r) => esc(CHANNEL_LABEL[r.channel] ?? r.channel) },
      { key: "createdAt", label: "Date", render: (r) => esc(dateOf(r.createdAt)) },
      { key: "customer", label: "Customer", render: (r) => (r.customer ? `${esc(r.customer.name)}<br /><span class="muted">${esc(r.customer.phone)}</span>` : "Walk-in") },
      { key: "warehouse", label: "Warehouse", render: (r) => esc(whLabel(r)) },
      { key: "itemCount", label: "Items" },
      { key: "total", label: "Total", render: (r) => `<strong>${esc(money(r.total))}</strong>` },
      { key: "paymentMethod", label: "Method", render: (r) => esc(SALE_PAYMENT_LABEL[r.paymentMethod] ?? r.paymentMethod) },
      { key: "paymentStatus", label: "Payment", render: (r) => payTag(r.paymentStatus) },
      { key: "status", label: "Status", render: (r) => statusTag(r.status) },
    ],
  });

  /** Which exact-match search is this? Returns [field, value] or null. */
  const searchPlan = (text) => {
    const q = text.trim();
    if (!q) return null;
    if (/^sl-\d+$/i.test(q)) return ["number", q.toUpperCase()];
    if (/^[a-z]{2,6}-\d{4}-\d+$/i.test(q)) return ["orderNumber", q.toUpperCase()];
    const phone = normalizePkMobile(q);
    return phone ? ["customerPhone", phone] : ["invalid", q];
  };

  async function load(reset = true) {
    const mine = ++ticket;
    const plan = searchPlan(el("#sl-q").value);
    noteEl.hidden = true;
    if (plan?.[0] === "invalid") {
      noteEl.textContent = "Search by sale number (SL-000012), order number (IS-2026-000123) or a phone number.";
      noteEl.hidden = false;
      return;
    }
    const channel = el("#sl-channel").value;
    const paymentStatus = el("#sl-pay").value;
    const status = el("#sl-status").value;
    const from = el("#sl-from").value ? new Date(`${el("#sl-from").value}T00:00:00`) : null;
    const to = el("#sl-to").value ? new Date(`${el("#sl-to").value}T23:59:59`) : null;
    /** @type {[string, any, any][]} */
    let where = [];
    /** @type {[string, "asc" | "desc"]} */
    let orderBy = ["createdAt", "desc"];
    /** Filters the database can't combine are applied to the rows that are loaded. */
    let client = { channel, paymentStatus, status };
    if (plan) {
      where = [[plan[0], "==", plan[1]]];
      orderBy = [plan[0], "asc"];
      client = { channel, paymentStatus, status };
    } else {
      const first = channel ? ["channel", channel] : paymentStatus ? ["paymentStatus", paymentStatus] : status ? ["status", status] : null;
      if (first) {
        where.push([first[0], "==", first[1]]);
        client = { ...client, [first[0]]: "" };
      }
      if (from) where.push(["createdAt", ">=", from]);
      if (to) where.push(["createdAt", "<=", to]);
    }
    try {
      const p = await pageOf("sales", { where, orderBy, after: reset ? null : last });
      if (mine !== ticket || !alive()) return;
      last = p.last;
      const rows = p.rows.filter((r) => (!client.channel || r.channel === client.channel) && (!client.paymentStatus || r.paymentStatus === client.paymentStatus) && (!client.status || r.status === client.status));
      if (reset) table.set(rows, p.hasMore);
      else table.append(rows, p.hasMore);
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
      if (p.hasMore && !rows.length) noteEl.textContent = "None of this page matched; press “Load more”.";
      noteEl.hidden = !(p.hasMore && !rows.length);
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }
  table.onMore(() => load(false));
  main.querySelector("[data-filters]").addEventListener("submit", (e) => {
    e.preventDefault();
    load(true);
  });
  await load(true);

  /* ───── One sale ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    const canPay = user.perms.includes("payments.update");
    const canCost = user.perms.includes("costs.read");
    const canReturn = user.perms.includes("pos.return");
    async function draw() {
      let s;
      try {
        s = await getRow("sales", id);
      } catch {
        page.innerHTML = errorState();
        page.querySelector("[data-retry]")?.addEventListener("click", draw);
        return;
      }
      if (!s) {
        page.innerHTML = `<p>That sale doesn't exist. <a class="text-link" href="/admin/sales" data-link>Back to sales</a></p>`;
        return;
      }
      const [cost, txs, store] = await Promise.all([
        canCost ? getRow("saleCosts", id).catch(() => null) : null,
        user.perms.some((p) => ["payments.update", "orders.read"].includes(p)) ? pageOf(`payments/${id}/transactions`, { orderBy: ["at", "asc"], size: 100 }).then((p) => p.rows).catch(() => []) : [],
        loadSettings().then((x) => x.public).catch(() => null),
      ]);
      const whs = (s.warehouseIds ?? []).map((w) => names.get(w) ?? w).join(", ");
      const reversed = new Set(txs.filter((t) => t.type === "reversal").map((t) => t.reverses));
      page.innerHTML = `
        <p><a class="text-link" href="/admin/sales" data-link>← Sales</a></p>
        <header class="adm-page__head">
          <h1 class="adm-h1">${esc(s.number)} ${statusTag(s.status)} ${payTag(s.paymentStatus)}</h1>
          <p>${esc(CHANNEL_LABEL[s.channel] ?? s.channel)} sale · ${esc(dateOf(s.createdAt))}${s.orderId ? ` · <a class="text-link" href="/admin/orders/${esc(s.orderId)}" data-link>Online order ${esc(s.orderNumber)}</a>` : ""}</p>
          <p><button type="button" class="btn btn--ghost" data-print>Print</button>
            ${canPay && ["pending", "partially_paid"].includes(s.paymentStatus) && s.amountDue > 0 && !["cancelled", "returned", "refunded"].includes(s.status) ? ` <button type="button" class="btn btn--primary" data-pay><span>Record a payment</span></button>` : ""}
            ${canReturn && s.channel === "pos" && s.status === "completed" && s.lines.some((l) => (l.returnedQty ?? 0) < l.qty) ? ` <button type="button" class="btn btn--ghost" data-return>Return or exchange</button>` : ""}</p>
          ${s.returnedTotal ? `<p class="muted">Taken back so far: <strong>${esc(money(s.returnedTotal))}</strong>${s.refundedTotal ? ` · refunded ${esc(money(s.refundedTotal))}` : ""}</p>` : ""}
        </header>
        <div class="adm-card"><h2 class="adm-h2">Customer</h2>
          <p>${s.customer ? `${esc(s.customer.name)} · ${esc(s.customer.phone)}${s.customer.email ? ` · ${esc(s.customer.email)}` : ""}` : "Walk-in customer"}</p>
          ${s.address ? `<p>${esc(s.address.line1 ?? "")}, ${esc(s.address.area ?? "")}, ${esc(s.address.city ?? "")}</p>` : ""}
          <p class="muted">Warehouse: ${esc(whs)}${s.shippingMethod?.name ? ` · Delivery: ${esc(s.shippingMethod.name)}` : ""}</p></div>
        <div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Items sold</caption>
          <thead><tr><th>Item</th><th>Qty</th><th>List price</th><th>Sold at</th><th>Discount</th><th>Line total</th><th>From warehouse</th></tr></thead>
          <tbody>${s.lines.map((l) => `<tr><td>${esc(l.productName)}<br /><span class="muted">${esc(l.colorName)} / ${esc(l.sizeLabel)} · <code>${esc(l.sku)}</code></span></td><td>${l.qty}</td><td>${esc(money(l.regularPrice))}</td><td>${esc(money(l.unitPrice))}</td><td>${l.itemDiscount + l.couponShare ? esc(money(l.itemDiscount + l.couponShare)) : "—"}</td><td>${esc(money(l.lineTotal))}</td><td>${l.allocations.map((a) => `${a.qty} × ${esc(names.get(a.warehouseId) ?? a.warehouseId)}`).join("<br />")}</td></tr>`).join("")}</tbody></table></div>
        <dl class="adm-card adm-details">
          <dt>Gross sales (list prices)</dt><dd>${esc(money(s.grossSales))}</dd>
          <dt>Sale-price discounts</dt><dd>− ${esc(money(s.itemDiscountTotal))}</dd>
          <dt>Subtotal</dt><dd>${esc(money(s.subtotal))}</dd>
          <dt>Coupon discount${s.couponCode ? ` (${esc(s.couponCode)})` : ""}</dt><dd>− ${esc(money(s.discountTotal))}</dd>
          <dt>Net sales</dt><dd><strong>${esc(money(s.netSales))}</strong></dd>
          <dt>Delivery</dt><dd>${esc(money(s.shippingTotal))}</dd>${s.taxTotal ? `<dt>Tax</dt><dd>${esc(money(s.taxTotal))}</dd>` : ""}
          <dt>Total</dt><dd><strong>${esc(money(s.total))}</strong></dd></dl>
        <div class="adm-card"><h2 class="adm-h2">Payment</h2>
          <p>${esc(SALE_PAYMENT_LABEL[s.paymentMethod] ?? s.paymentMethod)} · paid ${esc(money(s.paidTotal))}${s.refundedTotal ? ` · refunded ${esc(money(s.refundedTotal))}` : ""} · <strong>due ${esc(money(s.amountDue))}</strong></p>
          <p class="muted">Entries below are records of money received; nothing here charges a card or wallet.</p>
          ${txs.length ? `<ul class="adm-feed">${txs.map((t) => `<li><span><strong>${t.type === "refund" ? "Refund" : t.type === "reversal" ? "Reversal" : "Payment"}</strong> ${esc(money(t.amount))}${t.methodLabel || t.method ? ` · ${esc(t.methodLabel ?? SALE_PAYMENT_LABEL[t.method] ?? t.method)}` : ""}${t.reference ? ` · ${esc(t.reference)}` : ""}${t.reason || t.note ? ` — ${esc(t.reason || t.note)}` : ""}${t.type === "collection" && reversed.has(t.id) ? ` <span class="tag tag--out">Reversed</span>` : ""}${canPay && t.type === "collection" && !reversed.has(t.id) && !s.refundedTotal && !["cancelled", "returned", "refunded"].includes(s.status) ? ` <button type="button" class="text-btn" data-reverse="${esc(t.id)}">Reverse</button>` : ""}</span><span class="muted">${esc(dateOf(t.at))}</span></li>`).join("")}</ul>` : `<p class="muted">No payment entries yet.</p>`}</div>
        ${canCost ? costBox(cost) : ""}`;

      page.querySelector("[data-print]").addEventListener("click", () =>
        printInvoice({ ...s, items: s.lines.map((l) => ({ ...l, variantLabel: `${l.colorName} / ${l.sizeLabel}` })), grandTotal: s.total, number: s.number, shippingMethod: s.shippingMethod ?? {} }, { storeName: store?.storeName, address: store?.address, phone: store?.phone, email: store?.email }),
      );
      page.querySelector("[data-pay]")?.addEventListener("click", () => payDialog(s, draw));
      page.querySelector("[data-return]")?.addEventListener("click", () => returnDialog(s, draw));
      page.querySelectorAll("[data-reverse]").forEach((b) => b.addEventListener("click", () => reverseDialog(s, /** @type {HTMLElement} */ (b).dataset.reverse, draw)));
    }
    await draw();
  }
}

/** Cost and gross profit from the snapshot saved with the sale. @param {any | null} c */
function costBox(c) {
  if (!c) return `<div class="adm-card"><h2 class="adm-h2">Cost and gross profit</h2><p class="muted">Not available.</p></div>`;
  return `<div class="adm-card"><h2 class="adm-h2">Cost and gross profit</h2>
    ${c.costComplete ? `<p>Cost of goods <strong>${esc(money(c.costTotal))}</strong> · Gross profit <strong>${esc(money(c.grossProfit))}</strong> (net sales − cost of goods)</p>` : `<p class="muted">The cost of these pairs was not recorded when they were sold (orders from before cost tracking, or no cost on the product), so no profit is stated for this sale.</p>`}
    <p class="muted">Gross profit is not net profit: delivery, expenses, salaries and rent are not included. The cost shown is what the pairs cost at the time of the sale and never changes.</p>
    <ul class="adm-feed">${c.costLines.map((l) => `<li><span>${l.costKnown ? `cost ${esc(money(l.unitCost))} each · ${esc(money(l.lineCost))} · profit ${esc(money(l.lineProfit))}` : "cost not recorded"}</span></li>`).join("")}</ul></div>`;
}

function payDialog(s, onDone) {
  const key = newKey();
  formDialog({
    title: `Record a payment — ${s.number}`,
    intro: `Still due: <strong>${esc(money(s.amountDue))}</strong>. You can record several payments that add up to the total. This records money you received; nothing is charged from here.`,
    submit: "Record payment",
    body: `${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal"'))}
      ${row("method", "Method", select("method", SALE_PAYMENT_METHODS.map((m) => [m, SALE_PAYMENT_LABEL[m]]), s.paymentMethod === "cod" ? "cash" : "bank_transfer"))}
      ${row("reference", "Transaction / reference number", input("reference", 'maxlength="80"'), "Needed for bank, JazzCash and Easypaisa")}
      ${row("note", "Note (optional)", input("note", 'maxlength="300"'))}`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const amount = toPaisa(f.amount.value);
      const parsed = recordSalePaymentInput.safeParse({ idempotencyKey: key, saleId: s.id, amount: amount ?? 0, method: f.method.value, reference: f.reference.value, note: f.note.value });
      if (!parsed.success || Number.isNaN(amount)) return show("Please check the highlighted fields.", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(Number.isNaN(amount) ? { amount: "Enter an amount in rupees, e.g. 12500" } : {}) });
      const r = await call("recordSalePayment", parsed.data);
      close();
      toast(r.amountDue ? `Recorded. ${money(r.amountDue)} still due.` : "Recorded. Fully paid.");
      onDone();
    },
  });
}

/** Take goods back from a walk-in sale. The server works out every amount; this only says what is coming back. */
async function returnDialog(s, onDone) {
  const key = newKey();
  /** @type {string | null} */
  let sessionId = null;
  try { sessionId = (await call("posContext", {})).session?.id ?? null; } catch { /* no POS access: a cash refund will say so */ }
  formDialog({
    title: `Return or exchange — ${s.number}`,
    intro: `Choose how many pairs are coming back. Resellable pairs go back on the shelf where they were sold from; damaged pairs are written off. The refund is worked out from what was actually paid. For an exchange, take the pair back here, then ring up the new pair as a normal sale.`,
    submit: "Take back",
    wide: true,
    body: `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Item</th><th>Sold</th><th>Back now</th><th>Condition</th></tr></thead><tbody>${s.lines.map((l, i) => { const left = l.qty - (l.returnedQty ?? 0); return `<tr><td>${esc(l.productName)}<br /><span class="muted">${esc(l.colorName)} / ${esc(l.sizeLabel)} · ${esc(money(l.unitPrice))}</span></td><td>${l.qty}${l.returnedQty ? ` <span class="muted">(${l.returnedQty} already back)</span>` : ""}</td><td><input name="qty${i}" type="number" min="0" max="${left}" value="0" ${left ? "" : "disabled"} aria-label="Pairs coming back" /></td><td><select name="cond${i}"><option value="resellable">Resellable</option><option value="damaged">Damaged</option></select></td></tr>`; }).join("")}</tbody></table></div>
      ${row("reason", "Reason", input("reason", 'maxlength="200"'))}
      ${row("refundMethod", "Refund paid by", select("refundMethod", SALE_PAYMENT_METHODS.filter((m) => m !== "cod").map((m) => [m, SALE_PAYMENT_LABEL[m]]), "cash"), "Cash comes out of your open register")}
      ${row("reference", "Transaction / reference number", input("reference", 'maxlength="80"'), "Needed for bank, JazzCash and Easypaisa refunds")}
      <div class="field"><label><input type="checkbox" name="exchange" /> This is an exchange (the customer is taking other pairs)</label></div>`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const lines = s.lines.map((l, i) => ({ lineIndex: i, qty: Number(f[`qty${i}`].value) || 0, condition: f[`cond${i}`].value })).filter((l) => l.qty > 0);
      const parsed = posReturnInput.safeParse({ idempotencyKey: key, saleId: s.id, sessionId, lines, reason: f.reason.value, refundMethod: f.refundMethod.value, reference: f.reference.value, exchange: f.exchange.checked });
      if (!parsed.success) return show(lines.length ? "Please check the highlighted fields." : "Choose at least one pair to take back.", parsed.success ? {} : fieldErrors(parsed.error));
      const r = await call("posReturn", parsed.data);
      close();
      toast(r.refund ? `Taken back. Refund ${money(r.refund)} (${r.number}).` : `Taken back (${r.number}). Nothing to refund: it reduces what the customer owes.`);
      onDone();
    },
  });
}

function reverseDialog(s, transactionId, onDone) {
  const key = newKey();
  formDialog({
    title: "Reverse a payment entry",
    intro: "Use this only to correct a mistake. The original entry stays in the history; a new opposite entry is added.",
    submit: "Reverse entry",
    body: row("reason", "Why is it being reversed?", input("reason", 'maxlength="200"')),
    async onSubmit(form, { show, close }) {
      const parsed = reverseSalePaymentInput.safeParse({ idempotencyKey: key, saleId: s.id, transactionId, reason: /** @type {any} */ (form.elements).reason.value });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      await call("reverseSalePayment", parsed.data);
      close();
      toast("Reversed. The original entry is kept in the history.");
      onDone();
    },
  });
}
