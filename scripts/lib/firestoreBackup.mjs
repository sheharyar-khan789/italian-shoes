/**
 * Firestore export / import that works on the free plan (no managed backups needed).
 *
 * exportAll(db, outDir)  -> writes one NDJSON file per top-level collection (sub-collections included),
 *                           plus manifest.json with document counts and a SHA-256 of every file.
 * verifyBackup(dir)      -> re-hashes every file against the manifest.
 * importAll(db, dir)     -> writes the documents back. By default it never overwrites an existing document.
 *
 * Values are stored in a tagged JSON form so nothing is lost on the way: timestamps, geo points, document
 * references and bytes round-trip exactly. One limit of JSON: a whole-number double (5.0) comes back as the
 * integer 5 — the Admin SDK cannot tell them apart when reading. This app stores money as integer paisa.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Timestamp, GeoPoint, DocumentReference, FieldPath } from "firebase-admin/firestore";

const TAG = "__t";
const PAGE = 400;
const POOL = 12;

/** @param {unknown} v @returns {unknown} */
export function encode(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return { [TAG]: "ts", s: v.seconds, n: v.nanoseconds };
  if (v instanceof GeoPoint) return { [TAG]: "geo", lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return { [TAG]: "ref", path: v.path };
  if (v instanceof Uint8Array) return { [TAG]: "bytes", b64: Buffer.from(v).toString("base64") };
  if (typeof v === "number" && !Number.isFinite(v)) return { [TAG]: "num", v: String(v) };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    const out = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, encode(x)]));
    return TAG in o ? { [TAG]: "map", v: out } : out;
  }
  return v;
}

/** @param {unknown} v @param {import("firebase-admin/firestore").Firestore} db @returns {unknown} */
export function decode(v, db) {
  if (Array.isArray(v)) return v.map((x) => decode(x, db));
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, any>} */ (v);
    switch (o[TAG]) {
      case "ts": return new Timestamp(o.s, o.n);
      case "geo": return new GeoPoint(o.lat, o.lng);
      case "ref": return db.doc(o.path);
      case "bytes": return Buffer.from(o.b64, "base64");
      case "num": return Number(o.v);
      case "map": return Object.fromEntries(Object.entries(o.v).map(([k, x]) => [k, decode(x, db)]));
      default: return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x, db)]));
    }
  }
  return v;
}

/** Run an async function over items, a few at a time. */
async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} outDir must not exist yet (a backup is never merged into another one)
 * @param {{ projectId?: string }} [meta]
 */
export async function exportAll(db, outDir, meta = {}) {
  if (fs.existsSync(outDir)) throw new Error(`Output folder already exists: ${outDir}`);
  fs.mkdirSync(path.join(outDir, "data"), { recursive: true });
  const counts = {};
  const files = {};

  /** Write one collection (and everything below it) to its file. */
  async function dumpCollection(col, stream) {
    let last = null;
    for (;;) {
      let q = col.orderBy(FieldPath.documentId()).limit(PAGE);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) stream.write(JSON.stringify({ path: d.ref.path, data: encode(d.data()) }) + "\n");
      counts[col.path.split("/")[0]] = (counts[col.path.split("/")[0]] ?? 0) + snap.size;
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < PAGE) break;
    }
    // Sub-collections exist under documents, including "ghost" parents that have no fields of their own.
    const refs = await col.listDocuments();
    await pool(refs, async (ref) => {
      for (const sub of await ref.listCollections()) await dumpCollection(sub, stream);
    });
  }

  for (const col of await db.listCollections()) {
    const file = path.join(outDir, "data", `${col.id}.ndjson`);
    const stream = fs.createWriteStream(file);
    await dumpCollection(col, stream);
    await new Promise((res, rej) => stream.end((e) => (e ? rej(e) : res(undefined))));
    files[`data/${col.id}.ndjson`] = sha256(file);
    counts[col.id] ??= 0;
  }
  const manifest = { format: 1, projectId: meta.projectId ?? null, createdAt: new Date().toISOString(), counts, files, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** @param {string} dir @returns {{ ok: boolean, problems: string[], manifest: any }} */
export function verifyBackup(dir) {
  const problems = [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return { ok: false, problems: ["manifest.json is missing or unreadable"], manifest }; }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) problems.push(`missing file ${rel}`);
    else if (sha256(f) !== hash) problems.push(`checksum mismatch ${rel}`);
  }
  for (const [col, n] of Object.entries(manifest.counts)) {
    const f = path.join(dir, "data", `${col}.ndjson`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;
    if (lines !== n) problems.push(`${col}: manifest says ${n} documents, file has ${lines}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} dir
 * @param {{ overwrite?: boolean }} [opts]
 */
export async function importAll(db, dir, opts = {}) {
  const check = verifyBackup(dir);
  if (!check.ok) throw new Error(`Backup failed verification: ${check.problems.join("; ")}`);
  const writer = db.bulkWriter();
  let written = 0;
  let skipped = 0;
  const errors = [];
  for (const rel of Object.keys(check.manifest.files)) {
    for (const line of fs.readFileSync(path.join(dir, rel), "utf8").split("\n")) {
      if (!line) continue;
      const { path: p, data } = JSON.parse(line);
      const ref = db.doc(p);
      const value = /** @type {Record<string, unknown>} */ (decode(data, db));
      const op = opts.overwrite ? writer.set(ref, value) : writer.create(ref, value);
      op.then(() => { written += 1; }, (e) => { if (!opts.overwrite && e.code === 6) skipped += 1; else errors.push(`${p}: ${e.message}`); });
    }
  }
  await writer.close();
  if (errors.length) throw new Error(`${errors.length} document(s) failed, first: ${errors[0]}`);
  return { written, skipped };
}
