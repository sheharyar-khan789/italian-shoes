/**
 * Product images.
 *
 * Upload flow (staff only — enforced by storage.rules):
 *   1. The admin uploads the original to  products/{productId}/uploads/{uploadId}
 *   2. processUpload() (Storage trigger) checks the REAL file contents with sharp — not the name or
 *      the declared type — then writes three WebP sizes to products/{productId}/images/, strips
 *      metadata (camera, GPS location), deletes the original and adds the image to the product.
 *   3. The result is written to uploads/{uploadId} so the admin screen can show "added" or why
 *      the file was rejected.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getStorage } from "firebase-admin/storage";
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { writeAudit } from "../lib/audit.js";
import { IMAGE_UPLOAD } from "../shared/schemas/catalog.js";

export const IMAGE_WIDTHS = [400, 800, 1600];
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);
const MIN_SIDE = 300;
const MAX_SIDE = 12000;
const UPLOAD_PATH = /^products\/([A-Za-z0-9_-]{1,128})\/uploads\/([A-Za-z0-9_-]{8,64})$/;

/** @param {string} uploadId @param {Record<string, unknown>} data */
const recordUpload = (uploadId, data) => db.collection("uploads").doc(uploadId).set({ ...data, finishedAt: FieldValue.serverTimestamp() }, { merge: true });

/**
 * @param {{ name: string, bucket: string, size: number | string, contentType?: string, metadata?: Record<string, string> }} object
 * @returns {Promise<{ ok: boolean, reason?: string, imageId?: string }>}
 */
export async function processUpload(object) {
  const match = UPLOAD_PATH.exec(object.name ?? "");
  if (!match) return { ok: false, reason: "ignored" }; // processed images and other files
  const [, productId, uploadId] = match;
  const bucket = getStorage().bucket(object.bucket);
  const file = bucket.file(object.name);
  const uploaderUid = object.metadata?.uploadedBy ?? null;

  const reject = async (reason) => {
    await file.delete({ ignoreNotFound: true });
    await recordUpload(uploadId, { productId, status: "rejected", reason, uploaderUid });
    return { ok: false, reason };
  };

  try {
    if (Number(object.size) > IMAGE_UPLOAD.maxBytes) return reject("The file is larger than 8 MB.");
    const product = await db.collection("products").doc(productId).get();
    if (!product.exists) return reject("That product no longer exists.");
    if ((product.data().images?.length ?? 0) >= IMAGE_UPLOAD.maxPerProduct) return reject(`A product can have at most ${IMAGE_UPLOAD.maxPerProduct} photos.`);

    const [buffer] = await file.download();
    let meta;
    try {
      meta = await sharp(buffer, { limitInputPixels: MAX_SIDE * MAX_SIDE }).metadata();
    } catch {
      return reject("This file isn't a valid image.");
    }
    if (!ALLOWED_FORMATS.has(meta.format ?? "")) return reject("Use a JPEG, PNG or WebP photo.");
    const width = meta.autoOrient?.width ?? meta.width ?? 0;
    const height = meta.autoOrient?.height ?? meta.height ?? 0;
    if (Math.min(width, height) < MIN_SIDE) return reject(`The photo is too small — at least ${MIN_SIDE} × ${MIN_SIDE} pixels.`);

    const imageId = randomUUID().replace(/-/g, "").slice(0, 20);
    const paths = {};
    for (const w of IMAGE_WIDTHS) {
      // rotate() applies the camera orientation; sharp drops all metadata (EXIF/GPS) by default.
      const out = await sharp(buffer).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      const path = `products/${productId}/images/${imageId}-${w}.webp`;
      await bucket.file(path).save(out, { contentType: "image/webp", resumable: false, metadata: { cacheControl: "public, max-age=31536000, immutable" } });
      paths[w] = path;
    }

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(product.ref);
      const images = snap.data().images ?? [];
      images.push({ id: imageId, paths, width, height, alt: "", isPrimary: images.length === 0 });
      tx.update(product.ref, { images, updatedAt: FieldValue.serverTimestamp() });
    });
    await file.delete({ ignoreNotFound: true });
    await recordUpload(uploadId, { productId, status: "done", imageId, uploaderUid });
    await writeAudit({ actorUid: uploaderUid, action: "product.image_added", entityType: "product", entityId: productId, changes: { imageId } });
    return { ok: true, imageId };
  } catch (error) {
    log.error("Image processing failed", { productId, uploadId, error });
    return reject("The photo couldn't be processed. Please try another file.");
  }
}

/**
 * Reorder, set the main photo, set alt text, or delete.
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
    writeAudit({ actorUid, action: `product.image_${input.action}`, entityType: "product", entityId: input.productId, changes: { imageId: input.imageId ?? null } }, tx);
  });
  if (removed) {
    const bucket = getStorage().bucket();
    await Promise.all(Object.values(removed.paths).map((p) => bucket.file(/** @type {string} */ (p)).delete({ ignoreNotFound: true })));
  }
  return { ok: true };
}
