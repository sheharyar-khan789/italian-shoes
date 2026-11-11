/**
 * Turns a published product document (with its public stock/price summary) into the shape the
 * storefront views use. Pure: no network, so it is unit-tested. Prices become rupees.
 */
const rupees = (paisa) => (paisa == null ? 0 : paisa / 100);
const iso = (ts) => (ts?.toDate ? ts.toDate().toISOString() : typeof ts === "string" ? ts : new Date(0).toISOString());

/** @param {string} id @param {any} d @param {{ colors: Map<string, any>, sizes: Map<string, any> }} refs */
export function toProduct(id, d, refs, urlOf = (p) => p) {
  const summary = d.summary ?? {};
  const stock = summary.stock ?? {};
  const photos = [...(d.images ?? [])].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const urls = photos.map((im) => im.paths?.[800] ?? im.paths?.[400]).filter(Boolean).map(urlOf);

  const sizeIds = [...new Set(Object.values(stock).flatMap((m) => Object.keys(m)))];
  const sizes = sizeIds
    .map((sid) => ({ id: sid, label: refs.sizes.get(sid)?.value ?? "?", order: refs.sizes.get(sid)?.sortOrder ?? 0 }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map(({ id: sid, label }) => ({ id: sid, label }));

  const colors = Object.keys(stock).map((cid) => ({
    id: cid,
    name: refs.colors.get(cid)?.name ?? "Colour",
    family: cid,
    hex: refs.colors.get(cid)?.hex ?? "#888888",
    sole: "#ece6dc",
    images: urls,
    stock: stock[cid],
    prices: Object.fromEntries(Object.entries(summary.prices?.[cid] ?? {}).map(([k, v]) => [k, rupees(v)])),
    regularPrices: Object.fromEntries(Object.entries(summary.regularPrices?.[cid] ?? {}).map(([k, v]) => [k, rupees(v)])),
  }));

  return {
    id,
    slug: d.slug,
    name: d.name,
    category: d.categoryId,
    brandId: d.brandId ?? null,
    price: rupees(summary.minPrice),
    priceMax: rupees(summary.maxPrice),
    compareAt: summary.onSale && summary.regularPrice != null ? rupees(summary.regularPrice) : null,
    added: iso(d.publishedAt ?? d.createdAt),
    featured: d.isFeatured === true,
    isNewArrival: d.isNewArrival === true,
    style: "sneaker",
    description: d.description ?? "",
    details: [],
    rating: d.rating?.count ? d.rating : null,
    seoTitle: d.seoTitle || "",
    seoDescription: d.seoDescription || "",
    sizes,
    colors,
    keywords: summary.keywords ?? [],
  };
}
