import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, setQty, removeItem, resolveLines, cartTotals, createCartStore, lineKey, variantIdOf, MAX_QTY_PER_LINE } from "../../src/lib/cart.js";
import { PRODUCTS } from "../fixtures/products.js";

const low = PRODUCTS[0];

test("same product in different sizes or colours stays as separate lines", () => {
  let lines = [];
  lines = addItem(lines, { productId: low.id, colorId: "beach", sizeId: "s41" });
  lines = addItem(lines, { productId: low.id, colorId: "beach", sizeId: "s42" });
  lines = addItem(lines, { productId: low.id, colorId: "night", sizeId: "s41" });
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.key),
    [lineKey(low.id, "beach", "s41"), lineKey(low.id, "beach", "s42"), lineKey(low.id, "night", "s41")],
  );
});

test("adding the same variant again merges and respects the max quantity", () => {
  let lines = addItem([], { productId: low.id, colorId: "beach", sizeId: "s41", qty: 2 }, 4);
  lines = addItem(lines, { productId: low.id, colorId: "beach", sizeId: "s41", qty: 3 }, 4);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 4);
});

test("invalid additions are ignored", () => {
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", sizeId: null }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", sizeId: "s41", qty: 0 }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", sizeId: "s41", qty: -2 }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", sizeId: "s41" }, 0), [], "sold out");
});

test("setQty clamps to 1..max and removeItem deletes", () => {
  const lines = addItem([], { productId: low.id, colorId: "beach", sizeId: "s41" });
  const key = lines[0].key;
  assert.equal(setQty(lines, key, 0)[0].qty, 1);
  assert.equal(setQty(lines, key, "abc")[0].qty, 1);
  assert.equal(setQty(lines, key, 99, 4)[0].qty, 4);
  assert.equal(setQty(lines, key, 3, 4)[0].qty, 3);
  assert.equal(removeItem(lines, key).length, 0);
});

test("the server variant id is colour_size", () => {
  assert.equal(variantIdOf({ colorId: "beach", sizeId: "s41" }), "beach_s41");
});

test("totals use each variant's own price and show a subtotal only (delivery is the server's job)", () => {
  let lines = addItem([], { productId: low.id, colorId: "beach", sizeId: "s41", qty: 2 });
  lines = addItem(lines, { productId: "p-formal", colorId: "black", sizeId: "s42", qty: 1 });
  const resolved = resolveLines(lines, PRODUCTS);
  assert.equal(resolved[0].lineTotal, 25000);
  assert.equal(resolved[1].unitPrice, 11000, "the s42 variant costs more than the product's 'from' price");
  assert.equal(resolved[1].sizeLabel, "42");
  assert.deepEqual(cartTotals(resolved), { itemCount: 3, subtotal: 36000 });
});

test("resolveLines drops lines for unknown products, colours or sizes", () => {
  const lines = [
    { key: "x", productId: "NOPE", colorId: "beach", sizeId: "s41", qty: 1 },
    { key: "y", productId: low.id, colorId: "nope", sizeId: "s41", qty: 1 },
    { key: "z", productId: low.id, colorId: "beach", sizeId: "zzz", qty: 1 },
  ];
  assert.equal(resolveLines(lines, PRODUCTS).length, 0);
});

test("resolveLines flags lines whose size has since sold out", () => {
  const lines = addItem([], { productId: low.id, colorId: "beach", sizeId: "s42" }); // stock 0
  const [line] = resolveLines(lines, PRODUCTS);
  assert.equal(line.available, false);
});

test("store persists only ids and quantities, and survives a reload", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = createCartStore(storage);
  a.add({ productId: low.id, colorId: "beach", sizeId: "s41", qty: 2 });
  assert.deepEqual(JSON.parse(mem.get(a.storageKey)), { v: 1, lines: [{ productId: low.id, colorId: "beach", sizeId: "s41", qty: 2 }] });

  const b = createCartStore(storage); // "refresh"
  assert.equal(b.get().length, 1);
  assert.equal(b.get()[0].qty, 2);
});

test("store ignores corrupted storage", () => {
  const storage = { getItem: () => "{not json", setItem: () => {} };
  assert.deepEqual(createCartStore(storage).get(), []);
  const tampered = { getItem: () => JSON.stringify({ lines: [{ productId: low.id, colorId: "beach", sizeId: "s41", qty: 999 }, { bad: true }, { productId: "a", colorId: "b", sizeId: 41, qty: 1 }] }), setItem: () => {} };
  const lines = createCartStore(tampered).get();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, MAX_QTY_PER_LINE);
});
