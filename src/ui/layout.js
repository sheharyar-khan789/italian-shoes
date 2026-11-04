import { STORE } from "../config.js";
import { esc, formatPKR } from "../lib/format.js";
import { maxQtyFor } from "../lib/cart.js";
import { colorInStock, searchProducts } from "../lib/shop.js";
import { normalizeWhatsAppNumber } from "../lib/order.js";
import { cart, cartSnapshot, getCatalog, catalogReady } from "../app/state.js";
import { navigate, onRouteChange } from "../app/router.js";
import { bagContents, bindBagControls, restoreFocus } from "./cartView.js";
import { colorOptions, sizeOptions, stockText } from "./components.js";
import { productMedia } from "./illustration.js";

const header = document.querySelector(".site-header");
const cartDrawer = document.getElementById("cart-drawer");
const cartBody = cartDrawer.querySelector("[data-cart-drawer-body]");
const searchDialog = document.getElementById("search-dialog");
const sheet = document.getElementById("sheet");
const toastEl = document.querySelector(".toast");

/* ───────── Dialog plumbing (native <dialog>: focus trap, Escape, inert page) ───────── */

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  document.documentElement.classList.add("has-dialog");
}
for (const d of [cartDrawer, searchDialog, sheet]) {
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close]")) d.close();
  });
  d.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]")) document.documentElement.classList.remove("has-dialog");
  });
}

/* ───────── Toast ───────── */

let toastTimer;
export function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 3200);
}

/* ───────── Cart drawer + count ───────── */

function renderCount() {
  const { totals } = cartSnapshot();
  const n = totals.itemCount;
  document.querySelectorAll("[data-cart-count]").forEach((el) => {
    el.textContent = n;
    el.hidden = n === 0;
  });
  document.querySelectorAll("[data-open-cart]").forEach((a) => a.setAttribute("aria-label", `Shopping bag, ${n} ${n === 1 ? "item" : "items"}`));
}

function renderDrawer() {
  cartBody.innerHTML = bagContents({ variant: "drawer" });
  restoreFocus(cartBody);
}
bindBagControls(cartBody);

export function openCart() {
  renderDrawer();
  openDialog(cartDrawer);
}

cart.subscribe(() => {
  renderCount();
  if (cartDrawer.open) renderDrawer();
});

/* ───────── Generic sheet ───────── */

export function openSheet(title, html, bind) {
  sheet.querySelector("#sheet-title").textContent = title;
  // Fresh element each time so listeners from a previous use don't accumulate.
  const old = sheet.querySelector("[data-sheet-body]");
  const body = old.cloneNode(false);
  old.replaceWith(body);
  body.innerHTML = html;
  bind?.(body);
  openDialog(sheet);
}
export const closeSheet = () => sheet.open && sheet.close();

/* ───────── Add to bag ───────── */

/** Single entry point for adding; refuses missing size/colour or sold-out variants. */
export function addToBag(product, colorId, size, qty = 1) {
  const color = product.colors.find((c) => c.id === colorId);
  if (!color) return { ok: false, error: "Please choose a colour." };
  if (size == null || !product.sizes.includes(Number(size))) return { ok: false, error: "Please select a size." };
  const max = maxQtyFor(color, Number(size));
  if (max < 1) return { ok: false, error: "This size is sold out." };
  const inBag = cart.get().find((l) => l.productId === product.id && l.colorId === color.id && l.size === Number(size))?.qty ?? 0;
  if (inBag >= max) return { ok: false, error: `You already have the maximum available (${max}) in your bag.` };
  cart.add({ productId: product.id, colorId: color.id, size: Number(size), qty }, max);
  const added = Math.min(qty, max - inBag);
  toast(`Added to bag — ${product.name}, ${color.name}, EU ${size}${added > 1 ? ` ×${added}` : ""}`);
  return { ok: true };
}

/* ───────── Quick add ───────── */

function quickAdd(product, colorId) {
  let color = product.colors.find((c) => c.id === colorId && colorInStock(c)) ?? product.colors.find(colorInStock) ?? product.colors[0];
  let size = null;

  const html = () => `
    <div class="quick">
      <div class="quick__media">${productMedia(product, color)}</div>
      <div class="quick__info">
        <p class="quick__price">${formatPKR(product.price)}</p>
        <fieldset class="field-set">
          <legend>Colour <span class="muted">— ${esc(color.name)}</span></legend>
          <div class="color-opts">${colorOptions(product, color.id, "qa-color")}</div>
        </fieldset>
        <fieldset class="field-set">
          <legend>Size <span class="muted">(EU)</span></legend>
          <div class="size-opts">${sizeOptions(product, color, size, "qa-size")}</div>
        </fieldset>
        <p class="stock stock--${stockText(color, size).tone}">${stockText(color, size).text}</p>
        <p class="form-alert" data-qa-error role="alert" hidden></p>
        <button type="button" class="btn btn--primary btn--block" data-qa-add><span>Add to Bag</span></button>
        <a class="text-link" href="/product/${product.slug}?color=${color.id}">View full details</a>
      </div>
    </div>`;

  openSheet(product.name, html(), (body) => {
    const rerender = () => {
      body.innerHTML = html();
    };
    body.addEventListener("change", (e) => {
      if (e.target.name === "qa-color") {
        color = product.colors.find((c) => c.id === e.target.value);
        if (size != null && maxQtyFor(color, size) < 1) size = null;
        rerender();
        body.querySelector(`input[name="qa-color"]:checked`)?.focus();
      } else if (e.target.name === "qa-size") {
        size = Number(e.target.value);
        rerender();
        body.querySelector(`input[name="qa-size"]:checked`)?.focus();
      }
    });
    body.addEventListener("click", (e) => {
      if (!e.target.closest("[data-qa-add]")) return;
      const result = addToBag(product, color.id, size);
      if (!result.ok) {
        const err = body.querySelector("[data-qa-error]");
        err.textContent = result.error;
        err.hidden = false;
        return;
      }
      closeSheet();
      openCart();
    });
  });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-quick-add]");
  if (!btn) return;
  const product = getCatalog().products.find((p) => p.id === btn.dataset.quickAdd);
  if (product) quickAdd(product, btn.dataset.color);
});

/* ───────── Search ───────── */

const searchInput = searchDialog.querySelector("input");
const suggest = searchDialog.querySelector("[data-search-suggest]");

function renderSuggestions() {
  const q = searchInput.value.trim();
  const { products, categories } = getCatalog();
  if (!q) {
    suggest.innerHTML = `<p class="suggest__label">Browse</p><div class="suggest__chips">${categories
      .map((c) => `<a class="chip" href="/shop/${c.id}">${esc(c.name)}</a>`)
      .join("")}</div>`;
    return;
  }
  const hits = searchProducts(products, categories, q).slice(0, 5);
  suggest.innerHTML = hits.length
    ? `<ul class="suggest__list">${hits
        .map((p) => `<li><a href="/product/${p.slug}"><span>${esc(p.name)}</span><span class="muted">${formatPKR(p.price)}</span></a></li>`)
        .join("")}</ul><a class="text-link" href="/search?q=${encodeURIComponent(q)}">See all results for “${esc(q)}”</a>`
    : `<p class="suggest__label">No matches for “${esc(q)}”. Try “loafer”, “black” or “boots”.</p>`;
}

export async function openSearch(initial = "") {
  await catalogReady;
  searchInput.value = initial;
  renderSuggestions();
  openDialog(searchDialog);
  searchInput.focus();
}
searchInput.addEventListener("input", renderSuggestions);
searchDialog.querySelector("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  searchDialog.close();
  navigate(`/search?q=${encodeURIComponent(q)}`);
});

/* ───────── Header: menu, solid-on-scroll, utilities ───────── */

const toggle = header.querySelector(".menu-toggle");
const nav = document.getElementById("site-nav");

function setMenu(open) {
  toggle.setAttribute("aria-expanded", String(open));
  toggle.querySelector(".menu-toggle__label").textContent = open ? "Close" : "Menu";
  nav.classList.toggle("is-open", open);
  header.classList.toggle("menu-open", open);
  document.body.style.overflow = open ? "hidden" : "";
  if (open) nav.querySelector("a")?.focus();
}
toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
nav.addEventListener("click", (e) => e.target.closest("a") && setMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    toggle.focus();
  }
});

const announce = document.querySelector("[data-announce]");
const updateHeader = () => {
  const overHero = document.body.dataset.route === "home" && window.scrollY < 40;
  header.classList.toggle("is-solid", !overHero);
  // The announcement bar scrolls away; the fixed header slides up to the top with it.
  const barH = announce.hidden ? 0 : announce.offsetHeight;
  header.style.top = `${Math.max(0, barH - window.scrollY)}px`;
};
window.addEventListener("scroll", updateHeader, { passive: true });
window.addEventListener("resize", updateHeader);
window.addEventListener("load", updateHeader);

onRouteChange((name, url) => {
  setMenu(false);
  updateHeader();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  nav.querySelectorAll("a").forEach((a) => {
    const target = new URL(a.href).pathname;
    a.toggleAttribute("aria-current", target === path);
    if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
  });
});

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-search]")) {
    e.preventDefault();
    openSearch();
  } else if (e.target.closest("[data-open-cart]")) {
    e.preventDefault();
    openCart();
  }
});

/* ───────── Brand + footer from config ───────── */

export function applyStoreConfig() {
  document.querySelectorAll(".brand").forEach((brand) => {
    if (STORE.logo) {
      brand.innerHTML = `<img class="brand__logo" src="${esc(STORE.logo)}" alt="${esc(STORE.name || "Store logo")}" />`;
    } else if (STORE.name) {
      brand.querySelector(".brand__word").textContent = STORE.name;
    }
  });

  const urdu = document.querySelector("[data-name-urdu]");
  if (urdu) urdu.textContent = STORE.nameUrdu ?? "";

  const c = STORE.contact;
  const contact = document.querySelector("[data-footer-contact]");
  const rows = [
    c.phone && `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>`,
    c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`,
    c.address && `<p>${esc(c.address)}</p>`,
    c.hours && `<p>${esc(c.hours)}</p>`,
    c.instagram && `<a href="${esc(c.instagram)}" target="_blank" rel="noopener">Instagram</a>`,
  ].filter(Boolean);
  contact.insertAdjacentHTML(
    "beforeend",
    rows.length ? rows.join("") : `<p class="muted">Contact details to be confirmed.</p><a href="/contact">Contact page</a>`,
  );

  document.querySelector("[data-demo-note]").textContent = STORE.demoCatalog
    ? "Demonstration storefront — products, prices and stock shown are sample data, not the store's real inventory."
    : `© ${new Date().getFullYear()} ${STORE.name || ""}`.trim();

  if (STORE.announcement) {
    announce.textContent = STORE.announcement;
    announce.hidden = false;
    document.body.classList.add("has-announce");
  }

  // Floating contact button: WhatsApp once the number is configured, otherwise a phone call.
  const fab = document.querySelector("[data-fab]");
  const wa = normalizeWhatsAppNumber(STORE.whatsappNumber);
  const phoneDigits = c.phone.replace(/\D/g, "").replace(/^0/, "");
  if (wa || phoneDigits) {
    fab.href = wa ? `https://wa.me/${wa}` : `tel:+92${phoneDigits}`;
    if (wa) {
      fab.target = "_blank";
      fab.rel = "noopener";
    }
    fab.setAttribute("aria-label", wa ? "Message the store on WhatsApp" : `Call the store, ${c.phone}`);
    fab.innerHTML = wa
      ? `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4.5 19.5l1.1-3.6A8 8 0 1 1 8.3 18.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.2 8.6c.3 2.6 2.5 4.9 5.2 5.3l1-1.2-1.7-.9-.8.7c-.9-.4-1.7-1.2-2.1-2.1l.7-.8-.9-1.7z" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6.6 3.5l2.6 3.8-1.6 1.9c.9 2.3 3 4.4 5.3 5.3l1.9-1.6 3.8 2.6-1 2.9c-.3.8-1.1 1.3-1.9 1.2C9.8 19 5 14.2 4.4 8.3c-.1-.8.4-1.6 1.2-1.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    fab.hidden = false;
  }

  updateHeader();
  renderCount();
}
