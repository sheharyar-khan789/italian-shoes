/**
 * Printable invoice / order slip. Built from the order's own saved snapshot, so it always shows
 * what was actually bought at the price paid. Everything dynamic is escaped.
 */
import { esc } from "../lib/format.js";
import { formatPKR } from "../../shared/money.js";
import { formatWhen } from "../lib/when.js";
import { STATUS_LABEL, PAYMENT_LABEL, METHOD_LABEL } from "./orderLabels.js";

/** @param {any} order @param {{ storeName?: string, address?: string, phone?: string, email?: string }} store */
export function invoiceHtml(order, store = {}) {
  const row = (l) => `<tr><td>${esc(l.productName)}<br /><span class="inv-sub">${esc(l.variantLabel)} · ${esc(l.sku)}</span></td><td class="inv-n">${l.qty}</td><td class="inv-n">${formatPKR(l.unitPrice)}</td><td class="inv-n">${formatPKR(l.lineTotal)}</td></tr>`;
  const a = order.address ?? {};
  return `
  <article class="invoice-sheet" aria-label="Invoice ${esc(order.number)}">
    <header class="inv-head">
      <div>
        <h1>${esc(store.storeName || "Invoice")}</h1>
        ${store.address ? `<p>${esc(store.address)}</p>` : ""}
        ${store.phone ? `<p>${esc(store.phone)}</p>` : ""}
        ${store.email ? `<p>${esc(store.email)}</p>` : ""}
      </div>
      <div class="inv-meta">
        <p><strong>Invoice / Order</strong></p>
        <p class="inv-no">${esc(order.number)}</p>
        <p>${esc(formatWhen(order.createdAt))}</p>
        <p>Status: ${esc(STATUS_LABEL[order.status] ?? order.status)}</p>
      </div>
    </header>
    <section class="inv-two">
      <div><h2>Deliver to</h2>
        <p>${esc(order.customer?.name)}<br />${esc(order.customer?.phone)}</p>
        <p>${esc(a.line1)}<br />${esc(a.area)}, ${esc(a.city)}</p>
        ${order.deliveryInstructions ? `<p class="inv-sub">Instructions: ${esc(order.deliveryInstructions)}</p>` : ""}</div>
      <div><h2>Payment</h2>
        <p>${esc(METHOD_LABEL[order.paymentMethod] ?? order.paymentMethod)}</p>
        <p>${esc(PAYMENT_LABEL[order.paymentStatus] ?? order.paymentStatus)}</p>
        <h2>Delivery</h2><p>${esc(order.shippingMethod?.name ?? "")}${order.shippingMethod?.estimateText ? ` · ${esc(order.shippingMethod.estimateText)}` : ""}</p></div>
    </section>
    <table class="inv-table">
      <thead><tr><th>Item</th><th class="inv-n">Qty</th><th class="inv-n">Price</th><th class="inv-n">Total</th></tr></thead>
      <tbody>${(order.items ?? []).map(row).join("")}</tbody>
    </table>
    <dl class="inv-totals">
      <div><dt>Subtotal</dt><dd>${formatPKR(order.subtotal)}</dd></div>
      ${order.discountTotal ? `<div><dt>Discount</dt><dd>− ${formatPKR(order.discountTotal)}</dd></div>` : ""}
      ${order.taxTotal ? `<div><dt>Tax</dt><dd>${formatPKR(order.taxTotal)}</dd></div>` : ""}
      <div><dt>Delivery</dt><dd>${order.shippingTotal ? formatPKR(order.shippingTotal) : "Free"}</dd></div>
      <div class="inv-grand"><dt>Total</dt><dd>${formatPKR(order.grandTotal)}</dd></div>
    </dl>
    ${order.notes ? `<p class="inv-sub">Order notes: ${esc(order.notes)}</p>` : ""}
  </article>`;
}

/** Print an invoice without leaving the page (the rest of the page is hidden while printing). */
export function printInvoice(order, store) {
  const host = document.createElement("div");
  host.className = "invoice-print";
  host.innerHTML = invoiceHtml(order, store);
  document.body.append(host);
  document.body.classList.add("is-printing-invoice");
  const done = () => {
    host.remove();
    document.body.classList.remove("is-printing-invoice");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
}
