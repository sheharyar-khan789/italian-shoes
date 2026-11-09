/** Catalogue querying: filtering, sorting, search. Pure functions. */

export const PRICE_BANDS = [
  { id: "0-10000", label: "Under Rs. 10,000", min: 0, max: 9999 },
  { id: "10000-15000", label: "Rs. 10,000 – 15,000", min: 10000, max: 15000 },
  { id: "15000-20000", label: "Rs. 15,000 – 20,000", min: 15001, max: 20000 },
  { id: "20000-", label: "Over Rs. 20,000", min: 20001, max: Infinity },
];

export const SORTS = [
  { id: "featured", label: "Featured" },
  { id: "newest", label: "Newest" },
  { id: "price-asc", label: "Price: low to high" },
  { id: "price-desc", label: "Price: high to low" },
  { id: "name-asc", label: "Name: A–Z" },
  { id: "name-desc", label: "Name: Z–A" },
];

/** A product is on sale when a higher regular price (`compareAt`) is set. `price` is always the selling price. */
export const onSale = (product) => Number(product.compareAt) > product.price;
export const discountPercent = (product) => (onSale(product) ? Math.round((1 - product.price / product.compareAt) * 100) : 0);

export const inStock = (product) => product.colors.some((c) => Object.values(c.stock).some((q) => q > 0));
export const colorInStock = (color) => Object.values(color.stock).some((q) => q > 0);

/**
 * filters: { category?, sizes: number[], colors: string[] (families), price: band id[],
 *            inStock?: boolean, sale?: boolean, sort }
 * A product matches a size/colour filter only if that size is in stock in a matching colour.
 */
export function queryProducts(products, filters = {}) {
  const { category, sizes = [], colors = [], price = [], inStock: stockOnly = false, sale = false, sort = "featured" } = filters;
  const bands = PRICE_BANDS.filter((b) => price.includes(b.id));

  const result = products.filter((p) => {
    if (category && p.category !== category) return false;
    if (sale && !onSale(p)) return false;
    if (stockOnly && !inStock(p)) return false;
    if (bands.length && !bands.some((b) => p.price >= b.min && p.price <= b.max)) return false;
    const variants = colors.length ? p.colors.filter((c) => colors.includes(c.family)) : p.colors;
    if (!variants.length) return false;
    if (sizes.length && !variants.some((c) => sizes.some((s) => (c.stock[s] ?? 0) > 0))) return false;
    return true;
  });

  const byNewest = (a, b) => b.added.localeCompare(a.added);
  const sorters = {
    featured: (a, b) => Number(b.featured) - Number(a.featured) || byNewest(a, b),
    newest: byNewest,
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    "name-asc": (a, b) => a.name.localeCompare(b.name),
    "name-desc": (a, b) => b.name.localeCompare(a.name),
  };
  return result.sort(sorters[sort] ?? sorters.featured);
}

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

/** Every word of the query must appear in the product's searchable text. */
export function searchProducts(products, categories, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return products.filter((p) => {
    const cat = categories.find((c) => c.id === p.category)?.name ?? "";
    const text = norm([p.name, cat, p.description, ...(p.keywords ?? []), ...p.colors.map((c) => c.name)].join(" "));
    return words.every((w) => text.includes(w));
  });
}

/** Distinct sizes across products as { id, label }, in natural order of the label (36, 37, … 42). */
export const allSizes = (products) => {
  const byId = new Map(products.flatMap((p) => p.sizes).map((s) => [s.id, s]));
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
};
