/**
 * Admin data access. Every read here matches a security rule (firestore.rules) and every write
 * goes through a Cloud Function, so this file can't grant more than the signed-in staff member has.
 */
import { firebase } from "../app/firebase.js";
import { callApi } from "../app/api.js";

const fs = () => import("firebase/firestore");

/**
 * Firestore keeps retrying quietly when it can't reach the server, which would leave staff looking
 * at "Loading…" forever. Every admin read gives up after this long, so the page can show an error
 * with a "Try again" button instead.
 */
export const TIMEOUT_MS = 12000;
// Admin reads use getDoc(s)FromServer: if the server can't be reached they fail visibly, instead
// of answering from the local cache (which can be empty) and wrongly showing "nothing here".
/** @template T @param {Promise<T>} promise @returns {Promise<T>} */
export function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Request timed out"), { code: "deadline-exceeded" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Live count of documents (Firestore aggregation; costs one read per 1000 docs). */
async function countOf(path, ...constraints) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getCountFromServer(f.query(f.collection(db, path), ...constraints.map((c) => c(f)))));
  return snap.data().count;
}

export const countCustomers = () => countOf("users");
export const countActiveStaff = () => countOf("staff", (f) => f.where("status", "==", "active"));

/* ───────── Settings ───────── */

export async function loadSettings() {
  const { db } = await firebase();
  const f = await fs();
  const [pub, priv] = await withTimeout(Promise.all([f.getDocFromServer(f.doc(db, "settings/public")), f.getDocFromServer(f.doc(db, "settings/private"))]));
  return { public: pub.exists() ? pub.data() : null, private: priv.exists() ? priv.data() : null };
}

/** @param {{ public: object, private: object }} settings */
export async function saveSettings(settings) {
  return /** @type {{ changed: string[] }} */ (await callApi("saveSettings", settings));
}

/* ───────── Notifications ───────── */

/**
 * Live list of the newest notifications for the permissions this person holds.
 * @param {string[]} perms
 * @param {(items: any[]) => void} onChange
 * @param {(error: unknown) => void} onError
 */
export async function watchNotifications(perms, onChange, onError) {
  if (!perms.length) {
    onChange([]);
    return () => {};
  }
  const { db } = await firebase();
  const f = await fs();
  const q = f.query(f.collection(db, "notifications"), f.where("audience", "in", perms.slice(0, 30)), f.orderBy("createdAt", "desc"), f.limit(50));
  return f.onSnapshot(q, (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
}

/** @param {string} id @param {string} uid */
export async function markRead(id, uid) {
  const { db } = await firebase();
  const f = await fs();
  await withTimeout(f.updateDoc(f.doc(db, "notifications", id), { readBy: f.arrayUnion(uid) }));
}

/* ───────── Activity log ───────── */

/**
 * @param {{ after?: any, pageSize?: number }} [opts]
 * @returns {Promise<{ items: any[], last: any, hasMore: boolean }>}
 */
export async function listActivity({ after, pageSize = 25 } = {}) {
  const { db } = await firebase();
  const f = await fs();
  const parts = [f.collection(db, "auditLogs"), f.orderBy("at", "desc"), ...(after ? [f.startAfter(after)] : []), f.limit(pageSize + 1)];
  const snap = await withTimeout(f.getDocsFromServer(f.query(.../** @type {[any, ...any[]]} */ (parts))));
  const docs = snap.docs.slice(0, pageSize);
  return { items: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs.at(-1), hasMore: snap.docs.length > pageSize };
}

/** Staff names for showing who did what in the activity log (Owner only). */
export async function staffDirectory() {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.collection(db, "staff")));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().name || d.data().email || "Staff member"]));
}
