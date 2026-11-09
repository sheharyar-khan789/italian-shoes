/** Admin reads for orders (server reads with a timeout) and the order Cloud Functions. */
import { firebase } from "../app/firebase.js";
import { withTimeout } from "./data.js";
import { call } from "./catalogData.js";

const fs = () => import("firebase/firestore");
const PAGE = 25;

/**
 * @param {{ status?: string, number?: string, phone?: string, after?: any }} filters
 * @returns {Promise<{ items: any[], last: any, hasMore: boolean }>}
 */
export async function listOrders({ status, number, phone, after } = {}) {
  const { db } = await firebase();
  const f = await fs();
  /** @type {any[]} constraints, added in order */
  const parts = [];
  if (number) parts.push(f.where("number", "==", number));
  else if (phone) parts.push(f.where("customer.phone", "==", phone));
  else {
    if (status) parts.push(f.where("status", "==", status));
    parts.push(f.orderBy("createdAt", "desc"));
    if (after) parts.push(f.startAfter(after));
  }
  parts.push(f.limit(PAGE + 1));
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "orders"), ...parts)));
  const docs = snap.docs.slice(0, PAGE);
  return { items: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs.at(-1), hasMore: snap.docs.length > PAGE };
}

/** @returns {Promise<any | null>} */
export async function getOrder(id) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "orders", id)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** @returns {Promise<any[]>} */
async function sub(id, name, field, dir) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "orders", id, name), f.orderBy(field, dir))));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export const orderHistory = (id) => sub(id, "history", "at", "asc");
export const orderShipments = (id) => sub(id, "shipments", "dispatchedAt", "asc");
export const orderNotes = (id) => sub(id, "internalNotes", "createdAt", "desc");

export async function paymentOf(id) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "payments", id)));
  return snap.exists() ? snap.data() : null;
}

export { call };
