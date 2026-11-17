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

/**
 * One PAGE of inventory documents (25 by default) instead of the whole collection. Filters are done by the
 * database, so each page costs about one read per row:
 *   search  by SKU prefix          filter "out" / "low"  by the stored `available` count (needs the warehouse migration for old documents)
 * @param {{ search?: string, filter?: "" | "low" | "out", threshold?: number | null, after?: any, pageSize?: number }} [opts]
 * @returns {Promise<{ rows: any[], last: any, hasMore: boolean }>}
 */
export async function listInventoryPage({ search = "", filter = "", threshold = null, after = null, pageSize = 25 } = {}) {
  const { db } = await firebase();
  const f = await fs();
  const col = f.collection(db, "inventory");
  const text = search.trim().toUpperCase();
  /** @type {any[]} */
  let parts;
  if (text) parts = [f.where("sku", ">=", text), f.where("sku", "<=", `${text}`), f.orderBy("sku")];
  else if (filter === "out") parts = [f.where("available", "<=", 0), f.orderBy("available")];
  else if (filter === "low" && threshold !== null) parts = [f.where("available", ">", 0), f.where("available", "<=", threshold), f.orderBy("available")];
  else parts = [f.orderBy(f.documentId())];
  if (after) parts.push(f.startAfter(after));
  const snap = await withTimeout(f.getDocsFromServer(f.query(col, ...parts, f.limit(pageSize + 1))));
  const docs = snap.docs.slice(0, pageSize);
  return { rows: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs[docs.length - 1] ?? null, hasMore: snap.docs.length > pageSize };
}

/** Products by id (a page of inventory needs the names of its products). @param {string[]} ids */
export async function getProductsByIds(ids) {
  const { db } = await firebase();
  const f = await fs();
  const snaps = await withTimeout(Promise.all(ids.map((id) => f.getDocFromServer(f.doc(db, "products", id)))));
  return Object.fromEntries(snaps.filter((s) => s.exists()).map((s) => [s.id, { id: s.id, ...s.data() }]));
}

/** @param {string} productId @param {string} variantId */
export async function getInventoryDoc(productId, variantId) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "inventory", `${productId}__${variantId}`)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* ───────── Warehouses and transfers ───────── */

/** Every warehouse (there are only a few). The default one first. */
export async function listWarehouses() {
  const rows = await list("warehouses");
  return rows.sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || byText(a.name, b.name));
}

/** The 50 newest transfers. */
export async function listTransfers() {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "stockTransfers"), f.orderBy("createdAt", "desc"), f.limit(50))));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** The default warehouse as the stock service sees it before its document exists. */
export const VIRTUAL_DEFAULT_WAREHOUSE = /** @type {Record<string, any>} */ ({ id: "main", name: "Main warehouse", code: "MAIN", description: "Holds all the stock that existed before warehouses were added.", address: "", isActive: true, isDefault: true, sellsOnline: true, virtual: true });

/** Run "recalculate online stock" page by page until it is finished. @param {(processed: number) => void} [onProgress] */
export async function rebuildOnlineStock(onProgress = () => {}) {
  let cursor = null;
  let processed = 0;
  do {
    const r = await call("rebuildOnlineStock", { cursor });
    processed += r.processed;
    onProgress(processed);
    cursor = r.nextCursor;
  } while (cursor);
  return processed;
}

/** @returns {Promise<any[]>} */
export async function listMovements(inventoryId, max = 20) {
  const { db } = await firebase();
  const f = await fs();
  const q = f.query(f.collection(db, "stockMovements"), f.where("inventoryId", "==", inventoryId), f.orderBy("at", "desc"), f.limit(max));
  const snap = await withTimeout(f.getDocsFromServer(q));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ───────── Photos ───────── */

/** False only when the server says the Vercel Blob store isn't connected (any other answer = assume it is). */
export async function photoStorageConnected() {
  try {
    const res = await fetch("/api/healthCheck", { cache: "no-store" });
    return (await res.json()).photoStorage !== "not-connected";
  } catch {
    return true;
  }
}

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

/**
 * Upload a picture straight to Vercel Blob (one-time token from /api/blobUpload), then ask the server to check it, shrink it
 * and make it the store logo. Resolves to { status: "done", logoUrl } or { status: "rejected", reason }.
 * @param {File} file
 */
export async function uploadStoreLogo(file) {
  const { auth } = await firebase();
  const user = auth.currentUser;
  const idToken = await user?.getIdToken();
  if (!user || !idToken) return { status: "rejected", reason: "Please sign in again." };
  if (file.size > 2 * 1024 * 1024) return { status: "rejected", reason: "The logo is larger than 2 MB." };
  const { upload } = await import("@vercel/blob/client");
  try {
    const blob = await upload(`logo/${user.uid}/${crypto.randomUUID().replace(/-/g, "")}`, file, { access: "public", contentType: file.type, handleUploadUrl: "/api/blobUpload", headers: { Authorization: `Bearer ${idToken}` } });
    const r = await callApi("setStoreLogo", { url: blob.url });
    return { status: "done", logoUrl: r.logoUrl };
  } catch (error) {
    return { status: "rejected", reason: /** @type {Error} */ (error).message };
  }
}

/** Remove the store logo. */
export const removeStoreLogo = () => callApi("removeStoreLogo", {});
