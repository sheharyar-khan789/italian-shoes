/**
 * Product photos on Cloudinary (free plan), as an alternative to Vercel Blob. The API SECRET never leaves the server.
 *
 *   1. The admin asks for an upload signature (cloudinarySignature): signed-in, products.write, rate-limited. The server
 *      signs ONLY these parameters: a fresh public_id inside shoe-store/products/{productId}/, the allowed formats and a
 *      timestamp. Cloudinary rejects an upload that was not signed for exactly that, so nobody can upload elsewhere.
 *   2. The browser uploads the file straight to Cloudinary with that signature.
 *   3. The browser tells us the public_id (addCloudinaryImage). The server does NOT trust it: it asks Cloudinary (Admin API,
 *      with the secret) what the file really is, checks its folder, format, size (≤ 5 MB) and pixel size, and only then
 *      adds it to the product's existing images array in Firestore. A file that fails the checks is deleted from Cloudinary.
 *
 * What is stored is the existing shape (`paths: { 400, 800, 1600 }`, all permanent https URLs, made by Cloudinary
 * transformations of the one original) plus `provider: "cloudinary"` and `publicId`, so the storefront, cart, orders and
 * admin show them with no other change. Deleting a photo also deletes it from Cloudinary.
 *
 * Environment (server only): CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
 * Test-only overrides: CLOUDINARY_API_BASE (default https://api.cloudinary.com), CLOUDINARY_DELIVERY_BASE (default https://res.cloudinary.com).
 */
import { createHash, randomUUID } from "node:crypto";
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { writeAudit } from "../lib/audit.js";
import { markCatalogDirty } from "./catalogSnapshot.js";
import { IMAGE_UPLOAD, PRODUCT_PHOTO } from "../shared/schemas/catalog.js";

export const CLOUDINARY_FOLDER = "shoe-store/products";
export const IMAGE_WIDTHS = [400, 800, 1600];
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_SIDE = 300;
const MAX_SIDE = 12000;

const apiBase = () => (process.env.CLOUDINARY_API_BASE || "https://api.cloudinary.com").replace(/\/+$/, "");
const deliveryBase = () => (process.env.CLOUDINARY_DELIVERY_BASE || "https://res.cloudinary.com").replace(/\/+$/, "");

/** @returns {{ cloudName: string, apiKey: string, apiSecret: string } | null} */
export function cloudinaryConfig() {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env;
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}
export const cloudinaryConfigured = () => cloudinaryConfig() !== null;

function need() {
  const c = cloudinaryConfig();
  if (!c) throw new AppError("unavailable", "Cloudinary isn't connected yet. The owner must add the Cloudinary values in Vercel (docs/CLOUDINARY.md).", { notConfigured: true });
  return c;
}

/**
 * Cloudinary's signature: the parameters (without file, api_key, cloud_name, resource_type, signature), sorted by name, joined as
 * name=value with &, then the API secret appended, SHA-1 as hex.
 * @param {Record<string, string | number>} params @param {string} secret
 */
export function signParams(params, secret) {
  const text = Object.keys(params)
    .filter((k) => !["file", "api_key", "cloud_name", "resource_type", "signature"].includes(k) && params[k] !== "" && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(text + secret).digest("hex");
}

/** Network access, replaceable in tests. */
export const cloudinaryIO = {
  /** What Cloudinary really holds for this id, or null. @param {string} publicId */
  async fetchResource(publicId) {
    const { cloudName, apiKey, apiSecret } = need();
    const res = await fetch(`${apiBase()}/v1_1/${cloudName}/resources/image/upload/${publicId.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError("unavailable", "Cloudinary couldn't be reached. Please try again.");
    return res.json();
  },
  /** @param {string} publicId */
  async destroy(publicId) {
    const { cloudName, apiKey, apiSecret } = need();
    const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
    const body = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: apiKey, signature: signParams(params, apiSecret) });
    const res = await fetch(`${apiBase()}/v1_1/${cloudName}/image/destroy`, { method: "POST", body });
    if (!res.ok) throw new Error(`Cloudinary destroy answered ${res.status}`);
  },
};

/** @param {string} publicId @param {string} productId */
const isOwnId = (publicId, productId) => publicId.startsWith(`${CLOUDINARY_FOLDER}/${productId}/`) && /^[A-Za-z0-9_/-]+$/.test(publicId) && !publicId.includes("//");

/**
 * Step 1: the signature for one upload of one photo of one product.
 * @param {{ productId: string }} input @param {string} actorUid
 */
export async function createUploadSignature({ productId }, actorUid) {
  const { cloudName, apiKey, apiSecret } = need();
  if (!PRODUCT_ID.test(productId)) throw new AppError("invalid-argument", "Invalid product.");
  const product = await db.collection("products").doc(productId).get();
  if (!product.exists) throw new AppError("not-found", "That product no longer exists.");
  if ((product.data()?.images?.length ?? 0) >= IMAGE_UPLOAD.maxPerProduct) throw new AppError("failed-precondition", `A product can have at most ${IMAGE_UPLOAD.maxPerProduct} photos.`);
  const publicId = `${CLOUDINARY_FOLDER}/${productId}/${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const params = { allowed_formats: ALLOWED_FORMATS.join(","), public_id: publicId, timestamp: Math.floor(Date.now() / 1000) };
  log.info("Cloudinary upload signed", { productId, actorUid });
  return { uploadUrl: `${apiBase()}/v1_1/${cloudName}/image/upload`, apiKey, publicId, maxBytes: PRODUCT_PHOTO.maxBytes, ...params, signature: signParams(params, apiSecret) };
}

/** The three display sizes, as permanent https URLs made from the one stored original. @param {string} cloudName @param {number} version @param {string} publicId */
export function deliveryUrls(cloudName, version, publicId) {
  return Object.fromEntries(IMAGE_WIDTHS.map((w) => [w, `${deliveryBase()}/${cloudName}/image/upload/c_limit,w_${w},f_auto,q_auto/v${version}/${publicId}`]));
}

/**
 * Step 3: check what was really uploaded, then attach it to the product.
 * @param {{ productId: string, publicId: string }} input @param {string} actorUid
 */
export async function addCloudinaryImage({ productId, publicId }, actorUid) {
  const { cloudName } = need();
  if (!PRODUCT_ID.test(productId) || !isOwnId(publicId, productId)) throw new AppError("invalid-argument", "That upload doesn't belong to this product.");
  const ref = db.collection("products").doc(productId);

  const discard = () => cloudinaryIO.destroy(publicId).catch((error) => log.warn("Couldn't delete a rejected Cloudinary upload", { error }));
  const reject = async (message) => {
    await discard();
    throw new AppError("invalid-argument", message);
  };

  const existing = await ref.get();
  if (!existing.exists) {
    await discard();
    throw new AppError("not-found", "That product no longer exists.");
  }
  // Sending the same upload again is harmless.
  const already = (existing.data()?.images ?? []).find((i) => i.publicId === publicId);
  if (already) return { imageId: already.id, existing: true };
  if ((existing.data()?.images?.length ?? 0) >= IMAGE_UPLOAD.maxPerProduct) {
    await discard();
    throw new AppError("failed-precondition", `A product can have at most ${IMAGE_UPLOAD.maxPerProduct} photos.`);
  }

  const info = await cloudinaryIO.fetchResource(publicId);
  if (!info) throw new AppError("not-found", "The uploaded photo wasn't found at Cloudinary. Please upload it again.");
  if (info.public_id !== publicId || info.type !== "upload" || info.resource_type !== "image") return reject("That upload isn't a normal photo.");
  if (!ALLOWED_FORMATS.includes(String(info.format).toLowerCase())) return reject("Use a JPEG, PNG or WebP photo.");
  if (!(info.bytes > 0) || info.bytes > PRODUCT_PHOTO.maxBytes) return reject("The photo is larger than 5 MB.");
  if (Math.min(info.width, info.height) < MIN_SIDE) return reject(`The photo is too small: at least ${MIN_SIDE} × ${MIN_SIDE} pixels.`);
  if (Math.max(info.width, info.height) > MAX_SIDE) return reject("The photo is too large in pixels.");
  const version = Number(info.version);
  if (!Number.isSafeInteger(version) || version <= 0) return reject("Cloudinary returned an unexpected answer.");
  // The delivery address we are about to store must be on Cloudinary's delivery host and in our own cloud and folder.
  const secure = String(info.secure_url ?? "");
  if (!secure.startsWith(`${deliveryBase()}/${cloudName}/image/upload/`) || !secure.includes(`/${publicId}`)) return reject("Cloudinary returned an unexpected address.");

  const imageId = randomUUID().replace(/-/g, "").slice(0, 20);
  const paths = deliveryUrls(cloudName, version, publicId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const images = snap.data()?.images ?? [];
      if (images.some((i) => i.publicId === publicId)) return;
      if (images.length >= IMAGE_UPLOAD.maxPerProduct) throw new AppError("failed-precondition", `A product can have at most ${IMAGE_UPLOAD.maxPerProduct} photos.`);
      images.push({ id: imageId, paths, width: info.width, height: info.height, alt: "", isPrimary: images.length === 0, provider: "cloudinary", publicId });
      tx.update(ref, { images, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
      markCatalogDirty(tx);
    });
  } catch (error) {
    await discard();
    throw error;
  }
  await writeAudit({ actorUid, action: "product.image_added", entityType: "product", entityId: productId, changes: { imageId, provider: "cloudinary" } });
  return { imageId, existing: false };
}

/** Delete a photo's file at Cloudinary (best effort: a failure is logged, the product keeps working). @param {string} publicId */
export async function removeCloudinaryFile(publicId) {
  if (!cloudinaryConfigured() || !publicId) return;
  await cloudinaryIO.destroy(publicId).catch((error) => log.warn("Couldn't delete a photo at Cloudinary", { error }));
}
