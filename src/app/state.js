import { loadCatalog } from "../data/catalog.js";
import { createCartStore, resolveLines, cartTotals } from "../lib/cart.js";
import { STORE } from "../config.js";

export const cart = createCartStore();

let catalog = { categories: [], products: [], colorFamilies: [] };
export const catalogReady = loadCatalog().then((c) => (catalog = c));
export const getCatalog = () => catalog;

export const productBySlug = (slug) => catalog.products.find((p) => p.slug === slug);
export const categoryById = (id) => catalog.categories.find((c) => c.id === id);

/** Cart joined with catalogue data + totals. */
export function cartSnapshot() {
  const lines = resolveLines(cart.get(), catalog.products);
  return { lines, totals: cartTotals(lines, STORE.deliveryFee), hasUnavailable: lines.some((l) => !l.available) };
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

/** Products added within the last 45 days count as "New". */
export const isNew = (product, now = new Date()) => (now - new Date(product.added)) / 864e5 <= 45;
