/**
 * Searching the cached catalogue while offline. The cache only helps the cashier choose and price a pair; the server
 * re-checks every price and quantity when the sale is sent, so a stale cache can cause a held sale, never a wrong one.
 */
const words = (text) => String(text).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1);

/** Pairs promised to offline sales that haven't reached the server yet, by "productId/variantId". @param {{ status: string, payload: any }[]} queue */
export function pendingQuantities(queue) {
  const held = new Map();
  for (const q of queue) {
    if (q.status === "synced" || q.status === "discarded") continue;
    for (const l of q.payload.sale.items) held.set(`${l.productId}/${l.variantId}`, (held.get(`${l.productId}/${l.variantId}`) ?? 0) + l.qty);
  }
  return held;
}

/**
 * @param {any[]} products cached products (with variants) @param {string} q @param {{ exact?: boolean, held?: Map<string, number> }} [opts]
 * @returns {{ match: "sku" | "name" | "none", products: any[] }}
 */
export function searchLocal(products, q, { exact = false, held = new Map() } = {}) {
  const adjust = (p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, available: Math.max(0, v.available - (held.get(`${p.id}/${v.id}`) ?? 0)) })) });
  const sku = String(q).trim().toUpperCase();
  const matches = (v) => String(v.sku).toUpperCase() === sku || (v.barcode && String(v.barcode) === String(q).trim());
  const bySku = products.filter((p) => p.variants.some(matches));
  if (bySku.length) return { match: "sku", products: bySku.map((p) => adjust({ ...p, variants: p.variants.filter(matches) })) };
  if (exact) return { match: "none", products: [] };
  const want = words(q);
  if (!want.length) return { match: "none", products: [] };
  const found = products.filter((p) => {
    const have = new Set(words(p.name));
    return want.every((w) => have.has(w));
  });
  return found.length ? { match: "name", products: found.slice(0, 20).map(adjust) } : { match: "none", products: [] };
}
