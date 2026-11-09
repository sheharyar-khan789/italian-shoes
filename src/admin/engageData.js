/** Admin reads for coupons, reviews, customers, content, staff and reports (server reads with a timeout). */
import { firebase } from "../app/firebase.js";
import { withTimeout } from "./data.js";
import { call } from "./catalogData.js";

const fs = () => import("firebase/firestore");
const PAGE = 25;

/**
 * Run a query built from firestore helpers. `build(f)` returns the constraints.
 * @param {string} path @param {(f: any) => any[]} build
 * @returns {Promise<{ items: any[], last: any, hasMore: boolean }>}
 */
async function page(path, build, pageSize = PAGE) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocsFromServer(f.query(f.collection(db, path), ...build(f), f.limit(pageSize + 1))));
  const docs = snap.docs.slice(0, pageSize);
  return { items: docs.map((d) => ({ id: d.id, ...d.data() })), last: docs.at(-1), hasMore: snap.docs.length > pageSize };
}

/** @returns {Promise<any[]>} */
async function all(path, ...order) {
  const { db } = await firebase();
  const f = await fs();
  const parts = order.map(([field, dir]) => f.orderBy(field, dir ?? "asc"));
  return (await withTimeout(f.getDocsFromServer(f.query(f.collection(db, path), ...parts)))).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export const listCoupons = () => all("coupons");
export const listBanners = () => all("banners", ["sortOrder"]);
export const listFaqs = () => all("faqs", ["sortOrder"]);
export const listPages = () => all("pages");
export const listRoles = () => all("roles");
export const listStaff = () => all("staff");

export async function homeContent() {
  const { db } = await firebase();
  const f = await fs();
  const snap = await withTimeout(f.getDocFromServer(f.doc(db, "content", "home")));
  return snap.exists() ? snap.data() : null;
}

/** @param {{ status?: string, after?: any }} [o] */
export const listReviews = ({ status, after } = {}) =>
  page("reviews", (f) => [...(status ? [f.where("status", "==", status)] : []), f.orderBy("createdAt", "desc"), ...(after ? [f.startAfter(after)] : [])]);

/**
 * Customers, newest first. A search matches the start of the email address.
 * @param {{ search?: string, after?: any }} [o]
 */
export function listCustomers({ search = "", after } = {}) {
  const s = search.trim().toLowerCase();
  return page("users", (f) =>
    s
      ? [f.where("email", ">=", s), f.where("email", "<=", `${s}`), f.orderBy("email"), ...(after ? [f.startAfter(after)] : [])]
      : [f.orderBy("createdAt", "desc"), ...(after ? [f.startAfter(after)] : [])],
  );
}

/** A customer's orders (needs orders.read; callers check first). */
export const customerOrders = (uid) => page("orders", (f) => [f.where("userId", "==", uid), f.orderBy("createdAt", "desc")], 10);

export const productNames = async () => Object.fromEntries((await all("products")).map((p) => [p.id, p.name]));

export { call };
