import { test } from "node:test";
import assert from "node:assert/strict";
import { toProduct } from "../../src/data/product.js";
import { keyFor, fingerprint } from "../../src/lib/idempotency.js";
import { snippet } from "../../src/lib/seo.js";

const refs = {
  colors: new Map([["c1", { name: "Black", hex: "#111111" }]]),
  sizes: new Map([
    ["z42", { value: "42", sortOrder: 42 }],
    ["z40", { value: "40", sortOrder: 40 }],
  ]),
};
const doc = {
  slug: "x",
  name: "X",
  categoryId: "cat",
  description: "d",
  isFeatured: true,
  images: [
    { isPrimary: false, paths: { 800: "a-800" } },
    { isPrimary: true, paths: { 800: "b-800", 400: "b-400" } },
  ],
  summary: {
    minPrice: 900000,
    maxPrice: 1100000,
    onSale: true,
    regularPrice: 990000,
    stock: { c1: { z42: 2, z40: 0 } },
    prices: { c1: { z42: 1100000, z40: 900000 } },
    regularPrices: { c1: { z42: 1100000, z40: 990000 } },
  },
};

test("a published product becomes the storefront shape, in rupees, with the primary photo first", () => {
  const p = toProduct("id1", doc, refs, (path) => `url:${path}`);
  assert.deepEqual([p.price, p.priceMax, p.compareAt, p.featured], [9000, 11000, 9900, true]);
  assert.deepEqual(p.sizes.map((s) => s.label), ["40", "42"], "sorted by the owner's order");
  assert.deepEqual(p.colors[0].images, ["url:b-800", "url:a-800"]);
  assert.deepEqual(p.colors[0].stock, { z42: 2, z40: 0 });
  assert.equal(p.colors[0].prices.z42, 11000);
  assert.equal(p.colors[0].name, "Black");
});

test("no sale is shown when the cheapest option isn't discounted; empty summaries give no colours", () => {
  const p = toProduct("id2", { ...doc, summary: { ...doc.summary, onSale: false } }, refs);
  assert.equal(p.compareAt, null);
  assert.deepEqual(toProduct("id3", { slug: "y", name: "Y", summary: {} }, refs).colors, []);
});

test("an order attempt keeps its key until the bag, address, delivery or coupon changes", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  let n = 0;
  const make = () => `key-${++n}`;
  const payload = { items: [{ productId: "a", variantId: "v", qty: 1 }], shippingMethodId: "m", couponCode: "", address: { city: "Lahore" }, customer: { name: "A" } };
  const k1 = keyFor(storage, fingerprint(payload), make);
  assert.equal(keyFor(storage, fingerprint(payload), make), k1, "a retry reuses the key");
  assert.notEqual(keyFor(storage, fingerprint({ ...payload, items: [{ productId: "a", variantId: "v", qty: 2 }] }), make), k1, "a changed bag gets a new key");
  assert.equal(keyFor(null, "x", make), "key-3", "works without storage");
});

test("snippet cuts at a word and never exceeds the limit", () => {
  assert.equal(snippet("  one   two  ", 50), "one two");
  const s = snippet("alpha beta gamma delta", 12);
  assert.ok(s.length <= 12 && s.endsWith("…"));
});
