/**
 * Product images, stored in Vercel Blob (free) instead of Firebase Storage (which needs a paid plan).
 *
 * Upload flow (staff only):
 *   1. The admin asks /api/blobUpload for a one-time upload token. authorizeBlobUpload() checks the
 *      person's Firebase ID token, their products.write permission and a rate limit, and limits the
 *      token to one product's uploads folder, image types and 8 MB.
 *   2. The browser uploads the ORIGINAL straight to Blob under uploads/{productId}/ (it never goes
 *      through a server function, so the 4.5 MB request limit doesn't apply).
 *   3. The browser then calls the addProductImage endpoint. addProductImage() downloads the original,
 *      checks the REAL file contents with sharp (not the name or declared type), writes three WebP
 *      sizes, strips metadata (camera, GPS), deletes the original and adds the photo to the product.
 *
 * Product photos are public by design (they are shown on the shop). Originals are deleted after processing.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { put, del } from "@vercel/blob";
import { auth as adminAuth, db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { writeAudit } from "../lib/audit.js";
import { markCatalogDirty } from "./catalogSnapshot.js";
import { hasPermission, assertSessionStillValid } from "../lib/callable.js";
import { consumeRateLimit } from "../lib/rateLimit.js";
import { IMAGE_UPLOAD } from "../shared/schemas/catalog.js";
import { RECEIPT_UPLOAD } from "../shared/finance.js";

export const IMAGE_WIDTHS = [400, 800, 1600];
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);
const MIN_SIDE = 300;
const MAX_SIDE = 12000;
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_SIDE = 600;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Network access, replaceable in tests. */
export const blobIO = {
  /** @param {string} url @returns {Promise<Buffer>} */
  async fetchSource(url) {
    const res = await fetch(url);
    if (!res.ok) throw new AppError("not-found", "The uploaded file wasn't found. Please upload it again.");
    if (Number(res.headers.get("content-length") ?? 0) > IMAGE_UPLOAD.maxBytes) throw new AppError("invalid-argument", "The file is larger than 8 MB.");
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > IMAGE_UPLOAD.maxBytes) throw new AppError("invalid-argument", "The file is larger than 8 MB.");
    return buffer;
  },
  /** @param {string} pathname @param {Buffer} body @returns {Promise<string>} public URL */
  async put(pathname, body) {
    const blob = await put(pathname, body, { access: "public", contentType: "image/webp", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000 });
    return blob.url;
  },
  /** @param {string | string[]} urls */
  async del(urls) {
    await del(urls);
  },
};

/* ───────── 1. Upload token ───────── */

/**
 * Decide whether this request may get a one-time upload token. Throws AppError if not.
 * @param {{ pathname: string, authorization?: string }} input
 * @param {{ verifyToken?: (t: string) => Promise<Record<string, any>> }} [deps]
 */
export async function authorizeBlobUpload({ pathname, authorization }, { verifyToken = (t) => adminAuth.verifyIdToken(t) } = {}) {
  const bearer = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
  if (!bearer) throw new AppError("unauthenticated", "Please sign in to continue.");
  /** @type {Record<string, any>} */
  let token;
  try {
    token = await verifyToken(bearer);
  } catch {
    throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
  }
  // Receipts and invoices for expenses: PDF or image, 5 MB, under receipts/{uid}/ for people who may record finance entries.
  if (pathname.startsWith("receipts/")) {
    if (!["finance.write", "purchases.manage", "suppliers.manage"].some((p) => hasPermission(token, p))) throw new AppError("permission-denied", "You don't have permission to do this.");
    await assertSessionStillValid(token.uid, token);
    await consumeRateLimit("blobUpload", token.uid, { limit: 120, windowSeconds: 600 });
    if (!pathname.startsWith(`receipts/${token.uid}/`) || !/^[A-Za-z0-9._-]{1,120}$/.test(pathname.slice(`receipts/${token.uid}/`.length))) throw new AppError("invalid-argument", "That upload location isn't allowed.");
    return { allowedContentTypes: RECEIPT_UPLOAD.types, maximumSizeInBytes: RECEIPT_UPLOAD.maxBytes, addRandomSuffix: true, tokenPayload: JSON.stringify({ uid: token.uid, kind: "receipt" }) };
  }
  // Employee documents (CNIC copies, contracts) under hr/{uid}/ and employee photos under hrphoto/{uid}/: PDF or image, 5 MB,
  // for people who may manage employees. Both go to the PRIVATE store (see api/blobUpload.js) and are never public.
  if (pathname.startsWith("hr/") || pathname.startsWith("hrphoto/")) {
    const folder = pathname.startsWith("hrphoto/") ? "hrphoto" : "hr";
    if (!(folder === "hr" ? ["hr.sensitive", "hr.write"] : ["hr.write"]).some((p) => hasPermission(token, p))) throw new AppError("permission-denied", "You don't have permission to do this.");
    await assertSessionStillValid(token.uid, token);
    await consumeRateLimit("blobUpload", token.uid, { limit: 60, windowSeconds: 600 });
    if (!pathname.startsWith(`${folder}/${token.uid}/`) || !/^[A-Za-z0-9._-]{1,120}$/.test(pathname.slice(`${folder}/${token.uid}/`.length))) throw new AppError("invalid-argument", "That upload location isn't allowed.");
    return { allowedContentTypes: RECEIPT_UPLOAD.types, maximumSizeInBytes: RECEIPT_UPLOAD.maxBytes, addRandomSuffix: true, tokenPayload: JSON.stringify({ uid: token.uid, kind: folder }) };
  }
  // The store logo: a small image under logo/{uid}/, for people who may change the store settings.
  if (pathname.startsWith("logo/")) {
    if (!hasPermission(token, "settings.manage")) throw new AppError("permission-denied", "You don't have permission to do this.");
    await assertSessionStillValid(token.uid, token);
    await consumeRateLimit("blobUpload", token.uid, { limit: 20, windowSeconds: 600 });
    if (!pathname.startsWith(`logo/${token.uid}/`) || !/^[A-Za-z0-9._-]{1,120}$/.test(pathname.slice(`logo/${token.uid}/`.length))) throw new AppError("invalid-argument", "That upload location isn't allowed.");
    return { allowedContentTypes: IMAGE_UPLOAD.types, maximumSizeInBytes: LOGO_MAX_BYTES, addRandomSuffix: true, tokenPayload: JSON.stringify({ uid: token.uid, kind: "logo" }) };
  }
  if (!hasPermission(token, "products.write")) throw new AppError("permission-denied", "You don't have permission to do this.");
  await assertSessionStillValid(token.uid, token);
  await consumeRateLimit("blobUpload", token.uid, { limit: 120, windowSeconds: 600 });

  const match = /^uploads\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9._-]{1,120}$/.exec(pathname);
  if (!match) throw new AppError("invalid-argument", "That upload location isn't allowed.");
  return {
    allowedContentTypes: IMAGE_UPLOAD.types,
    maximumSizeInBytes: IMAGE_UPLOAD.maxBytes,
    addRandomSuffix: true,
    tokenPayload: JSON.stringify({ uid: token.uid, productId: match[1] }),
  };
}

/* ───────── 2. Check, resize, store ───────── */

/**
 * Check the real contents of an upload and make the three WebP sizes (metadata removed).
 * @param {Buffer} buffer
 * @returns {Promise<{ width: number, height: number, variants: Record<number, Buffer> }>}
 */
export async function processImageBuffer(buffer) {
  if (buffer.length > IMAGE_UPLOAD.maxBytes) throw new AppError("invalid-argument", "The file is larger than 8 MB.");
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_SIDE * MAX_SIDE }).metadata();
  } catch {
    throw new AppError("invalid-argument", "This file isn't a valid image.");
  }
  if (!ALLOWED_FORMATS.has(meta.format ?? "")) throw new AppError("invalid-argument", "Use a JPEG, PNG or WebP photo.");
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (Math.min(width, height) < MIN_SIDE) throw new AppError("invalid-argument", `The photo is too small — at least ${MIN_SIDE} × ${MIN_SIDE} pixels.`);

  /** @type {Record<number, Buffer>} */
  const variants = {};
  for (const w of IMAGE_WIDTHS) {
    // rotate() applies the camera orientation; sharp drops all metadata (EXIF/GPS) by default.
    variants[w] = await sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  }
  return { width, height, variants };
}

/** The upload URL must be OUR Blob store and inside this product's uploads folder (no fetching arbitrary URLs). */
function assertOwnUploadUrl(url, productId) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new AppError("invalid-argument", "That upload link isn't valid.");
  }
  if (u.protocol !== "https:" || !BLOB_HOST.test(u.hostname) || !u.pathname.startsWith(`/uploads/${productId}/`)) {
    throw new AppError("invalid-argument", "That upload link isn't valid.");
  }
}

/**
 * Turn an uploaded original into a product photo.
 * @param {{ productId: string, url: string }} input validated
 * @param {string} actorUid
 */
export async function addProductImage({ productId, url }, actorUid) {
  if (!PRODUCT_ID.test(productId)) throw new AppError("invalid-argument", "Invalid product.");
  assertOwnUploadUrl(url, productId);

  const discard = () => blobIO.del(url).catch((error) => log.warn("Couldn't delete an upload", { error }));
  const reject = async (error) => {
    await discard();
    throw error;
  };

  const ref = db.collection("products").doc(productId);
  const product = await ref.get();
  if (!product.exists) return reject(new AppError("not-found", "That product no longer exists."));
  if ((product.data().images?.length ?? 0) >= IMAGE_UPLOAD.maxPerProduct) {
    return reject(new AppError("failed-precondition", `A product can have at most ${IMAGE_UPLOAD.maxPerProduct} photos.`));
  }

  let processed;
  try {
    processed = await processImageBuffer(await blobIO.fetchSource(url));
  } catch (error) {
    if (error instanceof AppError) return reject(error);
    log.error("Image processing failed", { productId, error });
    return reject(new AppError("invalid-argument", "The photo couldn't be processed. Please try another file."));
  }

  const imageId = randomUUID().replace(/-/g, "").slice(0, 20);
  /** @type {Record<number, string>} */
  const paths = {};
  try {
    for (const w of IMAGE_WIDTHS) paths[w] = await blobIO.put(`products/${productId}/images/${imageId}-${w}.webp`, processed.variants[w]);
  } catch (error) {
    log.error("Storing the photo failed", { productId, error });
    await blobIO.del(Object.values(paths)).catch(() => {});
    return reject(new AppError("unavailable", "The photo couldn't be saved. Please try again."));
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const images = snap.data().images ?? [];
    images.push({ id: imageId, paths, width: processed.width, height: processed.height, alt: "", isPrimary: images.length === 0 });
    tx.update(ref, { images, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    markCatalogDirty(tx);
  });
  await discard();
  await writeAudit({ actorUid, action: "product.image_added", entityType: "product", entityId: productId, changes: { imageId } });
  return { imageId };
}

/* ───────── 3. Reorder, main photo, alt text, delete ───────── */

/**
 * @param {{ productId: string, action: "reorder" | "primary" | "alt" | "delete", imageId?: string, order?: string[], alt?: string }} input validated
 * @param {string} actorUid
 */
export async function imageAction(input, actorUid) {
  const ref = db.collection("products").doc(input.productId);
  /** @type {any} */
  let removed = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That product no longer exists.");
    let images = [...(snap.data().images ?? [])];
    const find = (id) => {
      const img = images.find((i) => i.id === id);
      if (!img) throw new AppError("not-found", "That photo no longer exists.");
      return img;
    };

    if (input.action === "reorder") {
      const order = input.order ?? [];
      if (order.length !== images.length || !images.every((i) => order.includes(i.id))) throw new AppError("invalid-argument", "The photo list changed. Reload and try again.");
      images = order.map((id) => find(id));
    } else if (input.action === "primary") {
      find(input.imageId);
      images = images.map((i) => ({ ...i, isPrimary: i.id === input.imageId }));
    } else if (input.action === "alt") {
      find(input.imageId).alt = input.alt ?? "";
    } else if (input.action === "delete") {
      removed = find(input.imageId);
      images = images.filter((i) => i.id !== input.imageId);
      if (removed.isPrimary && images.length) images[0] = { ...images[0], isPrimary: true };
      if (!images.length && snap.data().status === "published") {
        throw new AppError("failed-precondition", "A published product needs at least one photo. Unpublish it first, or add another photo.");
      }
    }
    tx.update(ref, { images, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    markCatalogDirty(tx);
    writeAudit({ actorUid, action: `product.image_${input.action}`, entityType: "product", entityId: input.productId, changes: { imageId: input.imageId ?? null } }, tx);
  });
  if (removed) await blobIO.del(Object.values(removed.paths)).catch((error) => log.warn("Couldn't delete photo files", { error }));
  return { ok: true };
}

/* ───────── 4. Store logo ───────── */

/**
 * Turn an uploaded picture into the store logo: checked for real, shrunk to fit 600 × 600, converted to WebP with the
 * metadata removed, stored publicly, and the address saved in the public settings. The previous logo file is deleted.
 * @param {{ url: string }} input validated @param {string} actorUid
 */
export async function setStoreLogo({ url }, actorUid) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new AppError("invalid-argument", "That upload link isn't valid.");
  }
  if (u.protocol !== "https:" || !BLOB_HOST.test(u.hostname) || !u.pathname.startsWith(`/logo/${actorUid}/`)) throw new AppError("invalid-argument", "That upload link isn't valid.");
  const discard = () => blobIO.del(url).catch((error) => log.warn("Couldn't delete an upload", { error }));
  /** @type {Buffer} */
  let out;
  try {
    const original = await blobIO.fetchSource(url);
    if (original.length > LOGO_MAX_BYTES) throw new AppError("invalid-argument", "The logo is larger than 2 MB.");
    let meta;
    try {
      meta = await sharp(original, { limitInputPixels: MAX_SIDE * MAX_SIDE }).metadata();
    } catch {
      throw new AppError("invalid-argument", "This file isn't a valid image.");
    }
    if (!ALLOWED_FORMATS.has(meta.format ?? "")) throw new AppError("invalid-argument", "Use a JPEG, PNG or WebP picture.");
    if (Math.min(meta.width ?? 0, meta.height ?? 0) < 50) throw new AppError("invalid-argument", "The logo is too small — at least 50 × 50 pixels.");
    out = await sharp(original, { limitInputPixels: MAX_SIDE * MAX_SIDE }).rotate().resize({ width: LOGO_SIDE, height: LOGO_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch (error) {
    await discard();
    if (error instanceof AppError) throw error;
    log.error("Logo processing failed", { error });
    throw new AppError("invalid-argument", "The logo couldn't be processed. Please try another file.");
  }
  let stored;
  try {
    stored = await blobIO.put(`branding/logo-${randomUUID().replace(/-/g, "").slice(0, 16)}.webp`, out);
  } catch (error) {
    await discard();
    log.error("Storing the logo failed", { error });
    throw new AppError("unavailable", "The logo couldn't be saved. Please try again.");
  }
  const pubRef = db.collection("settings").doc("public");
  const previous = await db.runTransaction(async (tx) => {
    const snap = await tx.get(pubRef);
    tx.set(pubRef, { logoUrl: stored, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid }, { merge: true });
    markCatalogDirty(tx);
    return snap.data()?.logoUrl ?? "";
  });
  await discard();
  if (previous && previous !== stored && BLOB_HOST.test(new URL(previous).hostname) && new URL(previous).pathname.startsWith("/branding/")) await blobIO.del(previous).catch((error) => log.warn("Couldn't delete the old logo", { error }));
  await writeAudit({ actorUid, action: "settings.logo_set", entityType: "settings", entityId: "store", changes: { logoUrl: stored } });
  return { logoUrl: stored };
}

/** Remove the store logo (the file is deleted too). @param {string} actorUid */
export async function removeStoreLogo(actorUid) {
  const pubRef = db.collection("settings").doc("public");
  const previous = await db.runTransaction(async (tx) => {
    const snap = await tx.get(pubRef);
    tx.set(pubRef, { logoUrl: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid }, { merge: true });
    markCatalogDirty(tx);
    return snap.data()?.logoUrl ?? "";
  });
  if (previous) await blobIO.del(previous).catch((error) => log.warn("Couldn't delete the logo file", { error }));
  await writeAudit({ actorUid, action: "settings.logo_removed", entityType: "settings", entityId: "store", changes: {} });
  return { logoUrl: "" };
}
