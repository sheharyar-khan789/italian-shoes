import { z } from "zod";
import { docId, slug, paisa, pricePaisa, text, longText, optionalText, hexColor } from "./common.js";

export const PRODUCT_STATUSES = /** @type {const} */ (["draft", "published", "archived"]);

export const sku = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().min(1, "Required").max(64).regex(/^[A-Z0-9][A-Z0-9._-]*$/, "Letters, numbers, dot, dash or underscore"));

export const categorySchema = z.object({
  name: text(1, 80),
  slug,
  parentId: docId.nullable().default(null),
  description: longText(1000).default(""),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  isActive: z.boolean().default(true),
});

export const brandSchema = z.object({ name: text(1, 80), slug });

export const colorSchema = z.object({ name: text(1, 40), hex: hexColor });

export const sizeSchema = z.object({
  system: z.enum(["EU", "UK", "US", "PK"]).default("EU"),
  value: text(1, 10),
  sortOrder: z.number().int().min(0).max(100000).default(0),
});

export const productSchema = z.object({
  name: text(1, 120),
  slug,
  description: longText(5000).default(""),
  categoryId: docId,
  brandId: docId.nullable().default(null),
  sku,
  status: z.enum(PRODUCT_STATUSES).default("draft"),
  isFeatured: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  seoTitle: optionalText(70),
  seoDescription: optionalText(160),
});

export const variantSchema = z
  .object({
    colorId: docId,
    sizeId: docId,
    sku,
    price: pricePaisa,
    salePrice: paisa.nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.salePrice === null || (v.salePrice > 0 && v.salePrice < v.price), {
    message: "Sale price must be above zero and lower than the regular price",
    path: ["salePrice"],
  });

/** Cost price lives in a separate, permission-restricted collection. */
export const variantCostSchema = z.object({ costPrice: paisa.nullable() });

export const STOCK_REASONS = /** @type {const} */ (["initial", "adjustment", "correction", "damaged", "found"]);

/** Manual stock change by staff. Sales, cancellations and returns are written by the order service. */
export const stockAdjustmentSchema = z
  .object({
    productId: docId,
    variantId: docId,
    change: z.number().int().refine((n) => n !== 0, "Change cannot be zero").refine((n) => Math.abs(n) <= 100000, "Too large"),
    reason: z.enum(STOCK_REASONS),
    note: optionalText(300),
  })
  .refine((a) => a.reason === "initial" || a.note.length >= 3, {
    message: "Please give a reason for this adjustment",
    path: ["note"],
  });

/* ───────── Inputs for the catalogue Cloud Functions (Phase 5) ───────── */

const withId = (schema) => schema.extend({ id: docId.optional() });

export const saveCategoryInput = withId(categorySchema);
export const saveBrandInput = withId(brandSchema);
export const saveColorInput = withId(colorSchema);
export const saveSizeInput = withId(sizeSchema);

/** Product details. Status changes go through setProductStatus (with publish checks). */
export const saveProductInput = withId(productSchema.omit({ status: true }));

export const setProductStatusInput = z.object({ productId: docId, status: z.enum(PRODUCT_STATUSES) });

const nullablePaisa = paisa.nullable().default(null);

export const saveVariantInput = z
  .object({
    productId: docId,
    variantId: docId.optional(),
    colorId: docId,
    sizeId: docId,
    sku,
    price: pricePaisa,
    salePrice: nullablePaisa,
    isActive: z.boolean().default(true),
    /** Only applied when the caller holds costs.read; ignored otherwise. */
    costPrice: nullablePaisa,
    /** Per-variant override of the store's low-stock level. */
    lowStockThreshold: z.number().int().min(0).max(1000).nullable().default(null),
  })
  .refine((v) => v.salePrice === null || (v.salePrice > 0 && v.salePrice < v.price), {
    message: "Sale price must be above zero and lower than the regular price",
    path: ["salePrice"],
  });

/** Create one variant per colour × size, all at the same price. Stock starts at 0. */
export const createVariantsInput = z
  .object({
    productId: docId,
    colorIds: z.array(docId).min(1, "Choose at least one colour").max(20),
    sizeIds: z.array(docId).min(1, "Choose at least one size").max(30),
    price: pricePaisa,
    salePrice: nullablePaisa,
    costPrice: nullablePaisa,
  })
  .refine((v) => v.salePrice === null || (v.salePrice > 0 && v.salePrice < v.price), {
    message: "Sale price must be above zero and lower than the regular price",
    path: ["salePrice"],
  })
  .refine((v) => v.colorIds.length * v.sizeIds.length <= 200, { message: "At most 200 variants at a time", path: ["sizeIds"] });

export const IMAGE_ACTIONS = /** @type {const} */ (["reorder", "primary", "alt", "delete"]);

export const imageActionInput = z
  .object({
    productId: docId,
    action: z.enum(IMAGE_ACTIONS),
    imageId: docId.optional(),
    order: z.array(docId).max(20).optional(),
    alt: optionalText(160),
  })
  .refine((v) => (v.action === "reorder" ? Boolean(v.order?.length) : Boolean(v.imageId)), { message: "Missing image", path: ["imageId"] });

export const deleteCatalogItemInput = z.object({ kind: z.enum(["category", "brand", "color", "size"]), id: docId });

/** Accepted upload types and size (checked in storage.rules and again by the image function). */
export const IMAGE_UPLOAD = { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 8 * 1024 * 1024, maxPerProduct: 12 };
