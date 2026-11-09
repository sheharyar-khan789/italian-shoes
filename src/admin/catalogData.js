/**
 * Admin data for the catalogue, products, stock and photos. Reads go to the server with a timeout
 * (see data.js); every write is a Cloud Function call that re-checks permission and input.
 */
import { firebase, storage } from "../app/firebase.js";
import { withTimeout } from "./data.js";

const fs = () => import("firebase/firestore");

/** Call a Cloud Function; errors keep their safe message and field details. */
export async function call(name, data) {
  const { functions } = await firebase();
  const { httpsCallable } = await import("firebase/functions");
  const res = await httpsCallable(functions, name, { timeout: 30000 })(data);
  return /** @type {any} */ (res.data);
}

/**
 * @param {string} path
 * @param {...[string, ("asc" | "desc")?]} order
 * @returns {Promise<any[]>}
 */
async function list(path, ...order) {
  const { db } = await firebase();
  const f = await fs();
  const q = order.length ? f.query(f.collection(db, path), ...order.map(([field, dir]) => f.orderBy(field, dir))) : f.collection(db, path);
  const snap = await withTimeout(f.getDocsFromServer(q));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ───────── Catalogue building blocks ───────── */

export const listCategories = () => list("categories", ["sortOrder"], ["name"]);
export const listBrands = () => list("brands", ["name"]);
export const listColors = () => list("colors", ["name"]);
export const listSizes = () => list("sizes", ["system"], ["sortOrder"]);

/* ───────── Products ───────── */

export const listProducts = () => list("products", ["updatedAt", "desc"]);

/** @returns {Promise<any | null>} */
export async function getProduct(id) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "products", id)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function listVariants(productId) {
  const rows = await list(`products/${productId}/variants`);
  return rows.sort((a, b) => String(a.colorName).localeCompare(String(b.colorName)) || (a.sizeSort ?? 0) - (b.sizeSort ?? 0));
}

/** Cost prices for a product's variants (only works with costs.read). */
export async function listVariantCosts(productId) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "variantCosts"), f.where("productId", "==", productId))));
  return Object.fromEntries(snap.docs.map((d) => [d.data().variantId, d.data().costPrice]));
}

/* ───────── Stock ───────── */

export const listInventory = () => list("inventory");

/** @returns {Promise<any[]>} */
export async function listMovements(inventoryId, max = 20) {
  const { db } = await firebase();
  const f = await fs();
  const q = f.query(f.collection(db, "stockMovements"), f.where("inventoryId", "==", inventoryId), f.orderBy("at", "desc"), f.limit(max));
  const snap = await withTimeout(f.getDocsFromServer(q));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ───────── Photos ───────── */

/**
 * Upload one original. The image function checks and processes it; we wait for its verdict in
 * uploads/{uploadId}. Resolves to { status: "done" | "rejected", reason? }.
 * @param {string} productId @param {File} file @param {string} uid @param {(pct: number) => void} onProgress
 */
export async function uploadProductImage(productId, file, uid, onProgress) {
  const st = await storage();
  const { ref, uploadBytesResumable } = await import("firebase/storage");
  const uploadId = crypto.randomUUID().replace(/-/g, "");
  const task = uploadBytesResumable(ref(st, `products/${productId}/uploads/${uploadId}`), file, {
    contentType: file.type,
    customMetadata: { uploadedBy: uid },
  });
  await new Promise((resolve, reject) => {
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, () => resolve(undefined));
  });

  const { db } = await firebase();
  const f = await fs();
  return withTimeout(
    new Promise((resolve, reject) => {
      const stop = f.onSnapshot(
        f.doc(db, "uploads", uploadId),
        (snap) => {
          if (!snap.exists()) return;
          stop();
          resolve(snap.data());
        },
        reject,
      );
    }),
    90000,
  );
}
