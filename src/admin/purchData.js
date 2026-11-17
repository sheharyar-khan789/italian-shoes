/**
 * Admin data access for suppliers and purchasing. Reads go straight to Firestore (security rules allow only
 * `purchases.read`) and are always ONE PAGE at a time with a timeout, so a list never loads a whole collection.
 * Every change is a server call that re-checks permission and input.
 */
import { firebase } from "../app/firebase.js";
import { callApi } from "../app/api.js";
import { withTimeout } from "./data.js";

const fs = () => import("firebase/firestore");

export const call = (name, data) => callApi(name, data);

/**
 * One page of a collection.
 * @param {string} path
 * @param {{ where?: [string, any, any][], orderBy?: [string, "asc" | "desc"], after?: any, size?: number }} [opts]
 * @returns {Promise<{ rows: any[], last: any, hasMore: boolean }>}
 */
export async function pageOf(path, { where = [], orderBy = ["createdAt", "desc"], after = null, size = 25 } = {}) {
  const { db } = await firebase();
  const f = await fs();
  /** @type {any[]} */
  const parts = [...where.map(([field, op, value]) => f.where(field, op, value)), f.orderBy(orderBy[0], orderBy[1])];
  if (after) parts.push(f.startAfter(after));
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, path), ...parts, f.limit(size + 1))));
  const docs = snap.docs.slice(0, size);
  return { rows: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs[docs.length - 1] ?? null, hasMore: snap.docs.length > size };
}

/** @param {string} path @param {string} id @returns {Promise<any | null>} */
export async function getRow(path, id) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, path, id)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

let supplierCache = null;
/** All suppliers by name (a store has few; up to 200), for pickers. Cached for the session; pass true to refresh. */
export async function listSuppliers(refresh = false) {
  if (!supplierCache || refresh) supplierCache = (await pageOf("suppliers", { orderBy: ["name", "asc"], size: 200 })).rows;
  return supplierCache;
}
export const forgetSuppliers = () => {
  supplierCache = null;
};
