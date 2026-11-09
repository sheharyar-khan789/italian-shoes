import { getCatalog, getSettings, productBySlug, categoryById, cart, trackView, recentProducts } from "../app/state.js";
import { esc } from "../lib/format.js";
import { maxQtyFor } from "../lib/cart.js";
import { colorInStock } from "../lib/shop.js";
import { productMedia } from "../ui/illustration.js";
import { colorOptions, sizeOptions, stockText, grid, bindCardSwatches, arrow, emptyState, priceTag, catalogGate } from "../ui/components.js";
import { addToBag, openCart, openSheet } from "../ui/layout.js";
import { sizeGuideTable, paragraphs } from "./pages.js";
import { currentUser, whenReady } from "../app/session.js";
import { navigate } from "../app/router.js";
import { loadReviews, submitReview, loadWishlist, toggleWishlist } from "../data/store.js";
import { setSeo, snippet } from "../lib/seo.js";

const STARS = (n) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

/** Questions go to the store's phone number once the owner has saved it. */
function askLink() {
  const phone = getSettings().phone ?? "";
  const digits = phone.replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");
  return digits ? `<a class="ask" href="tel:+92${digits}">Ask a question — call ${esc(phone)}</a>` : "";
}

export default async function productView(ctx) {
  const { outlet, params, query } = ctx;
  outlet.innerHTML = `<div class="page"><p class="muted">Loading…</p></div>`;
  if (!(await catalogGate(outlet, () => productView(ctx)))) return;
  const product = productBySlug(params[0]);
  if (!product) {
    setSeo({ title: "Product not found", noindex: true });
    outlet.innerHTML = `<div class="page">${emptyState({ title: "We couldn’t find that product.", text: "It may have been removed from the collection." })}</div>`;
    return;
  }
  const category = categoryById(product.category);
  const settings = getSettings();

  const state = {
    color: product.colors.find((c) => c.id === query.get("color")) ?? product.colors.find(colorInStock) ?? product.colors[0],
    size: null,
    qty: 1,
    image: 0,
  };

  setSeo({
    title: product.seoTitle || `${product.name}${category ? ` — ${category.name}` : ""}`,
    description: product.seoDescription || snippet(product.description) || `${product.name} at ${settings.storeName ?? "our store"}.`,
    image: state.color.images?.[0] ?? "",
    path: `/product/${product.slug}`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.name,
      description: snippet(product.description, 300) || undefined,
      image: state.color.images?.slice(0, 4),
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "PKR",
        lowPrice: product.price,
        highPrice: product.priceMax || product.price,
        availability: product.colors.some(colorInStock) ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      },
      ...(product.rating ? { aggregateRating: { "@type": "AggregateRating", ratingValue: product.rating.avg, reviewCount: product.rating.count } } : {}),
    },
  });

  const viewLabels = ["Side profile", "Opposite side", "Detail"];

  outlet.innerHTML = `
  <div class="page pdp">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/shop">Shop</a><span aria-hidden="true">/</span>
      ${category ? `<a href="/shop/${esc(category.slug)}">${esc(category.name)}</a><span aria-hidden="true">/</span>` : ""}
      <span aria-current="page">${esc(product.name)}</span>
    </nav>

    <div class="pdp__layout">
      <section class="gallery" aria-label="Product images">
        <div class="gallery__main" data-gallery-main></div>
        <div class="gallery__thumbs" role="group" aria-label="Choose image" data-gallery-thumbs></div>
      </section>

      <section class="buy" aria-labelledby="pdp-title">
        <p class="kicker"><span class="kicker__line"></span>${esc(category?.name ?? "")}</p>
        <h1 class="pdp__title" id="pdp-title">${esc(product.name)}</h1>
        ${product.rating ? `<p class="pdp__rating"><a href="#reviews" aria-label="${product.rating.avg} out of 5, ${product.rating.count} reviews"><span aria-hidden="true">${STARS(product.rating.avg)}</span> ${product.rating.avg} (${product.rating.count})</a></p>` : ""}
        <p class="pdp__price" data-price>${priceTag(product)}</p>

        <form class="buy__form" data-buy novalidate>
          <fieldset class="field-set">
            <legend>Colour <span class="muted" data-color-name>— ${esc(state.color.name)}</span></legend>
            <div class="color-opts">${colorOptions(product, state.color.id)}</div>
          </fieldset>

          <fieldset class="field-set" aria-describedby="size-error">
            <legend class="legend-row">
              <span>Size</span>
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
          <button type="button" class="text-btn" data-wish aria-pressed="false">♡ Save to wishlist</button>
          <p class="fine" data-wish-msg role="status"></p>
        </form>

        ${product.description ? `<div class="pdp__desc">${paragraphs(product.description)}</div>` : ""}

        <details class="accordion">
          <summary>Delivery</summary>
          <p>Delivery charges depend on your city and are shown before you place your order. You pay in cash when it arrives. <a class="text-link" href="/shipping">Shipping &amp; delivery</a></p>
        </details>
        <details class="accordion">
          <summary>Exchanges &amp; returns</summary>
          <p><a class="text-link" href="/returns">Returns &amp; exchanges</a></p>
        </details>
        ${askLink()}
      </section>
    </div>

    <section class="section reviews" id="reviews" aria-labelledby="reviews-title">
      <header class="section__head"><h2 class="section__title" id="reviews-title">Customer <em>reviews</em></h2></header>
      <div data-reviews><p class="muted">Loading…</p></div>
    </section>

    <section class="section related" aria-labelledby="related-title" data-related-section>
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
    const images = state.color.images ?? [];
    const main = $("[data-gallery-main]");
    main.innerHTML = productMedia(product, state.color, { index: state.image, eager: true, label: `${product.name} in ${state.color.name} — ${viewLabels[state.image] ?? `view ${state.image + 1}`}` });
    main.dataset.view = state.image;
    $("[data-gallery-thumbs]").innerHTML =
      images.length > 1
        ? images
            .map(
              (_, i) => `<button type="button" class="thumb" data-view="${i}" aria-pressed="${i === state.image}" aria-label="${viewLabels[i] ?? `View ${i + 1}`}">
          ${productMedia(product, state.color, { index: i, label: "" })}</button>`,
            )
            .join("")
        : "";
  };

  const maxQty = () => (state.size == null ? 10 : maxQtyFor(state.color, state.size));

  /** The price of the chosen colour + size (variants can differ), else the "from" price. */
  const renderPrice = () => {
    const unit = state.size != null ? state.color.prices?.[state.size] : null;
    if (unit == null) {
      $("[data-price]").innerHTML = priceTag(product);
      return;
    }
    const regular = state.color.regularPrices?.[state.size] ?? unit;
    $("[data-price]").innerHTML = priceTag({ price: unit, priceMax: unit, compareAt: regular > unit ? regular : null });
  };

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
    renderPrice();
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
      state.size = e.target.value;
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
    if (e.target.closest("[data-size-guide]")) openSheet("Size guide", sizeGuideTable(product.sizes.map((s) => s.label)));
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

  /* ───────── Wishlist ───────── */

  let wished = false;
  const wishBtn = $("[data-wish]");
  const paintWish = () => {
    wishBtn.textContent = wished ? "♥ Saved to wishlist" : "♡ Save to wishlist";
    wishBtn.setAttribute("aria-pressed", String(wished));
  };
  whenReady()
    .then(async () => {
      const user = currentUser();
      if (user) wished = (await loadWishlist(user.uid)).includes(product.id);
      paintWish();
    })
    .catch(paintWish);
  wishBtn.addEventListener("click", async () => {
    const user = currentUser();
    if (!user) return navigate(`/account/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    const msg = $("[data-wish-msg]");
    try {
      wished = await toggleWishlist(user.uid, product.id, !wished);
      msg.textContent = wished ? "Saved to your wishlist." : "Removed from your wishlist.";
    } catch {
      msg.textContent = "Couldn't update your wishlist. Please try again.";
    }
    paintWish();
  });

  /* ───────── Reviews ───────── */

  const reviewsBox = $("[data-reviews]");
  async function drawReviews() {
    let list;
    try {
      list = await loadReviews(product.id);
    } catch {
      reviewsBox.innerHTML = `<p class="muted">Reviews couldn't be loaded.</p>`;
      return;
    }
    reviewsBox.innerHTML = `
      ${
        list.length
          ? `<ul class="review-list">${list
              .map(
                (r) => `<li class="review"><p class="review__stars" aria-label="${r.rating} out of 5">${STARS(r.rating)}</p>
              ${r.title ? `<p><strong>${esc(r.title)}</strong></p>` : ""}${paragraphs(r.body)}
              <p class="muted">${esc(r.authorName)} · Verified purchase</p>
              ${r.reply ? `<p class="review__reply"><strong>Reply from the store:</strong> ${esc(r.reply)}</p>` : ""}</li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">No reviews yet.</p>`
      }
      <details class="accordion"><summary>Write a review</summary>
        <form class="auth-form" novalidate data-review-form>
          <p class="fine">Only customers who received this product can review it. Reviews appear after the store approves them.</p>
          <p class="form-alert" role="alert" tabindex="-1" data-review-alert hidden></p>
          <div class="field"><label for="rv-rating">Rating</label>
            <select id="rv-rating" name="rating" required><option value="">Choose…</option>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} — ${STARS(n)}</option>`).join("")}</select></div>
          <div class="field"><label for="rv-title">Headline <span class="muted">(optional)</span></label><input id="rv-title" name="title" maxlength="80" autocomplete="off" /></div>
          <div class="field"><label for="rv-body">Your review</label><textarea id="rv-body" name="body" rows="4" maxlength="1000" required></textarea></div>
          <button class="btn btn--primary" type="submit"><span>Send review</span></button>
        </form>
      </details>`;
    reviewsBox.querySelector("[data-review-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = /** @type {HTMLFormElement} */ (e.target);
      const alert = /** @type {HTMLElement} */ (f.querySelector("[data-review-alert]"));
      const show = (msg) => {
        alert.textContent = msg;
        alert.hidden = false;
        alert.focus();
      };
      if (!currentUser()) return navigate(`/account/login?next=${encodeURIComponent(location.pathname)}`);
      const fd = new FormData(f);
      const rating = Number(fd.get("rating"));
      if (!rating) return show("Please choose a rating.");
      try {
        await submitReview({ productId: product.id, rating, title: String(fd.get("title") ?? ""), body: String(fd.get("body") ?? "") });
        f.innerHTML = `<p class="notice notice--ok" role="status">Thank you! Your review was sent and will appear once the store approves it.</p>`;
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        show(code && code !== "functions/internal" ? /** @type {any} */ (error).message : "Couldn't send your review. Please try again.");
      }
    });
  }
  drawReviews();

  const unsub = cart.subscribe(renderStock);

  const { products } = getCatalog();
  const related = products
    .filter((p) => p.id !== product.id)
    .sort((a, b) => Number(b.category === product.category) - Number(a.category === product.category) || Math.abs(a.price - product.price) - Math.abs(b.price - product.price))
    .slice(0, 4);
  if (related.length) {
    $("[data-related]").innerHTML = grid(related);
    bindCardSwatches($("[data-related]"), products);
  } else {
    $("[data-related-section]").hidden = true;
  }

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
