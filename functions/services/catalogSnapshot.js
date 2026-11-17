/**
 * Pre-built public catalog. Rebuilding the shop data means reading every published product plus the
 * categories, colours and sizes (about 150 reads for 100 products), and the edge cache alone still
 * lets that happen many times a day. Instead the rebuilt result is stored in Firestore and only
 * rebuilt when something that customers see has actually changed:
 *
 *   catalogSnapshot/meta        { version, chunks, builtAt, dirtyAt, builtForDirtyAt }
 *   catalogSnapshot/v{version}-{i}   { json }   part 0: settings, home, categories, colours, sizes
 *                                               parts 1…: the published products, ≤ ~600 KB per part
 *
 * Everything that changes public data calls markCatalogDirty() (one small write, usually inside the
 * same transaction as the change). A reader that finds the snapshot current serves it for
 * 1 + (number of parts) reads. A snapshot older than SNAPSHOT_TTL_MS is rebuilt anyway, so a code
 * path that forgot to mark the catalog dirty can only leave it stale for 30 minutes, never forever.
 */
import { randomBytes } from "node:crypto";
import { db, FieldValue } from "../lib/admin.js";

export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const PART_BYTES = 600_000;

const meta = () => db.collection("catalogSnapshot").doc("meta");
const partRef = (version, i) => db.collection("catalogSnapshot").doc(`v${version}-${i}`);

/**
 * Say "the public catalog changed". Pass the transaction when the change itself is in one
 * (a blind write: it never conflicts with other transactions).
 * @param {FirebaseFirestore.Transaction} [tx]
 */
export function markCatalogDirty(tx) {
  const data = { dirtyAt: FieldValue.serverTimestamp() };
  if (tx) {
    tx.set(meta(), data, { merge: true });
    return undefined;
  }
  return meta().set(data, { merge: true });
}

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

/** The live collections, read in full. This is the expensive path the snapshot avoids. */
export async function readLiveCatalog() {
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

/** @param {any} t Firestore Timestamp or undefined */
const stamp = (t) => (t ? `${t.seconds}.${t.nanoseconds}` : "none");

/** Split the products into parts that stay well under Firestore's 1 MiB document limit. */
export function splitProducts(products, maxBytes = PART_BYTES) {
  /** @type {any[][]} */
  const parts = [];
  let current = [];
  let size = 0;
  for (const p of products) {
    const bytes = Buffer.byteLength(JSON.stringify(p));
    if (current.length && size + bytes > maxBytes) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += bytes;
  }
  if (current.length) parts.push(current);
  return parts;
}

async function readParts(version, count) {
  const snaps = await db.getAll(...Array.from({ length: count }, (_, i) => partRef(version, i)));
  if (snaps.some((s) => !s.exists)) throw new Error("snapshot part missing");
  const [head, ...rest] = snaps.map((s) => JSON.parse(s.data().json));
  return { ...head, products: rest.flat() };
}

async function rebuild(previous) {
  const dirtyAtBefore = previous?.dirtyAt ?? null;
  const live = await readLiveCatalog();
  const { products, ...head } = live;
  const parts = [head, ...splitProducts(products)];
  const version = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

  for (let i = 0; i < parts.length; i += 400) {
    const batch = db.batch();
    parts.slice(i, i + 400).forEach((part, k) => batch.set(partRef(version, i + k), { json: JSON.stringify(part) }));
    await batch.commit();
  }
  await meta().set({ version, chunks: parts.length, builtAt: FieldValue.serverTimestamp(), builtForDirtyAt: dirtyAtBefore ?? FieldValue.delete() }, { merge: true });

  // Tidy the previous version (best effort; a leftover part is harmless and is overwritten by id later).
  if (previous?.version && previous.version !== version) {
    const old = db.batch();
    for (let i = 0; i < (previous.chunks ?? 0); i++) old.delete(partRef(previous.version, i));
    await old.commit().catch(() => {});
  }
  return live;
}

/**
 * The public catalog: the stored snapshot when it is current, otherwise rebuilt (and stored) first.
 * @param {{ now?: number }} [opts]
 */
export async function loadSnapshot({ now = Date.now() } = {}) {
  const snap = await meta().get();
  const m = snap.data();
  const fresh = m?.version && m.builtAt && stamp(m.dirtyAt) === stamp(m.builtForDirtyAt) && now - m.builtAt.toMillis() < SNAPSHOT_TTL_MS;
  if (fresh) {
    try {
      return await readParts(m.version, m.chunks);
    } catch {
      /* a part was removed by a concurrent rebuild: fall through and rebuild */
    }
  }
  return rebuild(m);
}
