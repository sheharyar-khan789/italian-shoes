import { loadStore } from "../data/store.js";
import { createCartStore, resolveLines, cartTotals } from "../lib/cart.js";

export const cart = createCartStore();

let catalog = { categories: [], products: [], colorFamilies: [], home: null, error: false };
let settings = {};
/** @type {Promise<any>} */
let ready;

/** Loads the shop from the database. On failure `error` is set so views can offer a retry. */
export function reloadCatalog() {
  // One quiet retry: a slow or briefly blocked first connection shouldn't show an error page.
  ready = loadStore()
    .catch(() => new Promise((resolve) => setTimeout(resolve, 1500)).then(loadStore))
    .then((c) => {
      catalog = { ...c, error: false };
      settings = c.settings ?? {};
      return catalog;
    })
    .catch(() => {
      catalog = { categories: [], products: [], colorFamilies: [], home: null, error: true };
      return catalog;
    });
  return ready;
}
reloadCatalog();
export const catalogReady = ready.then(() => undefined);
/** Await this in views: it always points at the latest load (after a retry too). */
export const whenCatalog = () => ready;
export const getCatalog = () => catalog;
export const getSettings = () => settings;

export const productBySlug = (slug) => catalog.products.find((p) => p.slug === slug);
export const productById = (id) => catalog.products.find((p) => p.id === id);
export const categoryById = (id) => catalog.categories.find((c) => c.id === id);
export const categoryBySlug = (slug) => catalog.categories.find((c) => c.slug === slug);

/** Cart joined with catalogue data + subtotal. */
export function cartSnapshot() {
  const lines = resolveLines(cart.get(), catalog.products);
  return { lines, totals: cartTotals(lines), hasUnavailable: lines.some((l) => !l.available) };
}

// Keep tabs in sync: a bag changed in one tab updates the others.
window.addEventListener("storage", (e) => {
  if (e.key === cart.storageKey) cart.reload();
});

/* Recently viewed: product slugs only, newest first, kept in this browser. */
const RECENT_KEY = "footwear.recent.v1";
export function trackView(slug) {
  try {
    const list = [slug, ...recentSlugs().filter((s) => s !== slug)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: feature simply stays empty */
  }
}
export function recentSlugs() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}
export const recentProducts = (exclude) =>
  recentSlugs()
    .filter((s) => s !== exclude)
    .map(productBySlug)
    .filter(Boolean);

/** New: flagged by the owner, or published within the last 45 days. */
export const isNew = (product, now = new Date()) => product.isNewArrival || (now.getTime() - new Date(product.added).getTime()) / 864e5 <= 45;
