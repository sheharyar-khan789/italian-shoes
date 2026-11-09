/**
 * Checkout. Signed-in customers only. Every number shown after the city is entered comes from the
 * server (quoteCheckout), and placing the order (placeOrder) re-prices everything again on the
 * server, so the browser can't change a price, a delivery charge or a discount.
 * Payment is Cash on Delivery: the order is placed now and paid when it arrives.
 */
import { cart, cartSnapshot, reloadCatalog } from "../app/state.js";
import { CITY_SUGGESTIONS } from "../config.js";
import { esc, formatPKR } from "../lib/format.js";
import { variantIdOf } from "../lib/cart.js";
import { fingerprint, keyFor, clearKey } from "../lib/idempotency.js";
import { totalsBlock } from "../ui/cartView.js";
import { arrow, emptyState, catalogGate } from "../ui/components.js";
import { productMedia } from "../ui/illustration.js";
import { field, showResult, busy } from "../ui/forms.js";
import { navigate } from "../app/router.js";
import { callFn, fnMessage } from "../app/functions.js";
import { loadProfile, listAddresses } from "../app/session.js";
import { requireUser } from "./account.js";
import { placeOrderSchema, fieldErrors } from "../../shared/schemas/index.js";
import { setSeo } from "../lib/seo.js";

const session = () => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
};

/** Form values kept in memory only (never saved in the browser) while the page is open. */
const draft = { name: "", phone: "", city: "", area: "", line1: "", instructions: "", notes: "", coupon: "", terms: false, method: "" };

/** Server errors name fields differently from the form. */
const FIELD_OF = { "customer.name": "name", "customer.phone": "phone", "address.city": "city", "address.area": "area", "address.line1": "line1", "address.name": "name", "address.phone": "phone", deliveryInstructions: "instructions", termsAccepted: "terms", couponCode: "coupon", city: "city" };
const mapFields = (errors = {}) => Object.fromEntries(Object.entries(errors).map(([k, v]) => [FIELD_OF[k] ?? k, v]));

export default async function checkout(ctx) {
  const { outlet } = ctx;
  setSeo({ title: "Checkout", noindex: true });
  outlet.innerHTML = `<div class="page"><p class="muted">Loading…</p></div>`;
  const user = await requireUser();
  if (!user) return;
  if (!(await catalogGate(outlet, () => checkout(ctx)))) return;

  const bagEmpty = `<div class="page page--narrow">${emptyState({ title: "Your bag is empty.", text: "Add a pair before checking out." })}</div>`;
  if (!cartSnapshot().lines.length) {
    outlet.innerHTML = bagEmpty;
    return;
  }

  // Prefill from the account (the customer can change anything).
  const [profile, saved] = await Promise.all([loadProfile().catch(() => null), listAddresses().catch(() => [])]);
  draft.name ||= profile?.name ?? user.name ?? "";
  draft.phone ||= profile?.phone ?? "";
  const home = saved.find((a) => a.isDefault) ?? saved[0];
  if (home && !draft.city) Object.assign(draft, { name: draft.name || home.name, phone: draft.phone || home.phone, city: home.city, area: home.area, line1: home.line1 });

  const F = (name, label, extra = {}) => field({ name, label, value: draft[name], ...extra }, "co");

  outlet.innerHTML = `
  <div class="page checkout">
    <header class="page-head page-head--row">
      <div><p class="kicker"><span class="kicker__line"></span>Step 2 of 3</p><h1 class="page-title">Delivery <em>details</em></h1></div>
      <a class="text-link back-link" href="/cart">← Back to bag</a>
    </header>
    <ol class="steps" aria-label="Checkout progress">
      <li class="is-done"><a href="/cart">Bag</a></li><li aria-current="step">Details &amp; review</li><li>Done</li>
    </ol>

    <form class="checkout__layout" novalidate data-checkout>
      <div class="checkout__form">
        <p class="form-alert form-alert--summary" role="alert" tabindex="-1" data-form-alert hidden></p>
        ${
          saved.length
            ? `<div class="field"><label for="co-saved">Use a saved address</label><select id="co-saved" data-saved><option value="">Choose…</option>${saved.map((a) => `<option value="${esc(a.id)}">${esc(a.label || `${a.area}, ${a.city}`)}</option>`).join("")}</select></div>`
            : ""
        }
        <fieldset class="form-section"><legend>Contact</legend>
          ${F("name", "Full name", { required: true, autocomplete: "name", maxlength: 80 })}
          ${F("phone", "Mobile number", { required: true, type: "tel", inputmode: "tel", autocomplete: "tel", maxlength: 20, hint: "So the courier can reach you, e.g. 0300 1234567" })}
        </fieldset>
        <fieldset class="form-section"><legend>Delivery address</legend>
          ${F("city", "City", { required: true, autocomplete: "address-level2", maxlength: 60 }).replace("<input", '<input list="city-list"')}
          <datalist id="city-list">${CITY_SUGGESTIONS.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
          ${F("area", "Area / locality", { required: true, autocomplete: "address-level3", maxlength: 80 })}
          ${F("line1", "Complete address", { required: true, textarea: true, maxlength: 300, hint: "House / flat, street, nearby landmark" })}
          ${F("instructions", "Delivery instructions", { required: false, textarea: true, maxlength: 300 })}
        </fieldset>
        <fieldset class="form-section"><legend>Delivery option</legend>
          <div data-shipping><p class="muted">Enter your city to see delivery options and charges.</p></div>
          <p class="field-error" id="co-method-error" data-method-error hidden></p>
        </fieldset>
        <fieldset class="form-section"><legend>Payment</legend>
          <p><strong>Cash on Delivery</strong><br><span class="muted">You pay in cash when your order arrives. Nothing is charged now.</span></p>
        </fieldset>
        <fieldset class="form-section"><legend>Anything else?</legend>
          ${F("notes", "Order notes", { required: false, textarea: true, maxlength: 500 })}
        </fieldset>
      </div>

      <aside class="checkout__review" aria-labelledby="review-title">
        <div class="review">
          <div class="review__head"><h2 id="review-title">Order review</h2><a class="text-link" href="/cart">Edit bag</a></div>
          <div data-review></div>
          <div class="field" data-field="coupon">
            <label for="co-coupon">Coupon code <span class="muted">(optional)</span></label>
            <div class="inline-field"><input id="co-coupon" name="coupon" value="${esc(draft.coupon)}" maxlength="40" autocomplete="off" aria-describedby="co-coupon-error" /><button type="button" class="btn btn--ghost" data-apply-coupon>Apply</button></div>
            <p class="field-error" id="co-coupon-error" hidden></p>
          </div>
          <div class="field" data-field="terms">
            <label class="check"><input type="checkbox" name="terms" ${draft.terms ? "checked" : ""} aria-describedby="co-terms-error" /> I agree to the <a class="text-link" href="/terms" target="_blank" rel="noopener noreferrer">terms</a> and the <a class="text-link" href="/returns" target="_blank" rel="noopener noreferrer">returns policy</a>.</label>
            <p class="field-error" id="co-terms-error" hidden></p>
          </div>
          <button type="submit" class="btn btn--primary btn--block" data-submit><span>Place order</span>${arrow}</button>
          <p class="fine">Your order is placed when you press this button. You pay in cash on delivery.</p>
        </div>
      </aside>
    </form>
  </div>`;

  const form = /** @type {HTMLFormElement} */ (outlet.querySelector("[data-checkout]"));
  const $ = (sel) => outlet.querySelector(sel);
  /** @type {any} latest server quote */
  let quote = null;
  let quoting = 0;

  const items = () => cartSnapshot().lines.map((l) => ({ productId: l.productId, variantId: variantIdOf(l), qty: l.qty }));

  function drawReview() {
    const { lines, totals, hasUnavailable } = cartSnapshot();
    const t = quote
      ? { itemCount: totals.itemCount, subtotal: quote.subtotal / 100, discount: quote.discountTotal / 100, tax: quote.taxTotal / 100, delivery: quote.shippingTotal / 100, total: quote.grandTotal / 100 }
      : totals;
    $("[data-review]").innerHTML = `
      <ul class="review__items">${lines
        .map(
          (l) => `<li class="review__item${l.available ? "" : " is-unavailable"}"><span class="review__media">${productMedia(l.product, l.color)}</span>
          <span class="review__info"><span class="review__name">${esc(l.product.name)}</span><span class="muted">${esc(l.color.name)} · Size ${esc(l.sizeLabel)}</span><span class="muted">${l.qty} × ${formatPKR(l.unitPrice)}</span></span>
          <span class="review__total">${formatPKR(l.lineTotal)}</span></li>`,
        )
        .join("")}</ul>
      ${totalsBlock(t)}
      ${quote ? `<p class="fine">These amounts are calculated by the store's server.</p>` : `<p class="fine">Enter your city to see the delivery charge and your total.</p>`}
      ${hasUnavailable ? `<p class="form-alert" role="alert">Some items are no longer available in the selected quantity. <a href="/cart">Update your bag</a> to continue.</p>` : ""}`;
  }

  const setFieldError = (name, msg) => {
    const wrap = form.querySelector(`[data-field="${name}"]`);
    const err = wrap?.querySelector(".field-error");
    if (!err) return;
    err.textContent = msg ?? "";
    err.hidden = !msg;
    wrap.classList.toggle("has-error", Boolean(msg));
  };

  function drawShipping() {
    const box = $("[data-shipping]");
    if (!quote) return;
    box.innerHTML = quote.shippingOptions
      .map(
        (o) => `<label class="check"><input type="radio" name="method" value="${esc(o.id)}" ${o.id === draft.method ? "checked" : ""} />
        <span><strong>${esc(o.name)}</strong> — ${o.charge ? formatPKR(o.charge / 100) : "Free"}${o.estimateText ? `<br><span class="muted">${esc(o.estimateText)}</span>` : ""}</span></label>`,
      )
      .join("");
  }

  /** Ask the server for exact totals for the current bag, city, delivery option and coupon. */
  async function refreshQuote() {
    const city = draft.city.trim();
    if (city.length < 2 || !items().length) return;
    const mine = ++quoting;
    try {
      const q = await callFn("quoteCheckout", { items: items(), city, ...(draft.method ? { shippingMethodId: draft.method } : {}), ...(draft.coupon.trim() ? { couponCode: draft.coupon.trim() } : {}) });
      if (mine !== quoting) return; // a newer request is on its way
      quote = q;
      draft.method = q.selectedShippingMethodId;
      setFieldError("city", null);
      setFieldError("coupon", null);
      drawShipping();
    } catch (error) {
      if (mine !== quoting) return;
      const e = /** @type {any} */ (error);
      quote = null;
      const fields = mapFields(e?.details?.fields);
      // A bad coupon shouldn't hide the totals: drop it and quote again without it.
      if (fields.coupon) {
        setFieldError("coupon", fnMessage(error));
        draft.coupon = "";
        return refreshQuote();
      }
      if (fields.city) setFieldError("city", fnMessage(error));
      $("[data-shipping]").innerHTML = `<p class="muted">${esc(fnMessage(error, "Delivery options couldn't be loaded. Please try again."))}</p>`;
    }
    drawReview();
  }

  const debounce = (fn, ms = 450) => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };
  const quoteSoon = debounce(async () => {
    await refreshQuote();
    drawReview();
  });

  form.addEventListener("input", (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (!(t.name in draft)) return;
    draft[t.name] = t.type === "checkbox" ? t.checked : t.value;
    if (t.name === "city") {
      quote = null;
      quoteSoon();
    }
  });
  form.addEventListener("change", (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.name === "method") {
      draft.method = t.value;
      refreshQuote().then(drawReview);
    }
    if (t.matches("[data-saved]")) {
      const a = saved.find((x) => x.id === t.value);
      if (!a) return;
      Object.assign(draft, { name: a.name, phone: a.phone, city: a.city, area: a.area, line1: a.line1 });
      for (const k of ["name", "phone", "city", "area", "line1"]) /** @type {HTMLInputElement} */ (form.elements[k]).value = draft[k];
      quote = null;
      refreshQuote().then(drawReview);
    }
  });
  $("[data-apply-coupon]").addEventListener("click", async () => {
    draft.coupon = /** @type {HTMLInputElement} */ ($("#co-coupon")).value.trim();
    if (!draft.city.trim()) return setFieldError("coupon", "Enter your city first, so the total can be worked out.");
    await refreshQuote();
    drawReview();
    if (quote?.couponCode) setFieldError("coupon", null);
  });

  let placing = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (placing) return;
    const alert = /** @type {HTMLElement} */ ($("[data-form-alert]"));
    const fail = (message, fields = {}) => showResult(form, { ok: false, message, fields });
    const { hasUnavailable, lines } = cartSnapshot();
    if (!lines.length) {
      outlet.innerHTML = bagEmpty;
      return;
    }
    if (hasUnavailable) return fail("Some items in your bag are no longer available in the selected quantity. Please update your bag first.");
    if (!quote) {
      await refreshQuote();
      drawReview();
      if (!quote) return fail("Please enter a city we deliver to, so we can work out your delivery and total.", { city: "Please check your city" });
    }

    const payload = {
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
      items: items(),
      customer: { name: draft.name, phone: draft.phone, ...(user.email ? { email: user.email } : {}) },
      address: { name: draft.name, phone: draft.phone, city: draft.city, area: draft.area, line1: draft.line1 },
      shippingMethodId: draft.method,
      ...(quote.couponCode ? { couponCode: quote.couponCode } : {}),
      paymentMethod: "cod",
      deliveryInstructions: draft.instructions,
      notes: draft.notes,
      termsAccepted: draft.terms,
    };
    const parsed = placeOrderSchema.safeParse(payload);
    if (!parsed.success) {
      const fields = mapFields(fieldErrors(parsed.error));
      return fail("Please check the highlighted fields.", fields);
    }
    placing = true;
    const key = keyFor(session(), fingerprint(parsed.data));
    const result = await busy(
      form,
      async () => {
        try {
          return { ok: true, order: await callFn("placeOrder", { ...parsed.data, idempotencyKey: key }) };
        } catch (error) {
          const e = /** @type {any} */ (error);
          return { ok: false, message: fnMessage(error, "We couldn't place your order. Nothing was charged. Please try again."), fields: mapFields(e?.details?.fields) };
        }
      },
      "Placing your order…",
    );
    placing = false;
    if (!result.ok) {
      showResult(form, result);
      alert.focus();
      // Stock or prices may have changed: refresh what the bag shows.
      await reloadCatalog();
      quote = null;
      refreshQuote().then(drawReview);
      return;
    }
    clearKey(session());
    Object.assign(draft, { notes: "", instructions: "", coupon: "", terms: false, method: "" });
    cart.clear();
    navigate(`/order/${result.order.orderId}`, { replace: true });
  });

  const unsub = cart.subscribe(() => {
    if (!cartSnapshot().lines.length) {
      outlet.innerHTML = bagEmpty;
      return;
    }
    quote = null;
    refreshQuote().then(drawReview);
    drawReview();
  });

  drawReview();
  if (draft.city) refreshQuote().then(drawReview);
  return unsub;
}
