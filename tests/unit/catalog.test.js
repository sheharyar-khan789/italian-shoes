import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../../shared/slug.js";
import { slug, saveVariantInput, createVariantsInput, imageActionInput, saveProductInput, stockAdjustmentSchema } from "../../shared/schemas/index.js";
import { moduleForPath, subPath } from "../../src/admin/modules.js";

test("web addresses are generated safely from names", () => {
  assert.equal(slugify("Cap-Toe Oxford (Black)"), "cap-toe-oxford-black");
  assert.equal(slugify("  Café  Loafer  "), "cafe-loafer");
  assert.equal(slugify("<script>alert(1)</script>"), "script-alert-1-script");
  assert.equal(slugify("اٹالین"), "", "non-Latin names need a typed web address");
  for (const s of ["Cap-Toe Oxford (Black)", "Kids — School Shoe 2026", "a".repeat(200)]) assert.ok(slug.safeParse(slugify(s)).success, s);
});

test("admin sub-pages resolve to their module and parameters", () => {
  assert.equal(moduleForPath("/admin/products/new")?.key, "products");
  const mod = moduleForPath("/admin/products/abc123");
  assert.deepEqual(subPath("/admin/products/abc123", mod), ["abc123"]);
  assert.deepEqual(subPath("/admin/products", mod), []);
  assert.equal(moduleForPath("/admin/productsX"), null, "no prefix confusion");
});

const variant = { productId: "p1", colorId: "black", sizeId: "eu42", sku: "is-fo-1-blk-42", price: 1950000 };

test("variant input: prices in whole paisa, sale below price, SKU normalised", () => {
  const v = saveVariantInput.parse(variant);
  assert.equal(v.sku, "IS-FO-1-BLK-42");
  assert.equal(v.costPrice, null);
  assert.equal(v.isActive, true);
  assert.equal(saveVariantInput.safeParse({ ...variant, price: null }).success, false);
  assert.match(saveVariantInput.safeParse({ ...variant, price: null }).error.issues[0].message, /rupees/);
  assert.equal(saveVariantInput.safeParse({ ...variant, salePrice: 1950000 }).success, false);
  assert.equal(saveVariantInput.safeParse({ ...variant, costPrice: -1 }).success, false);
  assert.equal(saveVariantInput.safeParse({ ...variant, available: 50 }).data.available, undefined, "stock can't be set through a variant save");
});

test("bulk variant input limits", () => {
  const base = { productId: "p1", colorIds: ["a"], sizeIds: ["b"], price: 100 };
  assert.ok(createVariantsInput.safeParse(base).success);
  assert.equal(createVariantsInput.safeParse({ ...base, colorIds: [] }).success, false);
  const many = { ...base, colorIds: Array.from({ length: 10 }, (_, i) => `c${i}`), sizeIds: Array.from({ length: 21 }, (_, i) => `s${i}`) };
  assert.equal(createVariantsInput.safeParse(many).success, false, "at most 200 at once");
});

test("photo actions and product input", () => {
  assert.ok(imageActionInput.safeParse({ productId: "p1", action: "primary", imageId: "img1" }).success);
  assert.equal(imageActionInput.safeParse({ productId: "p1", action: "delete" }).success, false);
  assert.equal(imageActionInput.safeParse({ productId: "p1", action: "reorder" }).success, false);
  assert.equal(saveProductInput.parse({ name: "X Shoe", slug: "x-shoe", categoryId: "c", sku: "x1", status: "published" }).status, undefined, "status only via setProductStatus");
  assert.equal(stockAdjustmentSchema.safeParse({ productId: "p", variantId: "v", change: 3, reason: "sale" }).success, false, "sales are recorded by orders, not by hand");
});
