import { esc, formatPKR, pluralize } from "../lib/format.js";
import { productMedia } from "./illustration.js";
import { cart, cartSnapshot } from "../app/state.js";
import { arrow, emptyState } from "./components.js";

const deliveryLabel = (fee) => (fee == null ? "Calculated at checkout" : fee === 0 ? "Free" : formatPKR(fee));

/**
 * @param {{ itemCount: number, subtotal: number, discount?: number, delivery?: number | null, tax?: number, total?: number | null }} totals
 *   In the bag only itemCount + subtotal are known; at checkout the server supplies the rest.
 */
export function totalsBlock(totals) {
  const known = totals.total != null;
  return `
  <dl class="totals">
    <div><dt>Subtotal <span class="muted">(${pluralize(totals.itemCount, "item")})</span></dt><dd>${formatPKR(totals.subtotal)}</dd></div>
    ${totals.discount ? `<div><dt>Discount</dt><dd>− ${formatPKR(totals.discount)}</dd></div>` : ""}
    ${totals.tax ? `<div><dt>Tax</dt><dd>${formatPKR(totals.tax)}</dd></div>` : ""}
    <div><dt>Delivery</dt><dd class="${totals.delivery == null ? "muted" : ""}">${deliveryLabel(totals.delivery)}</dd></div>
    <div class="totals__grand">
      <dt>${known ? "Total to pay" : "Total"}</dt>
      <dd>${known ? formatPKR(totals.total) : `${formatPKR(totals.subtotal)}<small>+ delivery</small>`}</dd>
    </div>
  </dl>`;
}

function lineItem(l, { editable }) {
  const href = `/product/${l.product.slug}?color=${l.color.id}`;
  const k = esc(l.key);
  return `
  <li class="line${l.available ? "" : " is-unavailable"}">
    <a class="line__media" href="${href}" tabindex="-1" aria-hidden="true">${productMedia(l.product, l.color)}</a>
    <div class="line__info">
      <p class="line__name"><a href="${href}">${esc(l.product.name)}</a></p>
      <p class="line__meta">${esc(l.color.name)} · Size ${esc(l.sizeLabel)}</p>
      <p class="line__meta">${formatPKR(l.unitPrice)} each</p>
      ${l.available ? "" : `<p class="line__warn">No longer available in this quantity — please remove or reduce.</p>`}
      ${
        editable
          ? `<div class="line__actions">
              <div class="stepper" role="group" aria-label="Quantity for ${esc(l.product.name)}, size ${esc(l.sizeLabel)}">
                <button type="button" data-qty="dec" data-key="${k}" aria-label="Decrease quantity" ${l.qty <= 1 ? "disabled" : ""}>−</button>
                <output aria-live="polite">${l.qty}</output>
                <button type="button" data-qty="inc" data-key="${k}" aria-label="Increase quantity" ${l.qty >= l.maxQty ? "disabled" : ""}>+</button>
              </div>
              <button type="button" class="text-btn" data-remove="${k}">Remove<span class="visually-hidden"> ${esc(l.product.name)}</span></button>
            </div>
            ${l.qty >= l.maxQty && l.maxQty > 0 ? `<p class="line__note">Maximum available for this size.</p>` : ""}`
          : `<p class="line__meta">Qty ${l.qty}</p>`
      }
    </div>
    <p class="line__total">${formatPKR(l.lineTotal)}</p>
  </li>`;
}

export const lineList = (lines, opts) => `<ul class="lines">${lines.map((l) => lineItem(l, opts)).join("")}</ul>`;

/** Full bag contents for the drawer and the /cart page. */
export function bagContents({ variant }) {
  const { lines, totals, hasUnavailable } = cartSnapshot();
  if (!lines.length) {
    return emptyState({ title: "Your bag is empty.", text: "Add a pair and it will wait for you here — even after a refresh." });
  }
  return `
    ${lineList(lines, { editable: true })}
    <div class="bag__summary">
      ${totalsBlock(totals)}
      <p class="fine">Delivery is worked out from your city at checkout.</p>
      ${hasUnavailable ? `<p class="form-alert" role="alert">Some items are no longer available in the selected quantity. Update your bag to continue.</p>` : ""}
      <div class="bag__ctas">
        <a class="btn btn--primary btn--block${hasUnavailable ? " is-disabled" : ""}" href="/checkout" ${hasUnavailable ? 'aria-disabled="true"' : ""}>
          <span>Proceed to Checkout</span>${arrow}
        </a>
        ${
          variant === "drawer"
            ? `<a class="btn btn--ghost" href="/cart">View bag</a><button type="button" class="btn btn--ghost" data-close>Continue shopping</button>`
            : `<a class="btn btn--ghost" href="/shop">Continue shopping</a>`
        }
      </div>
    </div>`;
}

/** Quantity / remove handling, delegated. Keeps keyboard focus on the same control after re-render. */
export function bindBagControls(root) {
  root.addEventListener("click", (e) => {
    const qtyBtn = e.target.closest("[data-qty]");
    const removeBtn = e.target.closest("[data-remove]");
    if (qtyBtn) {
      const { lines } = cartSnapshot();
      const line = lines.find((l) => l.key === qtyBtn.dataset.key);
      if (!line) return;
      const next = line.qty + (qtyBtn.dataset.qty === "inc" ? 1 : -1);
      root.dataset.refocus = `[data-qty="${qtyBtn.dataset.qty}"][data-key="${CSS.escape(line.key)}"]`;
      cart.setQty(line.key, next, line.maxQty);
    } else if (removeBtn) {
      root.dataset.refocus = "";
      cart.remove(removeBtn.dataset.remove);
    } else if (e.target.closest(".is-disabled")) {
      e.preventDefault();
    }
  });
}

export function restoreFocus(root) {
  const sel = root.dataset.refocus;
  delete root.dataset.refocus;
  if (sel === undefined) return;
  const el = sel && root.querySelector(sel);
  // If that control is now disabled (limit reached), stay on the same line.
  const target = el && !el.disabled ? el : el?.closest(".line")?.querySelector("[data-qty]:not(:disabled), [data-remove]");
  (target ?? root.querySelector("[data-qty]:not(:disabled), [data-remove], .btn"))?.focus();
}
