/**
 * Products and variants. The ONLY code that writes products, variants, cost prices and the SKU
 * registry. Stock is changed only by services/inventory.js.
 *
 * Layout:
 *   products/{productId}                      details, status, images, summary 🔒
 *   products/{productId}/variants/{colorId}_{sizeId}   one per colour × size (id makes duplicates impossible)
 *   variantCosts/{productId}__{variantId}     cost price (separate: rules can't hide single fields)
 *   inventory/{productId}__{variantId}        onHand / reserved — services/inventory.js
 *   skus/{SKU}                                registry that makes every SKU unique across the store
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

export const variantKey = (colorId, sizeId) => `${colorId}_${sizeId}`;
export const inventoryId = (productId, variantId) => `${productId}__${variantId}`;

const products = () => db.collection("products");
const variantsOf = (productId) => products().doc(productId).collection("variants");

/** The price a customer pays: the sale price when set, otherwise the regular price. */
export const effectivePrice = (v) => (v.salePrice != null && v.salePrice > 0 && v.salePrice < v.price ? v.salePrice : v.price);

/* ───────── SKU registry ───────── */

/**
 * Inside a transaction: claim `sku` for an owner, releasing `previous` if it changed.
 * Reads must happen before writes, so callers pass the registry snapshots they already read.
 */
async function readSku(tx, sku) {
  return tx.get(db.collection("skus").doc(sku));
}
function claimSku(tx, snap, owner, previousSku) {
  if (snap.exists && snap.data().owner !== owner) {
    throw new AppError("already-exists", `SKU ${snap.id} is already used by another product. Choose another.`, { fields: { sku: "Already used" } });
  }
  if (!snap.exists) tx.create(snap.ref, { owner, createdAt: FieldValue.serverTimestamp() });
  if (previousSku && previousSku !== snap.id) tx.delete(db.collection("skus").doc(previousSku));
}

/* ───────── Products ───────── */

/** @param {Record<string, any> & { id?: string }} input validated saveProductInput @param {string} actorUid */
export async function saveProduct(input, actorUid) {
  const { id, ...data } = input;
  const ref = id ? products().doc(id) : products().doc();

  await db.runTransaction(async (tx) => {
    const current = id ? await tx.get(ref) : null;
    if (id && !current.exists) throw new AppError("not-found", "That product no longer exists.");
    const [category, brand, slugClash, skuSnap] = await Promise.all([
      tx.get(db.collection("categories").doc(data.categoryId)),
      data.brandId ? tx.get(db.collection("brands").doc(data.brandId)) : null,
      tx.get(products().where("slug", "==", data.slug).limit(2)),
      readSku(tx, data.sku),
    ]);
    if (!category.exists) throw new AppError("invalid-argument", "Choose a category that exists.", { fields: { categoryId: "Not found" } });
    if (data.brandId && !brand.exists) throw new AppError("invalid-argument", "Choose a brand that exists.", { fields: { brandId: "Not found" } });
    if (slugClash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `The web address "${data.slug}" is already used.`, { fields: { slug: "Already used" } });
    claimSku(tx, skuSnap, `product:${ref.id}`, current?.data().sku);

    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (current) tx.update(ref, { ...data, ...stamp });
    else
      tx.create(ref, {
        ...data,
        status: "draft",
        images: [],
        summary: emptySummary(),
        publishedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: actorUid,
        ...stamp,
      });
    writeAudit({ actorUid, action: current ? "product.updated" : "product.created", entityType: "product", entityId: ref.id, changes: { after: data } }, tx);
  });
  await recomputeSummary(ref.id);
  return { id: ref.id };
}

const emptySummary = () => ({ stock: {}, prices: {}, regularPrices: {}, regularPrice: null, minPrice: null, maxPrice: null, onSale: false, inStock: false, totalStock: 0, variantCount: 0, colorIds: [], sizeIds: [], keywords: [] });

/**
 * Publishing needs at least one photo and one active variant, so customers never see a product
 * they can't look at or buy. Archived products disappear from the store but stay for old orders.
 * @param {string} productId @param {"draft" | "published" | "archived"} status @param {string} actorUid
 */
export async function setProductStatus(productId, status, actorUid) {
  const ref = products().doc(productId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That product no longer exists.");
    const p = snap.data();
    if (status === "published") {
      const active = await tx.get(variantsOf(productId).where("isActive", "==", true).limit(1));
      const problems = [];
      if (!p.images?.length) problems.push("add at least one photo");
      if (active.empty) problems.push("add at least one active size/colour with a price");
      if (problems.length) throw new AppError("failed-precondition", `Before publishing, ${problems.join(" and ")}.`);
    }
    tx.update(ref, {
      status,
      ...(status === "published" && !p.publishedAt ? { publishedAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    });
    writeAudit({ actorUid, action: "product.status", entityType: "product", entityId: productId, changes: { from: p.status, to: status } }, tx);
  });
  return { id: productId, status };
}

/* ───────── Variants ───────── */

/**
 * @param {Record<string, any>} input validated saveVariantInput
 * @param {{ actorUid: string, canEditCost: boolean }} ctx
 */
export async function saveVariant(input, { actorUid, canEditCost }) {
  const { productId, variantId, costPrice, ...data } = input;
  const key = variantKey(data.colorId, data.sizeId);
  if (variantId && variantId !== key) throw new AppError("invalid-argument", "Colour and size can't be changed on an existing variant. Create a new one instead.");
  const productRef = products().doc(productId);
  const ref = variantsOf(productId).doc(key);
  const invRef = db.collection("inventory").doc(inventoryId(productId, key));

  await db.runTransaction(async (tx) => {
    const [product, current, color, size, skuSnap] = await Promise.all([
      tx.get(productRef),
      tx.get(ref),
      tx.get(db.collection("colors").doc(data.colorId)),
      tx.get(db.collection("sizes").doc(data.sizeId)),
      readSku(tx, data.sku),
    ]);
    if (!product.exists) throw new AppError("not-found", "That product no longer exists.");
    if (!color.exists || !size.exists) throw new AppError("invalid-argument", "Choose a colour and size that exist.");
    if (!variantId && current.exists) throw new AppError("already-exists", `${color.data().name} / ${size.data().system} ${size.data().value} already exists for this product.`);
    claimSku(tx, skuSnap, `variant:${productId}/${key}`, current.exists ? current.data().sku : null);

    const display = { colorName: color.data().name, colorHex: color.data().hex, sizeLabel: `${size.data().system} ${size.data().value}`, sizeSort: size.data().sortOrder ?? 0 };
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (current.exists) tx.update(ref, { ...data, ...display, ...stamp });
    else {
      tx.create(ref, { ...data, ...display, available: 0, createdAt: FieldValue.serverTimestamp(), ...stamp });
      tx.create(invRef, { productId, variantId: key, onHand: 0, reserved: 0, lowStockThreshold: input.lowStockThreshold, sku: data.sku, updatedAt: FieldValue.serverTimestamp() });
    }
    if (current.exists) tx.update(invRef, { lowStockThreshold: input.lowStockThreshold, sku: data.sku });
    if (canEditCost) tx.set(db.collection("variantCosts").doc(inventoryId(productId, key)), { productId, variantId: key, costPrice, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    writeAudit({ actorUid, action: current.exists ? "variant.updated" : "variant.created", entityType: "variant", entityId: `${productId}/${key}`, changes: { after: data, costChanged: canEditCost } }, tx);
  });
  await recomputeSummary(productId);
  return { productId, variantId: key };
}

/** Make a short SKU part from a name: "Midnight Blue" → "MIDNIG" */
const skuPart = (text) => (String(text).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "X");

/**
 * Create every colour × size combination that doesn't exist yet, with generated SKUs and 0 stock.
 * @param {Record<string, any>} input validated createVariantsInput
 * @param {{ actorUid: string, canEditCost: boolean }} ctx
 */
export async function createVariants(input, ctx) {
  const product = await products().doc(input.productId).get();
  if (!product.exists) throw new AppError("not-found", "That product no longer exists.");
  const [colors, sizes, existing] = await Promise.all([
    db.getAll(...input.colorIds.map((id) => db.collection("colors").doc(id))),
    db.getAll(...input.sizeIds.map((id) => db.collection("sizes").doc(id))),
    variantsOf(input.productId).get(),
  ]);
  if (colors.some((c) => !c.exists) || sizes.some((s) => !s.exists)) throw new AppError("invalid-argument", "Some colours or sizes don't exist any more.");
  const have = new Set(existing.docs.map((d) => d.id));
  const created = [];
  const skipped = [];
  for (const c of colors) {
    for (const s of sizes) {
      const key = variantKey(c.id, s.id);
      if (have.has(key)) {
        skipped.push(key);
        continue;
      }
      let sku = `${product.data().sku}-${skuPart(c.data().name)}-${skuPart(s.data().value)}`;
      for (let n = 2; (await db.collection("skus").doc(sku).get()).exists; n++) sku = `${sku.replace(/-\d+$/, "")}-${n}`;
      await saveVariant(
        { productId: input.productId, colorId: c.id, sizeId: s.id, sku, price: input.price, salePrice: input.salePrice, costPrice: input.costPrice, isActive: true, lowStockThreshold: null },
        ctx,
      );
      created.push(key);
    }
  }
  return { created: created.length, skipped: skipped.length };
}

/* ───────── Summary (for fast storefront listing and filters) ───────── */

const words = (...parts) =>
  [...new Set(parts.join(" ").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1))].slice(0, 60);

/** Recalculate products/{id}.summary from its variants and stock. Safe to call any time. */
export async function recomputeSummary(productId) {
  const ref = products().doc(productId);
  const [snap, variants] = await Promise.all([ref.get(), variantsOf(productId).get()]);
  if (!snap.exists) return;
  const p = snap.data();
  const active = variants.docs.map((d) => d.data()).filter((v) => v.isActive);
  const prices = active.map(effectivePrice);
  const [category, brand] = await Promise.all([
    db.collection("categories").doc(p.categoryId).get(),
    p.brandId ? db.collection("brands").doc(p.brandId).get() : null,
  ]);
  const summary = {
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    onSale: active.some((v) => effectivePrice(v) < v.price),
    inStock: active.some((v) => (v.available ?? 0) > 0),
    totalStock: active.reduce((n, v) => n + (v.available ?? 0), 0),
    variantCount: active.length,
    // Public stock picture for the storefront: units available per colour and size (0 = sold out).
    stock: active.reduce((m, v) => { (m[v.colorId] ??= {})[v.sizeId] = Math.max(0, v.available ?? 0); return m; }, {}),
    // Selling price (sale price when set) and regular price per colour and size, in paisa.
    prices: active.reduce((m, v) => { (m[v.colorId] ??= {})[v.sizeId] = effectivePrice(v); return m; }, {}),
    regularPrices: active.reduce((m, v) => { (m[v.colorId] ??= {})[v.sizeId] = v.price; return m; }, {}),
    // Regular price of the cheapest variant, so the storefront can show "was" when that one is on sale.
    regularPrice: active.length ? active.reduce((best, v) => (effectivePrice(v) < effectivePrice(best) ? v : best)).price : null,
    colorIds: [...new Set(active.map((v) => v.colorId))],
    sizeIds: [...new Set(active.filter((v) => (v.available ?? 0) > 0).map((v) => v.sizeId))],
    keywords: words(p.name, p.sku, category.data()?.name ?? "", brand?.data()?.name ?? "", ...active.map((v) => v.colorName ?? "")),
  };
  await ref.update({ summary });
  return summary;
}
