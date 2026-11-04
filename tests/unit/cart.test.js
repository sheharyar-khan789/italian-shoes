import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, setQty, removeItem, resolveLines, cartTotals, createCartStore, lineKey, MAX_QTY_PER_LINE } from "../../src/lib/cart.js";
import { PRODUCTS } from "../../src/data/catalog.js";

const low = PRODUCTS.find((p) => p.id === "DEMO-SN-001");

test("same product in different sizes or colours stays as separate lines", () => {
  let lines = [];
  lines = addItem(lines, { productId: low.id, colorId: "beach", size: 41 });
  lines = addItem(lines, { productId: low.id, colorId: "beach", size: 42 });
  lines = addItem(lines, { productId: low.id, colorId: "midnight", size: 41 });
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.key),
    [lineKey(low.id, "beach", 41), lineKey(low.id, "beach", 42), lineKey(low.id, "midnight", 41)],
  );
});

test("adding the same variant again merges and respects the max quantity", () => {
  let lines = addItem([], { productId: low.id, colorId: "beach", size: 41, qty: 2 }, 4);
  lines = addItem(lines, { productId: low.id, colorId: "beach", size: 41, qty: 3 }, 4);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 4);
});

test("invalid additions are ignored", () => {
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", size: null }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", size: 41, qty: 0 }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", size: 41, qty: -2 }), []);
  assert.deepEqual(addItem([], { productId: low.id, colorId: "beach", size: 41 }, 0), [], "sold out");
});

test("setQty clamps to 1..max and removeItem deletes", () => {
  const lines = addItem([], { productId: low.id, colorId: "beach", size: 41 });
  const key = lines[0].key;
  assert.equal(setQty(lines, key, 0)[0].qty, 1);
  assert.equal(setQty(lines, key, "abc")[0].qty, 1);
  assert.equal(setQty(lines, key, 99, 4)[0].qty, 4);
  assert.equal(setQty(lines, key, 3, 4)[0].qty, 3);
  assert.equal(removeItem(lines, key).length, 0);
});

test("totals use catalogue prices and handle unconfirmed delivery", () => {
  let lines = addItem([], { productId: low.id, colorId: "beach", size: 41, qty: 2 });
  lines = addItem(lines, { productId: "DEMO-SA-002", colorId: "brown", size: 40, qty: 1 });
  const resolved = resolveLines(lines, PRODUCTS);
  assert.equal(resolved[0].lineTotal, 25000);
  const pending = cartTotals(resolved, null);
  assert.deepEqual(pending, { itemCount: 3, subtotal: 29900, delivery: null, total: null });
  const withFee = cartTotals(resolved, 250);
  assert.equal(withFee.total, 30150);
  assert.equal(cartTotals(resolved, 0).total, 29900);
});

test("resolveLines drops lines for unknown products, colours or sizes", () => {
  const lines = [
    { key: "x", productId: "NOPE", colorId: "a", size: 41, qty: 1 },
    { key: "y", productId: low.id, colorId: "nope", size: 41, qty: 1 },
    { key: "z", productId: low.id, colorId: "beach", size: 30, qty: 1 },
  ];
  assert.equal(resolveLines(lines, PRODUCTS).length, 0);
});

test("resolveLines flags lines whose size has since sold out", () => {
  const lines = addItem([], { productId: low.id, colorId: "beach", size: 43 }); // stock 0
  const [line] = resolveLines(lines, PRODUCTS);
  assert.equal(line.available, false);
});

test("store persists only ids and quantities, and survives a reload", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = createCartStore(storage);
  a.add({ productId: low.id, colorId: "beach", size: 41, qty: 2 });
  const saved = JSON.parse(mem.get(a.storageKey));
  assert.deepEqual(saved, { v: 1, lines: [{ productId: low.id, colorId: "beach", size: 41, qty: 2 }] });

  const b = createCartStore(storage); // "refresh"
  assert.equal(b.get().length, 1);
  assert.equal(b.get()[0].qty, 2);
});

test("store ignores corrupted storage", () => {
  const storage = { getItem: () => "{not json", setItem: () => {} };
  assert.deepEqual(createCartStore(storage).get(), []);
  const tampered = { getItem: () => JSON.stringify({ lines: [{ productId: low.id, colorId: "beach", size: 41, qty: 999 }, { bad: true }] }), setItem: () => {} };
  const lines = createCartStore(tampered).get();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, MAX_QTY_PER_LINE);
});
