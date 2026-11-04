/**
 * Cart logic. Pure functions + a small persisted store.
 *
 * A cart line is identified by product + colour + size, so the same shoe in two sizes or two
 * colours stays as separate lines. Only ids and quantities are stored — prices, names and stock
 * are always re-read from the catalogue, so a stale browser can never show an outdated price.
 */

export const MAX_QTY_PER_LINE = 10;
const STORAGE_KEY = "footwear.cart.v1";

export const lineKey = (productId, colorId, size) => `${productId}|${colorId}|${size}`;

export const findVariant = (products, productId, colorId) => {
  const product = products.find((p) => p.id === productId);
  const color = product?.colors.find((c) => c.id === colorId);
  return product && color ? { product, color } : null;
};

/** Stock for a size, capped at the per-line maximum. */
export const maxQtyFor = (color, size) => Math.min(MAX_QTY_PER_LINE, Math.max(0, color.stock?.[size] ?? 0));

const toInt = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : 0);

export function addItem(lines, { productId, colorId, size, qty = 1 }, maxQty = MAX_QTY_PER_LINE) {
  const amount = toInt(qty);
  if (!productId || !colorId || size == null || amount < 1 || maxQty < 1) return lines;
  const key = lineKey(productId, colorId, size);
  const existing = lines.find((l) => l.key === key);
  if (existing) {
    return lines.map((l) => (l.key === key ? { ...l, qty: Math.min(maxQty, l.qty + amount) } : l));
  }
  return [...lines, { key, productId, colorId, size: Number(size), qty: Math.min(maxQty, amount) }];
}

/** Quantity is clamped to 1…max; use removeItem to delete a line. */
export function setQty(lines, key, qty, maxQty = MAX_QTY_PER_LINE) {
  const n = Math.min(Math.max(1, toInt(qty)), Math.max(1, maxQty));
  return lines.map((l) => (l.key === key ? { ...l, qty: n } : l));
}

export const removeItem = (lines, key) => lines.filter((l) => l.key !== key);

/** Join stored lines with catalogue data. Lines whose product/colour no longer exist are dropped. */
export function resolveLines(lines, products) {
  return lines.flatMap((line) => {
    const v = findVariant(products, line.productId, line.colorId);
    if (!v || !v.product.sizes.includes(line.size)) return [];
    const max = maxQtyFor(v.color, line.size);
    const qty = Math.min(line.qty, Math.max(max, 1));
    return [
      {
        ...line,
        qty,
        product: v.product,
        color: v.color,
        unitPrice: v.product.price,
        lineTotal: v.product.price * qty,
        maxQty: max,
        available: max >= qty && max > 0,
      },
    ];
  });
}

/** deliveryFee: number (PKR) or null when not yet confirmed — then total is null. */
export function cartTotals(resolved, deliveryFee = null) {
  const subtotal = resolved.reduce((sum, l) => sum + l.lineTotal, 0);
  const itemCount = resolved.reduce((sum, l) => sum + l.qty, 0);
  const fee = typeof deliveryFee === "number" && deliveryFee >= 0 ? deliveryFee : null;
  return { itemCount, subtotal, delivery: fee, total: fee === null ? null : subtotal + fee };
}

function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l.productId === "string" && typeof l.colorId === "string" && Number.isFinite(Number(l.size)))
    .map((l) => ({
      key: lineKey(l.productId, l.colorId, Number(l.size)),
      productId: l.productId,
      colorId: l.colorId,
      size: Number(l.size),
      qty: Math.min(MAX_QTY_PER_LINE, Math.max(1, toInt(l.qty))),
    }));
}

/**
 * Persisted cart store. Only product ids, colour ids, sizes and quantities are written to
 * storage — never customer details.
 */
export function createCartStore(storage = globalThis.localStorage) {
  const read = () => {
    try {
      return sanitize(JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null")?.lines);
    } catch {
      return [];
    }
  };
  let lines = read();
  const listeners = new Set();

  const commit = (next) => {
    lines = next;
    try {
      storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 1, lines: lines.map(({ productId, colorId, size, qty }) => ({ productId, colorId, size, qty })) }),
      );
    } catch {
      /* storage full or blocked: the cart still works for this page view */
    }
    listeners.forEach((fn) => fn(lines));
  };

  return {
    get: () => lines,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    add: (item, maxQty) => commit(addItem(lines, item, maxQty)),
    setQty: (key, qty, maxQty) => commit(setQty(lines, key, qty, maxQty)),
    remove: (key) => commit(removeItem(lines, key)),
    clear: () => commit([]),
    /** Pick up changes made in another tab. */
    reload: () => commit(read()),
    storageKey: STORAGE_KEY,
  };
}
