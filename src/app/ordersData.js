/** A customer's own orders. Security rules make sure they can read nothing else. */
import { firebase } from "./firebase.js";
import { callApi } from "./api.js";

const fs = () => import("firebase/firestore");
const TIMEOUT = 12000;
/** @template T @param {Promise<T>} p @returns {Promise<T>} */
const limit = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT))]);

/** @returns {Promise<any[]>} */
export async function listMyOrders(uid) {
  const { db } = await firebase();
  const f = await fs();
  const q = f.query(f.collection(db, "orders"), f.where("userId", "==", uid), f.orderBy("createdAt", "desc"), f.limit(50));
  return (await limit(f.getDocsFromServer(q))).docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @returns {Promise<{ order: any, history: any[], shipments: any[] } | null>} */
export async function getMyOrder(id) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await limit(f.getDocFromServer(f.doc(db, "orders", id)));
  if (!snap.exists()) return null;
  const sub = async (name, field) => (await limit(f.getDocsFromServer(f.query(f.collection(db, "orders", id, name), f.orderBy(field, "asc"))))).docs.map((d) => ({ id: d.id, ...d.data() }));
  const [history, shipments] = await Promise.all([sub("history", "at"), sub("shipments", "dispatchedAt")]);
  return { order: { id: snap.id, ...snap.data() }, history, shipments };
}

export async function cancelMyOrder(orderId, reason = "") {
  await callApi("cancelMyOrder", { orderId, reason });
}

/** Store details (name, address, phone) for the invoice header. */
export async function publicStoreSettings() {
  const { db } = await firebase();
  const f = await fs();
  const snap = await limit(f.getDoc(f.doc(db, "settings/public")));
  return snap.exists() ? snap.data() : {};
}
