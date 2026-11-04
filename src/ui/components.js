import { esc, formatPKR } from "../lib/format.js";
import { maxQtyFor } from "../lib/cart.js";
import { colorInStock, inStock, onSale, discountPercent } from "../lib/shop.js";
import { productMedia } from "./illustration.js";
import { isNew, categoryById } from "../app/state.js";

export const arrow = `<span class="btn__arrow" aria-hidden="true"></span>`;

export function priceTag(product) {
  if (!onSale(product)) return `<span class="price">${formatPKR(product.price)}</span>`;
  return `<span class="price price--sale">
    <span class="visually-hidden">Sale price </span>${formatPKR(product.price)}
    <s class="price__was"><span class="visually-hidden">Regular price </span>${formatPKR(product.compareAt)}</s>
    <span class="price__save">Save ${discountPercent(product)}%</span>
  </span>`;
}

/* ───────── Product card ───────── */

export function productCard(product, { colorId, eager = false } = {}) {
  const color = product.colors.find((c) => c.id === colorId) ?? product.colors.find(colorInStock) ?? product.colors[0];
  const soldOut = !inStock(product);
  const href = `/product/${product.slug}?color=${color.id}`;
  const badge = soldOut ? "Sold out" : onSale(product) ? `Sale −${discountPercent(product)}%` : isNew(product) ? "New" : "";
  const alt = color.images?.[1];
  return `
  <article class="card" data-product="${esc(product.id)}">
    <a class="card__media" href="${href}" tabindex="-1" aria-hidden="true">
      ${productMedia(product, color, { eager })}
      ${alt ? `<img class="card__alt" src="${esc(alt)}" alt="" loading="lazy" decoding="async" />` : ""}
      ${badge ? `<span class="card__badge${onSale(product) && !soldOut ? " card__badge--sale" : ""}">${badge}</span>` : ""}
    </a>
    <div class="card__body">
      <p class="card__cat">${esc(categoryById(product.category)?.name ?? "")}</p>
      <h3 class="card__title"><a href="${href}">${esc(product.name)}</a></h3>
      <p class="card__price">${priceTag(product)}</p>
      <div class="card__foot">
        <div class="swatches" role="group" aria-label="Colours">
          ${product.colors
            .map(
              (c) => `<button type="button" class="swatch${c.id === color.id ? " is-active" : ""}" data-card-color="${esc(c.id)}"
                style="--swatch:${esc(c.hex)}" aria-label="${esc(c.name)}" aria-pressed="${c.id === color.id}"></button>`,
            )
            .join("")}
        </div>
        <button type="button" class="card__quick" data-quick-add="${esc(product.id)}" data-color="${esc(color.id)}" ${soldOut ? "disabled" : ""}>
          ${soldOut ? "Sold out" : "Quick add"}<span class="visually-hidden"> ${esc(product.name)}</span>
        </button>
      </div>
    </div>
  </article>`;
}

/** Swatch clicks swap the card's image and links to that colour. Delegated per grid. */
export function bindCardSwatches(root, products) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-card-color]");
    if (!btn) return;
    const card = btn.closest(".card");
    const product = products.find((p) => p.id === card.dataset.product);
    const color = product?.colors.find((c) => c.id === btn.dataset.cardColor);
    if (!color) return;
    card.querySelector(".card__media .media").outerHTML = productMedia(product, color);
    card.querySelector(".card__alt")?.remove();
    if (color.images?.[1]) card.querySelector(".card__media .media").insertAdjacentHTML("afterend", `<img class="card__alt" src="${esc(color.images[1])}" alt="" loading="lazy" decoding="async" />`);
    card.querySelectorAll("[data-card-color]").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    const href = `/product/${product.slug}?color=${color.id}`;
    card.querySelectorAll("a").forEach((a) => (a.href = href));
    card.querySelector("[data-quick-add]").dataset.color = color.id;
  });
}

export const grid = (products, opts) => `<div class="grid">${products.map((p, i) => productCard(p, { ...opts, eager: i < 4 })).join("")}</div>`;

export const skeletonGrid = (n = 8) =>
  `<div class="grid" aria-hidden="true">${Array.from({ length: n }, () => `<div class="card card--skeleton"><div class="card__media"><div class="media"></div></div><div class="card__body"><span></span><span></span></div></div>`).join("")}</div>`;

/* ───────── Variant selection (shared by product page + quick add) ───────── */

export function colorOptions(product, colorId, name = "color") {
  return product.colors
    .map(
      (c) => `
      <label class="color-opt${colorInStock(c) ? "" : " is-soldout"}">
        <input type="radio" name="${name}" value="${esc(c.id)}" ${c.id === colorId ? "checked" : ""} />
        <span class="color-opt__dot" style="--swatch:${esc(c.hex)}"></span>
        <span class="color-opt__name">${esc(c.name)}${colorInStock(c) ? "" : " — sold out"}</span>
      </label>`,
    )
    .join("");
}

export function sizeOptions(product, color, size, name = "size") {
  return product.sizes
    .map((s) => {
      const left = maxQtyFor(color, s);
      return `
      <label class="size-opt${left ? "" : " is-soldout"}">
        <input type="radio" name="${name}" value="${s}" ${s === size ? "checked" : ""} ${left ? "" : "disabled"} />
        <span>${s}</span>
        ${left ? "" : `<span class="visually-hidden">sold out</span>`}
      </label>`;
    })
    .join("");
}

export function stockText(color, size) {
  if (size == null) {
    if (!colorInStock(color)) return { tone: "out", text: "Sold out in this colour" };
    return { tone: "", text: "Select a size to check availability" };
  }
  const left = color.stock[size] ?? 0;
  if (left <= 0) return { tone: "out", text: "Sold out in this size" };
  if (left <= 2) return { tone: "low", text: `Low stock — only ${left} left` };
  return { tone: "ok", text: "In stock" };
}

export function emptyState({ title, text, cta = "Explore the Collection", href = "/shop" }) {
  return `
  <div class="empty">
    <p class="empty__title">${title}</p>
    ${text ? `<p class="empty__text">${text}</p>` : ""}
    <a class="btn btn--primary" href="${href}"><span>${cta}</span>${arrow}</a>
  </div>`;
}

export function placeholderNote(text) {
  return `<p class="placeholder-note"><span>Placeholder</span>${text}</p>`;
}
