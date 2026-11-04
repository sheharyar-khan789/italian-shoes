import { catalogReady, cart, cartSnapshot } from "../app/state.js";
import { STORE, CITY_SUGGESTIONS } from "../config.js";
import { esc, formatPKR } from "../lib/format.js";
import { validateCheckout, buildOrderMessage, buildWhatsAppUrl, createOrderRef, normalizeWhatsAppNumber } from "../lib/order.js";
import { totalsBlock } from "../ui/cartView.js";
import { arrow, emptyState } from "../ui/components.js";
import { productMedia } from "../ui/illustration.js";
import { toast } from "../ui/layout.js";

/*
 * Checkout details live only in memory for this browsing session (never in localStorage), so going
 * Back to Cart and returning keeps what the customer typed without persisting personal data.
 */
const draft = { name: "", phone: "", whatsapp: "", city: "", area: "", address: "", instructions: "", notes: "" };
let orderRef = null; // one reference per checkout attempt, reused if WhatsApp is reopened

const FIELDS = [
  { name: "name", label: "Full name", autocomplete: "name", required: true, group: "contact" },
  { name: "phone", label: "Contact phone", autocomplete: "tel", inputmode: "tel", type: "tel", required: true, hint: "Pakistani mobile, e.g. 0300 1234567", group: "contact" },
  { name: "whatsapp", label: "WhatsApp number", autocomplete: "off", inputmode: "tel", type: "tel", hint: "Only if different from your contact phone", group: "contact" },
  { name: "city", label: "City", autocomplete: "address-level2", required: true, list: "city-list", group: "delivery" },
  { name: "area", label: "Area / locality", autocomplete: "address-level3", required: true, hint: "e.g. Gulberg III, DHA Phase 6", group: "delivery" },
  { name: "address", label: "Complete address", autocomplete: "street-address", required: true, textarea: true, hint: "House / flat, street, nearby landmark", group: "delivery" },
  { name: "instructions", label: "Delivery instructions", textarea: true, rows: 2, group: "delivery" },
  { name: "notes", label: "Order notes", textarea: true, rows: 2, group: "notes" },
];

const field = (f) => {
  const id = `co-${f.name}`;
  const describedBy = [f.hint && `${id}-hint`, `${id}-error`].filter(Boolean).join(" ");
  const common = `id="${id}" name="${f.name}" ${f.required ? 'required aria-required="true"' : ""} autocomplete="${f.autocomplete ?? "off"}" aria-describedby="${describedBy}"`;
  const control = f.textarea
    ? `<textarea ${common} rows="${f.rows ?? 3}" maxlength="${f.name === "notes" ? 500 : 300}">${esc(draft[f.name])}</textarea>`
    : `<input ${common} type="${f.type ?? "text"}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ""} ${f.list ? `list="${f.list}"` : ""} value="${esc(draft[f.name])}" maxlength="${f.type === "tel" ? 20 : 80}" />`;
  return `
  <div class="field" data-field="${f.name}">
    <label for="${id}">${f.label}${f.required ? "" : ` <span class="muted">(optional)</span>`}</label>
    ${f.hint ? `<p class="field-hint" id="${id}-hint">${f.hint}</p>` : ""}
    ${control}
    <p class="field-error" id="${id}-error" hidden></p>
  </div>`;
};

function reviewHtml() {
  const { lines, totals, hasUnavailable } = cartSnapshot();
  return `
    <ul class="review__items">
      ${lines
        .map(
          (l) => `
        <li class="review__item${l.available ? "" : " is-unavailable"}">
          <span class="review__media">${productMedia(l.product, l.color)}</span>
          <span class="review__info">
            <span class="review__name">${esc(l.product.name)}</span>
            <span class="muted">${esc(l.color.name)} · EU ${l.size}</span>
            <span class="muted">${l.qty} × ${formatPKR(l.unitPrice)}</span>
          </span>
          <span class="review__total">${formatPKR(l.lineTotal)}</span>
        </li>`,
        )
        .join("")}
    </ul>
    ${totalsBlock(totals, { final: true })}
    ${totals.delivery === null ? `<p class="fine">Delivery charges are not yet confirmed. The store will confirm them — and your final total — on WhatsApp.</p>` : ""}
    ${hasUnavailable ? `<p class="form-alert" role="alert">Some items are no longer available in the selected quantity. <a href="/cart">Update your bag</a> to continue.</p>` : ""}`;
}

export default async function checkout({ outlet }) {
  document.title = "Checkout";
  await catalogReady;

  if (!cartSnapshot().lines.length) {
    outlet.innerHTML = `<div class="page page--narrow">${emptyState({ title: "Your bag is empty.", text: "Add a pair before checking out." })}</div>`;
    return;
  }

  const waConfigured = !!normalizeWhatsAppNumber(STORE.whatsappNumber);

  outlet.innerHTML = `
  <div class="page checkout">
    <header class="page-head page-head--row">
      <div>
        <p class="kicker"><span class="kicker__line"></span>Step 2 of 3</p>
        <h1 class="page-title">Delivery <em>details</em></h1>
      </div>
      <a class="text-link back-link" href="/cart">← Back to bag</a>
    </header>

    <ol class="steps" aria-label="Checkout progress">
      <li class="is-done"><a href="/cart">Bag</a></li>
      <li aria-current="step">Details &amp; review</li>
      <li>Send on WhatsApp</li>
    </ol>

    ${
      waConfigured
        ? ""
        : `<div class="notice" role="note">
            <strong>WhatsApp ordering isn’t set up yet.</strong>
            The store’s WhatsApp number hasn’t been added, so orders can’t be sent from this site yet.
            You can still fill in your details and preview the exact order message.
          </div>`
    }

    <form class="checkout__layout" novalidate data-checkout>
      <div class="checkout__form">
        <div class="form-alert form-alert--summary" role="alert" tabindex="-1" data-error-summary hidden></div>

        <fieldset class="form-section">
          <legend>Contact</legend>
          ${FIELDS.filter((f) => f.group === "contact").map(field).join("")}
        </fieldset>
        <fieldset class="form-section">
          <legend>Delivery address</legend>
          ${FIELDS.filter((f) => f.group === "delivery").map(field).join("")}
          <datalist id="city-list">${CITY_SUGGESTIONS.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
        </fieldset>
        <fieldset class="form-section">
          <legend>Anything else?</legend>
          ${FIELDS.filter((f) => f.group === "notes").map(field).join("")}
        </fieldset>
        <p class="fine">Your details are used only to compose your WhatsApp order message. This website does not store them.</p>
      </div>

      <aside class="checkout__review" aria-labelledby="review-title">
        <div class="review">
          <div class="review__head">
            <h2 id="review-title">Order review</h2>
            <a class="text-link" href="/cart">Edit bag</a>
          </div>
          <div data-review>${reviewHtml()}</div>
          <button type="submit" class="btn btn--primary btn--block btn--wa" data-submit>
            <span>${waConfigured ? "Place Order on WhatsApp" : "Preview Order Message"}</span>${arrow}
          </button>
          <p class="fine">${
            waConfigured
              ? "WhatsApp opens with your order ready to send. Your order is placed only when you press Send in WhatsApp."
              : "Ordering will be enabled once the store adds its WhatsApp number."
          }</p>
          <div data-result></div>
        </div>
      </aside>
    </form>
  </div>`;

  const form = outlet.querySelector("[data-checkout]");
  const summary = outlet.querySelector("[data-error-summary]");
  const result = outlet.querySelector("[data-result]");
  const submitBtn = outlet.querySelector("[data-submit]");
  let showErrors = false;
  let busy = false;

  const paintErrors = (errors) => {
    for (const f of FIELDS) {
      const wrap = form.querySelector(`[data-field="${f.name}"]`);
      const input = wrap.querySelector("input, textarea");
      const err = wrap.querySelector(".field-error");
      const msg = errors[f.name];
      input.toggleAttribute("aria-invalid", !!msg);
      if (msg) input.setAttribute("aria-invalid", "true");
      err.textContent = msg ?? "";
      err.hidden = !msg;
      wrap.classList.toggle("has-error", !!msg);
    }
  };

  form.addEventListener("input", (e) => {
    if (!(e.target.name in draft)) return;
    draft[e.target.name] = e.target.value;
    clearResult(); // the generated message no longer matches the form
    if (showErrors) {
      const errors = validateCheckout(draft);
      paintErrors(errors);
      if (!Object.keys(errors).length) summary.hidden = true;
    }
  });

  const emptyHtml = `<div class="page page--narrow">${emptyState({ title: "Your bag is empty.", text: "Add a pair before checking out." })}</div>`;
  function clearResult() {
    if (busy || !result.firstChild) return;
    result.replaceChildren();
    submitBtn.querySelector("span").textContent = waConfigured ? "Place Order on WhatsApp" : "Preview Order Message";
  }

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Order message copied");
    } catch {
      const ta = result.querySelector("textarea");
      ta?.select();
      toast("Select the message and copy it manually");
    }
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return;

    const { lines, totals, hasUnavailable } = cartSnapshot();
    if (!lines.length) {
      outlet.innerHTML = emptyHtml;
      return;
    }
    if (hasUnavailable) {
      summary.innerHTML = `Some items in your bag are no longer available in the selected quantity. <a href="/cart">Update your bag</a> first.`;
      summary.hidden = false;
      summary.focus();
      return;
    }

    const errors = validateCheckout(draft);
    showErrors = true;
    paintErrors(errors);
    const keys = Object.keys(errors);
    if (keys.length) {
      summary.innerHTML = `<p>Please check ${keys.length === 1 ? "this field" : `these ${keys.length} fields`}:</p><ul>${keys
        .map((k) => `<li><a href="#co-${k}">${esc(FIELDS.find((f) => f.name === k).label)}</a> — ${esc(errors[k])}</li>`)
        .join("")}</ul>`;
      summary.hidden = false;
      summary.focus();
      return;
    }
    summary.hidden = true;

    orderRef ??= createOrderRef();
    const message = buildOrderMessage({
      ref: orderRef,
      form: draft,
      items: lines.map((l) => ({ name: l.product.name, id: l.product.id, size: l.size, color: l.color.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
      totals,
    });
    const url = buildWhatsAppUrl(STORE.whatsappNumber, message);

    const messageBlock = `
      <details class="msg"${url ? "" : " open"}>
        <summary>View order message</summary>
        <label class="visually-hidden" for="wa-message">Order message</label>
        <textarea id="wa-message" class="msg__text" readonly rows="12">${esc(message)}</textarea>
        <button type="button" class="text-btn" data-copy>Copy message</button>
      </details>`;

    if (!url) {
      result.innerHTML = `
        <div class="result" tabindex="-1">
          <p class="result__title">Order message preview</p>
          <p>Reference <strong>${esc(orderRef)}</strong>. This is exactly what will be sent to the store once its WhatsApp number is configured. <strong>Nothing has been sent.</strong></p>
          ${messageBlock}
        </div>`;
    } else {
      busy = true;
      submitBtn.disabled = true;
      submitBtn.querySelector("span").textContent = "Opening WhatsApp…";
      const win = window.open(url, "_blank");
      if (win) win.opener = null;
      setTimeout(() => {
        busy = false;
        submitBtn.disabled = false;
        submitBtn.querySelector("span").textContent = "Open WhatsApp again";
      }, 2500);

      result.innerHTML = `
        <div class="result" tabindex="-1">
          <p class="result__title">One last step — send it in WhatsApp</p>
          <p>WhatsApp ${win ? "has opened" : "should open"} with your order <strong>${esc(orderRef)}</strong> ready to send.
             <strong>Your order isn’t placed until you press Send in WhatsApp.</strong>
             The store will reply to confirm availability, delivery charges and acceptance.</p>
          <p>WhatsApp didn’t open? <a class="text-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open WhatsApp</a>, or copy the message below and send it to the store yourself.</p>
          ${messageBlock}
          <p class="result__done">Already sent it? <button type="button" class="text-btn" data-sent>Empty my bag</button></p>
        </div>`;
    }
    result.querySelector(".result").focus();
  });

  result.addEventListener("click", (e) => {
    if (e.target.closest("[data-copy]")) copy(result.querySelector("textarea").value);
    if (e.target.closest("[data-sent]")) {
      if (!window.confirm("Empty your bag? Only do this after you’ve sent the order message in WhatsApp.")) return;
      const ref = orderRef;
      orderRef = null;
      Object.keys(draft).forEach((k) => (draft[k] = ""));
      unsub();
      cart.clear();
      outlet.innerHTML = `
        <div class="page page--narrow">
          <div class="empty">
            <p class="kicker"><span class="kicker__line"></span>Step 3 of 3</p>
            <p class="empty__title">Thank you.</p>
            <p class="empty__text">If you sent your WhatsApp message, the store will reply there to confirm your order${ref ? ` (reference ${esc(ref)})` : ""}, availability and delivery charges.</p>
            <a class="btn btn--primary" href="/shop"><span>Continue shopping</span>${arrow}</a>
          </div>
        </div>`;
      outlet.focus();
    }
  });

  // Keep the review in sync if the bag changes (e.g. in another tab).
  const unsub = cart.subscribe(() => {
    if (!cartSnapshot().lines.length) {
      outlet.innerHTML = emptyHtml;
      return;
    }
    outlet.querySelector("[data-review]").innerHTML = reviewHtml();
    clearResult();
  });
  return unsub;
}
