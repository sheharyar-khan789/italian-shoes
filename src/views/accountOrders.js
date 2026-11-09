/** Customer order pages: history (/account/orders) and a single order (/account/orders/{id}). */
import { esc } from "../lib/format.js";
import { arrow } from "../ui/components.js";
import { navigate } from "../app/router.js";
import { shell, accountNav, bindSignOut, requireUser } from "./account.js";
import { listMyOrders, getMyOrder, cancelMyOrder, publicStoreSettings } from "../app/ordersData.js";
import { formatPKR } from "../../shared/money.js";
import { formatWhen } from "../lib/when.js";
import { STATUS_LABEL, CUSTOMER_STATUS_TEXT, PAYMENT_LABEL, METHOD_LABEL } from "../ui/orderLabels.js";
import { printInvoice } from "../ui/invoice.js";
import { customerCanCancel } from "../../shared/orderStatus.js";
import { imageUrl } from "../app/firebase.js";
import { productById, whenCatalog } from "../app/state.js";

const tag = (st) => `<span class="tag tag--o-${esc(st)}">${esc(STATUS_LABEL[st] ?? st)}</span>`;

export async function ordersView({ outlet }) {
  document.title = "Your orders";
  const user = await requireUser();
  if (!user) return;
  outlet.innerHTML = shell("Account", "Your <em>orders</em>", `${accountNav("orders")}<div data-slot><p class="muted">Loading…</p></div>`);
  bindSignOut(outlet);
  const slot = outlet.querySelector("[data-slot]");
  let list;
  try {
    list = await listMyOrders(user.uid);
  } catch {
    slot.innerHTML = `<p class="form-alert" role="alert">Your orders couldn't be loaded. Check your connection and reload the page.</p>`;
    return;
  }
  slot.innerHTML = list.length
    ? `<ul class="order-list">${list
        .map(
          (o) => `<li><a class="order-card" href="/account/orders/${esc(o.id)}">
            <span class="order-card__top"><strong>${esc(o.number)}</strong>${tag(o.status)}</span>
            <span class="muted">${esc(formatWhen(o.createdAt))} · ${o.itemCount} item${o.itemCount === 1 ? "" : "s"}</span>
            <span class="order-card__total">${esc(formatPKR(o.grandTotal))}</span></a></li>`,
        )
        .join("")}</ul>`
    : `<div class="empty"><p class="empty__title">No orders yet</p><p class="empty__text">When you place an order, it will appear here.</p><a class="btn btn--primary" href="/shop"><span>Start shopping</span>${arrow}</a></div>`;
}

/** The page shown right after checkout: the same order view with a thank-you note on top. */
export const orderPlacedView = (ctx) => orderView(ctx, { placed: true });

export async function orderView({ outlet, params }, { placed = false } = {}) {
  document.title = placed ? "Thank you for your order" : "Order";
  await whenCatalog();
  const user = await requireUser();
  if (!user) return;
  outlet.innerHTML = shell("Account", "Your <em>order</em>", `${accountNav("orders")}<div data-slot><p class="muted">Loading…</p></div>`);
  bindSignOut(outlet);
  const slot = outlet.querySelector("[data-slot]");
  let data;
  try {
    data = await getMyOrder(params[0]);
  } catch {
    // Someone else's order id is refused by the security rules, exactly like an unknown id.
    data = null;
  }
  if (!data) {
    slot.innerHTML = `<div class="empty"><p class="empty__title">Order not found</p><a class="btn btn--ghost" href="/account/orders">Back to my orders</a></div>`;
    return;
  }
  const { order, history, shipments } = data;
  document.title = `Order ${order.number}`;
  const a = order.address ?? {};
  slot.innerHTML = `
    <section class="account-section order-view">
      ${placed ? `<div class="notice notice--ok" role="status"><strong>Thank you! Your order is placed.</strong> You'll pay in cash when it arrives. We'll update the progress below as it moves.</div>` : ""}
      <h2 class="account-section__title">${esc(order.number)} ${tag(order.status)}</h2>
      <p class="muted">${esc(CUSTOMER_STATUS_TEXT[order.status] ?? "")} Placed ${esc(formatWhen(order.createdAt))}.</p>
      ${shipments.length ? `<div class="notice" role="note"><strong>Tracking:</strong> ${shipments.map((s) => `${esc(s.courier)} ${esc(s.trackingNumber)}${s.trackingUrl ? ` — <a class="text-link" href="${esc(s.trackingUrl)}" target="_blank" rel="noopener noreferrer">Track your parcel</a>` : ""}`).join("; ")}</div>` : ""}
      <ul class="lines">${order.items
        .map(
          (l) => `<li class="line"><div class="line__media">${l.imagePath ? `<img class="adm-thumb" src="${esc(imageUrl(l.imagePath))}" alt="" />` : ""}</div>
            <div class="line__info"><p class="line__name">${esc(l.productName)}</p><p class="line__meta">${esc(l.variantLabel)} · Qty ${l.qty}</p><p class="line__meta">${esc(formatPKR(l.unitPrice))} each</p>${order.status === "delivered" && productById(l.productId) ? `<p class="line__meta"><a class="text-link" href="/product/${esc(productById(l.productId).slug)}#reviews">Write a review</a></p>` : ""}</div>
            <p class="line__total">${esc(formatPKR(l.lineTotal))}</p></li>`,
        )
        .join("")}</ul>
      <dl class="totals">
        <div><dt>Subtotal</dt><dd>${esc(formatPKR(order.subtotal))}</dd></div>
        ${order.discountTotal ? `<div><dt>Discount</dt><dd>− ${esc(formatPKR(order.discountTotal))}</dd></div>` : ""}
        ${order.taxTotal ? `<div><dt>Tax</dt><dd>${esc(formatPKR(order.taxTotal))}</dd></div>` : ""}
        <div><dt>Delivery</dt><dd>${order.shippingTotal ? esc(formatPKR(order.shippingTotal)) : "Free"}</dd></div>
        <div class="totals__grand"><dt>Total</dt><dd>${esc(formatPKR(order.grandTotal))}</dd></div>
      </dl>
      <p class="muted">${esc(METHOD_LABEL[order.paymentMethod] ?? order.paymentMethod)} — ${esc(PAYMENT_LABEL[order.paymentStatus] ?? order.paymentStatus)}</p>
      <h3 class="account-section__title">Delivering to</h3>
      <p>${esc(order.customer?.name)} · ${esc(order.customer?.phone)}<br />${esc(a.line1)}<br />${esc(a.area)}, ${esc(a.city)}</p>
      <h3 class="account-section__title">Progress</h3>
      <ol class="timeline">${history.map((h) => `<li><strong>${esc(STATUS_LABEL[h.to] ?? h.to)}</strong><span class="muted">${esc(formatWhen(h.at))}</span></li>`).join("")}</ol>
      <p class="form-alert" role="alert" tabindex="-1" data-cancel-alert hidden></p>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" data-print>Print invoice</button>
        ${customerCanCancel(order.status) ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel this order</button>` : ""}
      </div>
    </section>`;

  slot.querySelector("[data-print]").addEventListener("click", async () => printInvoice(order, await publicStoreSettings().catch(() => ({}))));
  slot.querySelector("[data-cancel]")?.addEventListener("click", async (e) => {
    if (!window.confirm("Cancel this order? This can't be undone.")) return;
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    try {
      await cancelMyOrder(order.id);
      navigate(`/account/orders/${order.id}`, { replace: true });
    } catch (error) {
      const alert = /** @type {HTMLElement} */ (slot.querySelector("[data-cancel-alert]"));
      alert.textContent = /** @type {any} */ (error)?.code && error.code !== "functions/internal" ? error.message : "Couldn't cancel. Please try again.";
      alert.hidden = false;
      btn.disabled = false;
    }
  });
}
