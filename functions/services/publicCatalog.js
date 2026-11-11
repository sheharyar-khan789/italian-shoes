/**
 * The public shop data in one response: settings, categories, colours, sizes, PUBLISHED products and the
 * home-page layout. Same data the Firestore rules already make public; read with the Admin SDK and cached
 * at Vercel's edge (see handler.js), so visitors don't each cost database reads and the shop opens fast
 * even where a direct connection to Google is slow.
 */
import { db } from "../lib/admin.js";

/** Firestore Timestamps → ISO strings (so the result is plain JSON). */
export function plain(value) {
  if (value && typeof value === "object") {
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(plain);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** @param {FirebaseFirestore.QuerySnapshot} snap */
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));

export async function loadPublicCatalog() {
  const [settings, home, cats, cols, szs, prods] = await Promise.all([
    db.doc("settings/public").get(),
    db.doc("content/home").get(),
    db.collection("categories").get(),
    db.collection("colors").get(),
    db.collection("sizes").get(),
    db.collection("products").where("status", "==", "published").limit(300).get(),
  ]);
  return {
    settings: settings.exists ? plain(settings.data()) : {},
    home: home.exists ? plain(home.data()) : null,
    categories: rows(cats),
    colors: rows(cols),
    sizes: rows(szs),
    products: rows(prods),
  };
}
