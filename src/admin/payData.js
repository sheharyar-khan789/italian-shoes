/** Admin reads for payments and delivery setup (server reads with a timeout) + their functions. */
import { firebase } from "../app/firebase.js";
import { withTimeout } from "./data.js";
import { call } from "./catalogData.js";

const fs = () => import("firebase/firestore");
const PAGE = 25;

/**
 * @param {{ status?: string, after?: any }} [opts]
 * @returns {Promise<{ items: any[], last: any, hasMore: boolean }>}
 */
export async function listPayments({ status, after } = {}) {
  const { db } = await firebase();
  const f = await fs();
  /** @type {any[]} */
  const parts = [];
  if (status) parts.push(f.where("status", "==", status));
  parts.push(f.orderBy("createdAt", "desc"));
  if (after) parts.push(f.startAfter(after));
  parts.push(f.limit(PAGE + 1));
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "payments"), ...parts)));
  const docs = snap.docs.slice(0, PAGE);
  return { items: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs.at(-1), hasMore: snap.docs.length > PAGE };
}

/** Number of payments and total paisa still to collect (status "pending"). */
export async function pendingCash() {
  const { db } = await firebase();
  const f = await fs();
  const q = f.query(f.collection(db, "payments"), f.where("status", "==", "pending"));
  const snap = await withTimeout(f.getAggregateFromServer(q, { count: f.count(), total: f.sum("amount") }));
  return { count: snap.data().count, total: snap.data().total ?? 0 };
}

/** @returns {Promise<any[]>} */
export async function paymentTransactions(orderId) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, "payments", orderId, "transactions"), f.orderBy("at", "asc"))));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @returns {Promise<{ isEnabled: boolean }>} Cash on Delivery is on unless an owner turned it off. */
export async function codSetting() {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "paymentMethods", "cod")));
  return { isEnabled: snap.exists() ? snap.data().isEnabled !== false : true };
}

/** @returns {Promise<any[]>} */
async function list(path) {
  const { db } = await firebase();
  const f = await fs();
  return (await withTimeout(f.getDocsFromServer(f.collection(db, path)))).docs.map((d) => ({ id: d.id, ...d.data() }));
}
export const listShippingMethods = () => list("shippingMethods");
export const listShippingRates = () => list("shippingRates");

export { call };
