/**
 * The storefront's data, read from Firestore (public, rules-protected collections only):
 * store settings, categories, colours, sizes, PUBLISHED products, and owner-written content.
 *
 * Nothing is invented here. An empty database gives an empty shop, and a failed load gives an
 * error the views show with a retry button; it never falls back to sample products.
 *
 * Products are converted to the shape the storefront views use:
 *   { id, slug, name, category, price, compareAt, priceMax, added, featured, isNewArrival, style,
 *     description, details, rating, sizes:[{id,label}],
 *     colors:[{ id, name, family, hex, sole, images:[url], stock:{ [sizeId]: unitsAvailable },
 *              prices:{ [sizeId]: sellingPrice }, regularPrices:{ [sizeId]: regularPrice } }] }
 * Prices are rupees here (the database holds paisa).
 */
import { firebase, imageUrl } from "../app/firebase.js";
import { toProduct as convert } from "./product.js";

const toProduct = (id, d, refs) => convert(id, d, refs, imageUrl);

const fs = () => import("firebase/firestore");
const TIMEOUT_MS = 12000;
/** @template T @param {Promise<T>} p @returns {Promise<T>} */
const limit = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS))]);


/** One round of public reads. Rejects when the database can't be reached. */
export async function loadStore() {
  const { db } = await firebase();
  const f = await fs();
  const col = (name, ...c) => f.query(f.collection(db, name), ...c);
  const [settings, cats, cols, szs, prods, home] = await limit(
    Promise.all([
      f.getDoc(f.doc(db, "settings", "public")),
      f.getDocs(col("categories")),
      f.getDocs(col("colors")),
      f.getDocs(col("sizes")),
      f.getDocs(col("products", f.where("status", "==", "published"), f.limit(300))),
      f.getDoc(f.doc(db, "content", "home")),
    ]),
  );
  const colors = new Map(cols.docs.map((d) => [d.id, d.data()]));
  const sizes = new Map(szs.docs.map((d) => [d.id, d.data()]));
  const categories = cats.docs
    .map((d) => ({ id: d.id, slug: d.data().slug, name: d.data().name, blurb: d.data().description ?? "", parentId: d.data().parentId ?? null, isActive: d.data().isActive !== false, sortOrder: d.data().sortOrder ?? 0 }))
    .filter((c) => c.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const products = prods.docs.map((d) => toProduct(d.id, d.data(), { colors, sizes })).filter((p) => p.slug && p.colors.length);
  const colorFamilies = [...colors.entries()].map(([id, c]) => ({ id, name: c.name, hex: c.hex }));
  return { settings: settings.exists() ? settings.data() : {}, categories, products, colorFamilies, home: home.exists() ? home.data() : null };
}

/* ───────── Owner-written content ───────── */

/** @returns {Promise<any[]>} */
const list = async (name, ...constraints) => {
  const { db } = await firebase();
  const f = await fs();
  return (await limit(f.getDocs(f.query(f.collection(db, name), ...constraints)))).docs.map((d) => ({ id: d.id, ...d.data() }));
};

export async function loadBanners() {
  const f = await fs();
  return (await list("banners", f.where("isActive", "==", true))).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
export async function loadFaqs() {
  const f = await fs();
  return (await list("faqs", f.where("isActive", "==", true))).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
/** A published page, or null. */
export async function loadPage(slug) {
  const { db } = await firebase();
  const f = await fs();
  const snap = await limit(f.getDoc(f.doc(db, "pages", slug)));
  return snap.exists() && snap.data().isPublished === true ? { slug, ...snap.data() } : null;
}

/** Approved reviews of a product, newest first. */
export async function loadReviews(productId) {
  const f = await fs();
  return list("reviews", f.where("productId", "==", productId), f.where("status", "==", "approved"), f.orderBy("createdAt", "desc"), f.limit(20));
}

/** Send a review (the server checks the customer received the product). */
export async function submitReview(input) {
  const { functions } = await firebase();
  const { httpsCallable } = await import("firebase/functions");
  return (await httpsCallable(functions, "submitReview", { timeout: 30000 })(input)).data;
}

/* ───────── Wishlist (private to the signed-in customer) ───────── */

export async function loadWishlist(uid) {
  const { db } = await firebase();
  const f = await fs();
  return (await limit(f.getDocs(f.collection(db, "users", uid, "wishlist")))).docs.map((d) => d.id);
}
/** @returns {Promise<boolean>} true when the product is now on the wishlist */
export async function toggleWishlist(uid, productId, on) {
  const { db } = await firebase();
  const f = await fs();
  const ref = f.doc(db, "users", uid, "wishlist", productId);
  if (on) await f.setDoc(ref, { productId, createdAt: f.serverTimestamp() });
  else await f.deleteDoc(ref);
  return on;
}
