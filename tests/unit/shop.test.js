import { test } from "node:test";
import assert from "node:assert/strict";
import { queryProducts, searchProducts, allSizes } from "../../src/lib/shop.js";
import { PRODUCTS, CATEGORIES } from "../../src/data/catalog.js";

test("category filter", () => {
  const r = queryProducts(PRODUCTS, { category: "formal" });
  assert.ok(r.length > 0);
  assert.ok(r.every((p) => p.category === "formal"));
});

test("price band filter", () => {
  const r = queryProducts(PRODUCTS, { price: ["0-10000"] });
  assert.ok(r.length > 0);
  assert.ok(r.every((p) => p.price < 10000));
});

test("size filter only matches sizes that are in stock", () => {
  // Desert Boot brown is entirely sold out; sand has stock in 41.
  const r = queryProducts(PRODUCTS, { sizes: [41], colors: ["brown"] });
  assert.ok(!r.some((p) => p.id === "DEMO-BO-002"));
  assert.ok(queryProducts(PRODUCTS, { sizes: [41], colors: ["tan"] }).some((p) => p.id === "DEMO-BO-002"));
});

test("sorting", () => {
  const asc = queryProducts(PRODUCTS, { sort: "price-asc" }).map((p) => p.price);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const desc = queryProducts(PRODUCTS, { sort: "price-desc" }).map((p) => p.price);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  const newest = queryProducts(PRODUCTS, { sort: "newest" }).map((p) => p.added);
  assert.deepEqual(newest, [...newest].sort().reverse());
});

test("impossible filter combination returns empty", () => {
  assert.deepEqual(queryProducts(PRODUCTS, { category: "sandals", price: ["20000-"] }), []);
});

test("search matches name, category and colour words", () => {
  assert.ok(searchProducts(PRODUCTS, CATEGORIES, "chelsea").some((p) => p.slug === "classic-chelsea"));
  assert.ok(searchProducts(PRODUCTS, CATEGORIES, "formal black").every((p) => p.category === "formal"));
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "   "), []);
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "zzzz"), []);
});

test("catalogue integrity: unique ids/slugs, sizes have stock entries", () => {
  assert.equal(new Set(PRODUCTS.map((p) => p.id)).size, PRODUCTS.length);
  assert.equal(new Set(PRODUCTS.map((p) => p.slug)).size, PRODUCTS.length);
  for (const p of PRODUCTS) {
    assert.ok(CATEGORIES.some((c) => c.id === p.category), p.id);
    for (const c of p.colors) for (const s of p.sizes) assert.ok(s in c.stock, `${p.id} ${c.id} ${s}`);
  }
  assert.ok(allSizes(PRODUCTS).length >= 7);
});

test("sale filter and discount percent", async () => {
  const { onSale, discountPercent } = await import("../../src/lib/shop.js");
  const sale = queryProducts(PRODUCTS, { sale: true });
  assert.ok(sale.length > 0);
  assert.ok(sale.every(onSale));
  assert.ok(sale.every((p) => p.compareAt > p.price));
  assert.equal(discountPercent({ price: 5900, compareAt: 6900 }), 14);
  assert.equal(discountPercent({ price: 5900 }), 0);
  assert.equal(onSale({ price: 5900, compareAt: 5900 }), false);
});

test("in-stock-only filter drops fully sold-out products", () => {
  const soldOut = { ...PRODUCTS[0], id: "X", colors: [{ ...PRODUCTS[0].colors[0], stock: { 41: 0 } }] };
  const list = [...PRODUCTS, soldOut];
  assert.ok(queryProducts(list, {}).some((p) => p.id === "X"));
  assert.ok(!queryProducts(list, { inStock: true }).some((p) => p.id === "X"));
});

test("alphabetical sorts", () => {
  const az = queryProducts(PRODUCTS, { sort: "name-asc" }).map((p) => p.name);
  assert.deepEqual(az, [...az].sort((a, b) => a.localeCompare(b)));
  const za = queryProducts(PRODUCTS, { sort: "name-desc" }).map((p) => p.name);
  assert.deepEqual(za, [...az].reverse());
});
