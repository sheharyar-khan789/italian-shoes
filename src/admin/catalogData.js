/**
 * Admin data for the catalogue, products, stock and photos. Reads go to the server with a timeout
 * (see data.js); every write is a Cloud Function call that re-checks permission and input.
 */
import { firebase } from "../app/firebase.js";
import { callApi } from "../app/api.js";
import { withTimeout } from "./data.js";

const fs = () => import("firebase/firestore");

/** Call a server endpoint (/api/<name>); errors keep their safe message and field details. */
export function call(name, data) {
  return callApi(name, data);
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

// Sorting by TWO fields would need a composite index in the live database (the emulator doesn't check),
// so these read the (small) collection and sort here.
const byText = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
export const listCategories = async () => (await list("categories")).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || byText(a.name, b.name));
export const listBrands = () => list("brands", ["name"]);
export const listColors = () => list("colors", ["name"]);
export const listSizes = async () => (await list("sizes")).sort((a, b) => byText(a.system, b.system) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

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
 * Upload one original photo straight to Vercel Blob (with a one-time token from /api/blobUpload), then ask
 * the server to check and process it. Resolves to { status: "done" | "rejected", reason? }.
 * @param {string} productId @param {File} file @param {string} _uid @param {(pct: number) => void} onProgress
 */
export async function uploadProductImage(productId, file, _uid, onProgress) {
  const { auth } = await firebase();
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return { status: "rejected", reason: "Please sign in again." };
  const { upload } = await import("@vercel/blob/client");
  const blob = await upload(`uploads/${productId}/${crypto.randomUUID().replace(/-/g, "")}`, file, {
    access: "public",
    contentType: file.type,
    handleUploadUrl: "/api/blobUpload",
    headers: { Authorization: `Bearer ${idToken}` },
    onUploadProgress: ({ percentage }) => onProgress(Math.round(percentage)),
  });
  onProgress(100);
  try {
    await callApi("addProductImage", { productId, url: blob.url });
    return { status: "done" };
  } catch (error) {
    return { status: "rejected", reason: /** @type {Error} */ (error).message };
  }
}
