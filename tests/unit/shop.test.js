import { test } from "node:test";
import assert from "node:assert/strict";
import { queryProducts, searchProducts, allSizes, onSale, discountPercent } from "../../src/lib/shop.js";
import { PRODUCTS, CATEGORIES } from "../fixtures/products.js";

test("category filter", () => {
  const r = queryProducts(PRODUCTS, { category: "cat-formal" });
  assert.deepEqual(r.map((p) => p.id), ["p-formal"]);
});

test("price band filter", () => {
  const r = queryProducts(PRODUCTS, { price: ["0-10000"] });
  assert.deepEqual(r.map((p) => p.id), ["p-formal"]);
});

test("size filter only matches sizes that are in stock in a matching colour", () => {
  // The Midnight colour is entirely sold out; Beach Rose has stock in s41.
  assert.ok(!queryProducts(PRODUCTS, { sizes: ["s41"], colors: ["night"] }).some((p) => p.id === "p-low"));
  assert.ok(queryProducts(PRODUCTS, { sizes: ["s41"], colors: ["beach"] }).some((p) => p.id === "p-low"));
  assert.ok(!queryProducts(PRODUCTS, { sizes: ["s42"], colors: ["beach"] }).some((p) => p.id === "p-low"), "s42 is sold out in Beach Rose");
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
  assert.deepEqual(queryProducts(PRODUCTS, { category: "cat-formal", price: ["20000-"] }), []);
});

test("search matches name, category, colour and keyword words", () => {
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "oxford").map((p) => p.id), ["p-formal"]);
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "formal black").map((p) => p.id), ["p-formal"]);
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "   "), []);
  assert.deepEqual(searchProducts(PRODUCTS, CATEGORIES, "zzzz"), []);
});

test("sizes are listed once each, in natural order", () => {
  assert.deepEqual(allSizes(PRODUCTS).map((s) => s.label), ["40", "41", "42", "43"]);
});

test("sale filter and discount percent", () => {
  const sale = queryProducts(PRODUCTS, { sale: true });
  assert.deepEqual(sale.map((p) => p.id), ["p-formal"]);
  assert.ok(sale.every(onSale));
  assert.equal(discountPercent({ price: 5900, compareAt: 6900 }), 14);
  assert.equal(discountPercent({ price: 5900 }), 0);
  assert.equal(onSale({ price: 5900, compareAt: 5900 }), false);
});

test("in-stock-only filter drops fully sold-out products", () => {
  const soldOut = { ...PRODUCTS[0], id: "X", colors: [{ ...PRODUCTS[0].colors[1] }] };
  const list = [...PRODUCTS, soldOut];
  assert.ok(queryProducts(list, {}).some((p) => p.id === "X"));
  assert.ok(!queryProducts(list, { inStock: true }).some((p) => p.id === "X"));
});
