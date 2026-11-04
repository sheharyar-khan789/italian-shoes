import { catalogReady, getCatalog, productBySlug, categoryById, cart, trackView, recentProducts } from "../app/state.js";
import { normalizeWhatsAppNumber } from "../lib/order.js";
import { esc, formatPKR } from "../lib/format.js";
import { maxQtyFor } from "../lib/cart.js";
import { colorInStock } from "../lib/shop.js";
import { productMedia } from "../ui/illustration.js";
import { colorOptions, sizeOptions, stockText, grid, bindCardSwatches, arrow, emptyState, priceTag } from "../ui/components.js";

/** General care guidance chosen from the product's material words. Not a store policy. */
function careTips(product) {
  const text = `${product.description} ${product.details.join(" ")}`.toLowerCase();
  if (text.includes("suede"))
    return ["Brush gently with a soft suede brush to lift the nap.", "Keep away from rain; let damp suede dry naturally, away from direct heat.", "Use a suede protector spray before first wear."];
  if (/knit|mesh|canvas/.test(text))
    return ["Wipe with a damp cloth and mild soap; avoid the washing machine.", "Air-dry at room temperature, stuffed with paper to keep the shape.", "Clean the sole edges with a soft brush."];
  return ["Wipe off dust with a soft, dry cloth after wear.", "Polish regularly with a matching cream or wax.", "Use shoe trees or paper to hold the shape, and let pairs rest between wears."];
}

/** "Ask a question": WhatsApp when the store number is set, otherwise a phone call. */
function askLink(product) {
  const wa = normalizeWhatsAppNumber(STORE.whatsappNumber);
  if (wa) {
    const text = `Hi, I have a question about ${product.name} (${product.id}).`;
    return `<a class="ask" href="https://wa.me/${wa}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Ask a question on WhatsApp</a>`;
  }
  const phone = STORE.contact.phone;
  if (!phone) return "";
  return `<a class="ask" href="tel:+92${esc(phone.replace(/\D/g, "").replace(/^0/, ""))}">Ask a question — call ${esc(phone)}</a>`;
}
import { addToBag, openCart, openSheet } from "../ui/layout.js";
import { sizeGuideTable } from "./pages.js";
import { STORE } from "../config.js";

export default async function productView({ outlet, params, query }) {
  await catalogReady;
  const product = productBySlug(params[0]);
  if (!product) {
    document.title = "Product not found";
    outlet.innerHTML = `<div class="page">${emptyState({ title: "We couldn’t find that product.", text: "It may have been removed from the collection." })}</div>`;
    return;
  }
  const category = categoryById(product.category);
  document.title = `${product.name} — ${category?.name ?? "Footwear"}`;

  const state = {
    color: product.colors.find((c) => c.id === query.get("color")) ?? product.colors.find(colorInStock) ?? product.colors[0],
    size: null,
    qty: 1,
    image: 0,
  };
  const views = Math.max(3, state.color.images?.length ?? 0);
  const viewLabels = ["Side profile", "Opposite side", "Detail"];

  outlet.innerHTML = `
  <div class="page pdp">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/shop">Shop</a><span aria-hidden="true">/</span>
      <a href="/shop/${product.category}">${esc(category?.name ?? "")}</a><span aria-hidden="true">/</span>
      <span aria-current="page">${esc(product.name)}</span>
    </nav>

    <div class="pdp__layout">
      <section class="gallery" aria-label="Product images">
        <div class="gallery__main" data-gallery-main></div>
        <div class="gallery__thumbs" role="group" aria-label="Choose image" data-gallery-thumbs></div>
        ${state.color.images?.length ? "" : `<p class="fine gallery__note">Illustration shown — product photography to be supplied.</p>`}
      </section>

      <section class="buy" aria-labelledby="pdp-title">
        <p class="kicker"><span class="kicker__line"></span>${esc(category?.name ?? "")}</p>
        <h1 class="pdp__title" id="pdp-title">${esc(product.name)}</h1>
        <p class="pdp__price">${priceTag(product)}</p>
        <p class="pdp__id muted">Product ID ${esc(product.id)}</p>

        <form class="buy__form" data-buy novalidate>
          <fieldset class="field-set">
            <legend>Colour <span class="muted" data-color-name>— ${esc(state.color.name)}</span></legend>
            <div class="color-opts">${colorOptions(product, state.color.id)}</div>
          </fieldset>

          <fieldset class="field-set" aria-describedby="size-error">
            <legend class="legend-row">
              <span>Size <span class="muted">(EU)</span></span>
              <button type="button" class="text-btn" data-size-guide>Size guide</button>
            </legend>
            <div class="size-opts" data-sizes>${sizeOptions(product, state.color, state.size)}</div>
            <p class="field-error" id="size-error" data-size-error hidden></p>
          </fieldset>

          <p class="stock" data-stock></p>

          <div class="buy__row">
            <div class="stepper stepper--lg" role="group" aria-label="Quantity">
              <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
              <output data-qty aria-live="polite">1</output>
              <button type="button" data-step="1" aria-label="Increase quantity">+</button>
            </div>
            <button type="submit" class="btn btn--primary buy__add"><span>Add to Bag</span>${arrow}</button>
          </div>
          <p class="fine" data-in-bag></p>
        </form>

        <div class="pdp__desc">
          <p>${esc(product.description)}</p>
          <ul>${product.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
        </div>

        <details class="accordion">
          <summary>Care instructions</summary>
          <ul class="care">${careTips(product).map((t) => `<li>${t}</li>`).join("")}</ul>
        </details>
        <details class="accordion">
          <summary>Delivery</summary>
          <p>${STORE.deliveryFee === null ? "Delivery charges and timelines are confirmed by the store on WhatsApp when you place your order." : `Delivery: ${formatPKR(STORE.deliveryFee)}.`} <a class="text-link" href="/shipping">Shipping &amp; delivery</a></p>
        </details>
        <details class="accordion">
          <summary>Exchanges &amp; returns</summary>
          <p>${STORE.policiesConfirmed ? "" : "The store’s exchange policy is to be confirmed. "}<a class="text-link" href="/returns">Returns &amp; exchanges</a></p>
        </details>
        ${askLink(product)}
      </section>
    </div>

    <section class="section related" aria-labelledby="related-title">
      <header class="section__head"><h2 class="section__title" id="related-title">You may <em>also like</em></h2></header>
      <div data-related></div>
    </section>

    <section class="section related" aria-labelledby="recent-title" data-recent-section hidden>
      <header class="section__head"><h2 class="section__title" id="recent-title">Recently <em>viewed</em></h2></header>
      <div data-recent></div>
    </section>
  </div>`;

  const $ = (sel) => outlet.querySelector(sel);
  const form = $("[data-buy]");

  const renderGallery = () => {
    const count = Math.max(views, state.color.images?.length ?? 0);
    const main = $("[data-gallery-main]");
    main.innerHTML = productMedia(product, state.color, { index: state.image, eager: true, label: `${product.name} in ${state.color.name} — ${viewLabels[state.image] ?? `view ${state.image + 1}`}` });
    main.dataset.view = state.image;
    $("[data-gallery-thumbs]").innerHTML = Array.from(
      { length: count },
      (_, i) => `<button type="button" class="thumb" data-view="${i}" aria-pressed="${i === state.image}" aria-label="${viewLabels[i] ?? `View ${i + 1}`}">
        ${productMedia(product, state.color, { index: i, label: "" })}</button>`,
    ).join("");
  };

  const maxQty = () => (state.size == null ? 10 : maxQtyFor(state.color, state.size));

  const renderStock = () => {
    const s = stockText(state.color, state.size);
    const el = $("[data-stock]");
    el.className = `stock stock--${s.tone}`;
    el.textContent = s.text;
    state.qty = Math.min(state.qty, Math.max(1, maxQty()));
    $("[data-qty]").textContent = state.qty;
    $('[data-step="-1"]').disabled = state.qty <= 1;
    $('[data-step="1"]').disabled = state.qty >= maxQty();
    const inBag = cart
      .get()
      .filter((l) => l.productId === product.id)
      .reduce((n, l) => n + l.qty, 0);
    $("[data-in-bag]").textContent = inBag ? `${inBag} in your bag.` : "";
  };

  const renderSizes = () => {
    $("[data-sizes]").innerHTML = sizeOptions(product, state.color, state.size);
  };

  form.addEventListener("change", (e) => {
    if (e.target.name === "color") {
      state.color = product.colors.find((c) => c.id === e.target.value);
      if (state.size != null && maxQtyFor(state.color, state.size) < 1) state.size = null;
      $("[data-color-name]").textContent = `— ${state.color.name}`;
      history.replaceState(history.state, "", `/product/${product.slug}?color=${state.color.id}`);
      renderSizes();
      renderGallery();
    }
    if (e.target.name === "size") {
      state.size = Number(e.target.value);
      $("[data-size-error]").hidden = true;
    }
    renderStock();
  });

  form.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step) {
      state.qty = Math.min(Math.max(1, state.qty + Number(step.dataset.step)), Math.max(1, maxQty()));
      renderStock();
    }
    if (e.target.closest("[data-size-guide]")) openSheet("Size guide", sizeGuideTable(product.sizes));
  });

  let adding = false;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (adding) return;
    const result = addToBag(product, state.color.id, state.size, state.qty);
    if (!result.ok) {
      const err = $("[data-size-error]");
      err.textContent = result.error;
      err.hidden = false;
      (form.querySelector('input[name="size"]:not(:disabled)') ?? form.querySelector(".buy__add")).focus();
      return;
    }
    // Brief guard against an accidental double-click adding twice.
    adding = true;
    const addBtn = form.querySelector(".buy__add");
    addBtn.disabled = true;
    setTimeout(() => {
      adding = false;
      addBtn.disabled = false;
    }, 600);
    state.qty = 1;
    renderStock();
    openCart();
  });

  outlet.querySelector(".gallery").addEventListener("click", (e) => {
    const t = e.target.closest("[data-view]");
    if (!t) return;
    state.image = Number(t.dataset.view);
    renderGallery();
    outlet.querySelector(`[data-view="${state.image}"]`)?.focus();
  });

  const unsub = cart.subscribe(renderStock);

  const { products } = getCatalog();
  const related = products
    .filter((p) => p.id !== product.id)
    .sort((a, b) => Number(b.category === product.category) - Number(a.category === product.category) || Math.abs(a.price - product.price) - Math.abs(b.price - product.price))
    .slice(0, 4);
  $("[data-related]").innerHTML = grid(related);
  bindCardSwatches($("[data-related]"), products);

  const recent = recentProducts(product.slug).slice(0, 4);
  if (recent.length) {
    $("[data-recent]").innerHTML = grid(recent);
    bindCardSwatches($("[data-recent]"), products);
    $("[data-recent-section]").hidden = false;
  }
  trackView(product.slug);

  renderGallery();
  renderStock();
  return unsub;
}
