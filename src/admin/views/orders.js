/**
 * Orders: list (/admin/orders) and order page (/admin/orders/{id}).
 * Staff can only make valid status changes (the same map the server enforces).
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { normalizePkMobile } from "../../../shared/phone.js";
import { ORDER_STATUSES, ORDER_TRANSITIONS } from "../../../shared/orderStatus.js";
import { addShipmentInput, addOrderNoteInput, recordRefundInput, fieldErrors } from "../../../shared/schemas/index.js";
import { paymentTransactions } from "../payData.js";
import { toPaisa, rupeesField } from "../ui/money.js";
import { toast, confirmDialog, errorState, dataTable, emptyState, formatWhen } from "../ui/kit.js";
import { STATUS_LABEL, PAYMENT_LABEL, METHOD_LABEL } from "../../ui/orderLabels.js";
import { printInvoice } from "../../ui/invoice.js";
import { imageUrl } from "../../app/firebase.js";
import { loadSettings, staffDirectory } from "../data.js";
import { listOrders, getOrder, orderHistory, orderShipments, orderNotes, paymentOf, call } from "../orderData.js";
import { fnResult } from "./catalogue.js";
import { busy, showResult } from "../../ui/forms.js";

const tag = (s) => `<span class="tag tag--o-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
const ORDER_NO = /^[A-Za-z]{2,6}-\d{4}-\d{6}$/;

export default async function orders(ctx) {
  return ctx.params[0] ? orderPage(ctx, ctx.params[0]) : orderList(ctx);
}

/* ───────── List ───────── */

async function orderList({ main, user }) {
  const canExport = user.perms.includes("orders.export");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head adm-page__head--row">
        <div><h1 class="adm-h1">Orders</h1><p class="muted">Newest first. Open an order to confirm it, add tracking or print the invoice.</p></div>
        ${canExport ? `<button type="button" class="btn btn--ghost" data-export-open>Export to Excel (CSV)</button>` : ""}
      </header>
      <form class="adm-filters adm-filters--orders" data-filters>
        <label class="visually-hidden" for="o-q">Find an order</label>
        <input id="o-q" type="search" placeholder="Order number (IS-2026-000123) or customer phone" />
        <label class="visually-hidden" for="o-status">Status</label>
        <select id="o-status"><option value="">All statuses</option>${ORDER_STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select>
        <button type="submit" class="btn btn--ghost"><span>Search</span></button>
      </form>
      <p class="form-alert" role="alert" data-search-alert hidden></p>
      <div data-table><p class="muted">Loading…</p></div>
    </div>`;
  const wrap = main.querySelector("[data-table]");
  const alertEl = /** @type {HTMLElement} */ (main.querySelector("[data-search-alert]"));
  const table = dataTable({
    caption: "Orders",
    empty: { title: "No orders match", text: "Try another status, or search by order number or phone." },
    columns: [
      { key: "number", label: "Order", render: (o) => `<a class="text-link" href="/admin/orders/${esc(o.id)}" data-link>${esc(o.number)}</a>`, className: "nowrap" },
      { key: "createdAt", label: "Placed", render: (o) => esc(formatWhen(o.createdAt)), className: "nowrap" },
      { key: "customer", label: "Customer", render: (o) => `${esc(o.customer?.name)}<br /><span class="muted">${esc(o.address?.city)}</span>` },
      { key: "itemCount", label: "Items" },
      { key: "grandTotal", label: "Total", render: (o) => esc(formatPKR(o.grandTotal)), className: "nowrap" },
      { key: "status", label: "Status", render: (o) => tag(o.status) },
      { key: "payment", label: "Payment", render: (o) => esc(PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus) },
    ],
  });
  let last = null;
  const load = async (more = false) => {
    const q = /** @type {HTMLInputElement} */ (main.querySelector("#o-q")).value.trim();
    const status = /** @type {HTMLSelectElement} */ (main.querySelector("#o-status")).value || undefined;
    alertEl.hidden = true;
    /** @type {{ status?: string, number?: string, phone?: string, after?: any }} */
    let query = { status, after: more ? last : undefined };
    if (q) {
      if (ORDER_NO.test(q)) query = { number: q.toUpperCase() };
      else if (normalizePkMobile(q)) query = { phone: normalizePkMobile(q) };
      else {
        alertEl.textContent = "Enter a full order number (like IS-2026-000123) or a mobile number (like 0300 1234567).";
        alertEl.hidden = false;
        return;
      }
    }
    try {
      const page = await listOrders(query);
      last = page.last;
      if (!wrap.contains(table.el)) wrap.replaceChildren(table.el);
      (more ? table.append : table.set)(page.items, page.hasMore);
    } catch {
      wrap.innerHTML = errorState();
      wrap.querySelector("[data-retry]")?.addEventListener("click", () => load(false));
    }
  };
  table.onMore(() => load(true));
  main.querySelector("[data-filters]").addEventListener("submit", (e) => {
    e.preventDefault();
    load(false);
  });
  main.querySelector("#o-status").addEventListener("change", () => load(false));
  main.querySelector("[data-export-open]")?.addEventListener("click", () => exportDialog());
  await load();
}

function exportDialog() {
  const d = document.createElement("dialog");
  d.className = "adm-dialog";
  d.setAttribute("aria-labelledby", "exp-title");
  d.innerHTML = `<form novalidate data-exp>
    <h2 id="exp-title">Export orders</h2>
    <p class="muted">Downloads a spreadsheet (CSV) that opens in Excel. Leave the dates empty to export everything (up to 5,000 orders).</p>
    <p class="form-alert" role="alert" data-form-alert hidden></p>
    <div class="field"><label for="exp-from">From</label><input id="exp-from" name="from" type="date" /></div>
    <div class="field"><label for="exp-to">To</label><input id="exp-to" name="to" type="date" /></div>
    <div class="field"><label for="exp-status">Status</label><select id="exp-status" name="status"><option value="">All</option>${ORDER_STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select></div>
    <div class="adm-dialog__actions"><button type="button" class="btn btn--ghost" data-close>Cancel</button><button type="submit" class="btn btn--primary"><span>Download</span></button></div></form>`;
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.querySelector("[data-close]").addEventListener("click", () => d.close());
  const form = /** @type {HTMLFormElement} */ (d.querySelector("[data-exp]"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const k of ["from", "to", "status"]) if (fd.get(k)) body[k] = fd.get(k);
    const result = await busy(form, async () => {
      try {
        const { csv, count } = await call("exportOrders", body);
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = Object.assign(document.createElement("a"), { href: url, download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return { ok: true, count };
      } catch (error) {
        return fnResult(error);
      }
    }, "Preparing…");
    showResult(form, result);
    if (result.ok) {
      toast(`${result.count} order(s) exported.`);
      d.close();
    }
  });
  d.showModal();
}

/* ───────── Order page ───────── */

async function orderPage({ main, user }, id) {
  const canUpdate = user.perms.includes("orders.update");
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading…</p></div>`;
  let order, history, shipments, notes, payment, ptx, store, names;
  try {
    order = await getOrder(id);
    if (!order) {
      main.innerHTML = `<div class="adm-page">${emptyState({ title: "Order not found", action: `<a class="btn btn--ghost" href="/admin/orders" data-link>Back to orders</a>` })}</div>`;
      return;
    }
    [history, shipments, notes, payment, ptx, store, names] = await Promise.all([
      orderHistory(id),
      orderShipments(id),
      orderNotes(id),
      paymentOf(id).catch(() => null),
      paymentTransactions(id).catch(() => []),
      loadSettings().then((s) => s.public ?? {}).catch(() => ({})),
      staffDirectory().catch(() => ({})),
    ]);
  } catch {
    main.innerHTML = `<div class="adm-page">${errorState()}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => orderPage({ main, user }, id));
    return;
  }

  const next = ORDER_TRANSITIONS[order.status] ?? [];
  const a = order.address ?? {};
  const closed = ["cancelled", "returned", "refunded"].includes(order.status);

  /* Payment panel: record cash, record refunds, see the history. */
  const canPay = user.perms.includes("payments.update");
  const pay = payment ?? { status: order.paymentStatus, amount: order.grandTotal, method: order.paymentMethod, refundedTotal: 0 };
  const refundable = pay.amount - (pay.refundedTotal ?? 0);
  const canCollect = canPay && pay.method === "cod" && pay.status === "pending" && ["dispatched", "delivered"].includes(order.status);
  const canRefund = canPay && ["collected", "paid", "partially_refunded"].includes(pay.status) && refundable > 0;
  const paymentPanel = `<section class="adm-section adm-card"><h2 class="adm-h2">Payment</h2>
      <p>${esc(METHOD_LABEL[order.paymentMethod] ?? order.paymentMethod)} · ${esc(formatPKR(pay.amount))}<br /><strong>${esc(PAYMENT_LABEL[pay.status] ?? pay.status)}</strong>${pay.refundedTotal ? `<br />Refunded so far: ${esc(formatPKR(pay.refundedTotal))}` : ""}</p>
      ${canCollect ? `<button type="button" class="btn btn--primary" data-collect><span>Record cash collected</span></button>` : ""}
      ${pay.status === "pending" && canPay && !canCollect && !["cancelled", "returned", "refunded"].includes(order.status) ? `<p class="fine">Cash can be recorded once the order is dispatched or delivered.</p>` : ""}
      ${pay.status === "void" ? `<p class="fine">The order was closed before any cash was collected, so nothing is owed.</p>` : ""}
      ${canRefund ? `<details class="accordion"><summary>Record a refund</summary>
        <form class="adm-form" novalidate data-refund><p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
          <div class="field" data-field="amount"><label for="rf-a">Amount (Rs)</label><input id="rf-a" name="amount" inputmode="decimal" value="${esc(rupeesField(refundable))}" /><p class="field-hint">Up to ${esc(formatPKR(refundable))} can still be refunded.</p><p class="field-error" hidden></p></div>
          <div class="field" data-field="reason"><label for="rf-r">Reason</label><input id="rf-r" name="reason" maxlength="300" /><p class="field-error" hidden></p></div>
          <p class="fine">This records that you gave the money back. The cash handover itself happens outside this system.</p>
          <div class="form-actions"><button class="btn btn--ghost" type="submit"><span>Record refund</span></button></div></form></details>` : ""}
      ${ptx.length ? `<ul class="adm-feed">${ptx.map((t) => `<li><span><strong>${t.type === "refund" ? "Refund" : "Cash collected"}</strong> ${esc(formatPKR(t.amount))}${t.reason || t.note ? ` — ${esc(t.reason || t.note)}` : ""}<br /><span class="muted">${esc(names[t.actorUid] ?? "Staff member")}</span></span><span class="muted">${esc(formatWhen(t.at))}</span></li>`).join("")}</ul>` : ""}
    </section>`;
  main.innerHTML = `
    <div class="adm-page">
      <p><a class="text-link" href="/admin/orders" data-link>← All orders</a></p>
      <header class="adm-page__head adm-page__head--row">
        <div><h1 class="adm-h1">${esc(order.number)}</h1><p class="muted">${tag(order.status)} · placed ${esc(formatWhen(order.createdAt))}</p></div>
        <div class="adm-status-actions"><button type="button" class="btn btn--ghost" data-print>Print invoice</button></div>
      </header>

      <div class="adm-split">
        <div>
          <section class="adm-section adm-card"><h2 class="adm-h2">Items</h2>
            <div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Items in this order</caption>
              <thead><tr><th scope="col"></th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Total</th></tr></thead>
              <tbody>${order.items
                .map(
                  (l) => `<tr><td>${l.imagePath ? `<img class="adm-thumb" src="${esc(imageUrl(l.imagePath))}" alt="" />` : `<span class="adm-thumb adm-thumb--empty"></span>`}</td>
                  <td data-label="Item">${esc(l.productName)}<br /><span class="muted">${esc(l.variantLabel)} · ${esc(l.sku)}</span></td>
                  <td data-label="Qty">${l.qty}</td><td data-label="Price">${esc(formatPKR(l.unitPrice))}${l.regularPrice > l.unitPrice ? `<br /><s class="muted">${esc(formatPKR(l.regularPrice))}</s>` : ""}</td><td data-label="Total">${esc(formatPKR(l.lineTotal))}</td></tr>`,
                )
                .join("")}</tbody></table></div>
            <dl class="totals adm-totals">
              <div><dt>Subtotal</dt><dd>${esc(formatPKR(order.subtotal))}</dd></div>
              ${order.discountTotal ? `<div><dt>Discount</dt><dd>− ${esc(formatPKR(order.discountTotal))}</dd></div>` : ""}
              ${order.taxTotal ? `<div><dt>Tax</dt><dd>${esc(formatPKR(order.taxTotal))}</dd></div>` : ""}
              <div><dt>Delivery · ${esc(order.shippingMethod?.name ?? "")}</dt><dd>${order.shippingTotal ? esc(formatPKR(order.shippingTotal)) : "Free"}</dd></div>
              <div class="totals__grand"><dt>Total</dt><dd>${esc(formatPKR(order.grandTotal))}</dd></div>
            </dl>
          </section>

          <section class="adm-section adm-card"><h2 class="adm-h2">Delivery &amp; tracking</h2>
            <ul class="adm-feed">${shipments.length ? shipments.map((s) => `<li><span><strong>${esc(s.courier)}</strong> · ${esc(s.trackingNumber)}${s.trackingUrl ? ` · <a class="text-link" href="${esc(s.trackingUrl)}" target="_blank" rel="noopener noreferrer">Track</a>` : ""}</span><span class="muted">${esc(formatWhen(s.dispatchedAt))}</span></li>`).join("") : `<li class="muted">No tracking added yet.</li>`}</ul>
            ${
              canUpdate && !closed
                ? `<form class="adm-form" novalidate data-shipment><p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
                  <div class="adm-grid3">
                    <div class="field" data-field="courier"><label for="sh-c">Courier</label><input id="sh-c" name="courier" maxlength="60" /><p class="field-error" hidden></p></div>
                    <div class="field" data-field="trackingNumber"><label for="sh-t">Tracking number</label><input id="sh-t" name="trackingNumber" maxlength="60" /><p class="field-error" hidden></p></div>
                    <div class="field" data-field="trackingUrl"><label for="sh-u">Tracking link <span class="muted">(optional)</span></label><input id="sh-u" name="trackingUrl" type="url" maxlength="300" placeholder="https://" /><p class="field-error" hidden></p></div>
                  </div><div class="form-actions"><button class="btn btn--ghost" type="submit"><span>Add tracking</span></button></div></form>`
                : ""
            }
          </section>

          <section class="adm-section adm-card"><h2 class="adm-h2">Internal notes <span class="muted">(never shown to the customer)</span></h2>
            <ul class="adm-feed">${notes.length ? notes.map((n) => `<li><span>${esc(n.text)}<br /><span class="muted">${esc(names[n.authorUid] ?? "Staff member")}</span></span><span class="muted">${esc(formatWhen(n.createdAt))}</span></li>`).join("") : `<li class="muted">No notes yet.</li>`}</ul>
            ${canUpdate ? `<form class="adm-form" novalidate data-note><p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p><div class="field" data-field="text"><label class="visually-hidden" for="nt">Note</label><textarea id="nt" name="text" rows="2" maxlength="1000" placeholder="Add a note for staff"></textarea><p class="field-error" hidden></p></div><div class="form-actions"><button class="btn btn--ghost" type="submit"><span>Add note</span></button></div></form>` : ""}
          </section>
        </div>

        <aside>
          ${
            canUpdate && next.length
              ? `<section class="adm-section adm-card"><h2 class="adm-h2">Update status</h2>
                  <form class="adm-form" novalidate data-status><p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
                    <div class="field"><label for="st-to">Move to</label><select id="st-to" name="status">${next.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select></div>
                    <div class="field"><label for="st-note">Note <span class="muted">(optional)</span></label><input id="st-note" name="note" maxlength="300" /></div>
                    <p class="fine">Cancelling or returning puts the items back in stock.</p>
                    <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Update status</span></button></div></form></section>`
              : `<section class="adm-section adm-card"><h2 class="adm-h2">Status</h2><p class="muted">${tag(order.status)} — ${next.length ? "you don't have permission to change it." : "no further changes are possible."}</p></section>`
          }
          <section class="adm-section adm-card"><h2 class="adm-h2">Customer</h2>
            <p><strong>${esc(order.customer?.name)}</strong><br />${esc(order.customer?.phone)}${order.customer?.email ? `<br />${esc(order.customer.email)}` : ""}</p>
            <p>${esc(a.line1)}<br />${esc(a.area)}, ${esc(a.city)}</p>
            ${order.deliveryInstructions ? `<p class="muted">Instructions: ${esc(order.deliveryInstructions)}</p>` : ""}
            ${order.notes ? `<p class="muted">Customer's note: ${esc(order.notes)}</p>` : ""}
          </section>
          ${paymentPanel}
          <section class="adm-section adm-card"><h2 class="adm-h2">History</h2>
            <ul class="adm-feed">${history.map((h) => `<li><span>${esc(STATUS_LABEL[h.to] ?? h.to)}${h.note ? ` — ${esc(h.note)}` : ""}<br /><span class="muted">${esc(names[h.actorUid] ?? (h.actorUid === order.userId ? "Customer" : "Staff member"))}</span></span><span class="muted">${esc(formatWhen(h.at))}</span></li>`).join("")}</ul>
          </section>
        </aside>
      </div>
    </div>`;

  main.querySelector("[data-print]").addEventListener("click", () => printInvoice(order, store));
  const reload = () => orderPage({ main, user }, id);

  main.querySelector("[data-collect]")?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Record cash collected?", body: `You are confirming that ${formatPKR(pay.amount)} was received for ${order.number}. This can't be undone.`, confirm: "Record cash" }))) return;
    try {
      await call("recordCollection", { orderId: id });
      toast("Cash recorded.");
      reload();
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
  });

  const refundForm = /** @type {HTMLFormElement | null} */ (main.querySelector("[data-refund]"));
  refundForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(refundForm);
    const parsed = recordRefundInput.safeParse({ orderId: id, amount: toPaisa(String(fd.get("amount") ?? "")), reason: fd.get("reason") });
    if (!parsed.success) return showResult(refundForm, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
    if (!(await confirmDialog({ title: `Record a refund of ${formatPKR(parsed.data.amount)}?`, body: "This can't be undone.", confirm: "Record refund", danger: true }))) return;
    const result = await busy(refundForm, async () => {
      try {
        await call("recordRefund", parsed.data);
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Recording…");
    showResult(refundForm, result);
    if (result.ok) {
      toast("Refund recorded.");
      reload();
    }
  });

  const statusForm = /** @type {HTMLFormElement | null} */ (main.querySelector("[data-status]"));
  statusForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(statusForm);
    const to = String(fd.get("status"));
    const warn = to === "cancelled" || to === "returned";
    if (!(await confirmDialog({ title: `Mark as ${STATUS_LABEL[to].toLowerCase()}?`, body: warn ? "The items will be put back in stock." : "The customer will see the new status.", confirm: "Update", danger: warn }))) return;
    const result = await busy(statusForm, async () => {
      try {
        await call("updateOrderStatus", { orderId: id, status: to, note: fd.get("note") ?? "" });
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Updating…");
    showResult(statusForm, result);
    if (result.ok) {
      toast("Status updated.");
      reload();
    }
  });

  const submitSimple = (formSel, schema, fn, okMsg) => {
    const form = /** @type {HTMLFormElement | null} */ (main.querySelector(formSel));
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const parsed = schema.safeParse({ orderId: id, ...Object.fromEntries(new FormData(form)) });
      if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
      const result = await busy(form, async () => {
        try {
          await call(fn, parsed.data);
          return { ok: true };
        } catch (error) {
          return fnResult(error);
        }
      }, "Saving…");
      showResult(form, result);
      if (result.ok) {
        toast(okMsg);
        reload();
      }
    });
  };
  submitSimple("[data-shipment]", addShipmentInput, "addShipment", "Tracking added.");
  submitSimple("[data-note]", addOrderNoteInput, "addOrderNote", "Note added.");
}
