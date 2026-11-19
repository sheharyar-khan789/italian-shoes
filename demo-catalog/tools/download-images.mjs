// Downloads the chosen openly licensed photos (Wikimedia Commons, via en.wikipedia.org's API + upload.wikimedia.org) and records licence + author.
// Usage: node demo-catalog/tools/download-images.mjs   (reads demo-catalog/products.json, writes demo-catalog/images/*.jpg and demo-catalog/image-sources.json)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
const root = path.resolve(import.meta.dirname, "..");
const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8")).products;
const H = { "User-Agent": "demo-catalog-research/1.0 (local research script)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (h) => (h ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
async function getJson(u) { for (let n = 0; n < 6; n++) { try { const t = await (await fetch(u, { headers: H })).text(); return JSON.parse(t); } catch { await sleep(15000 * (n + 1)); } } throw new Error("rate limited " + u); }
async function getBytes(u) { for (let n = 0; n < 6; n++) { try { const r = await fetch(u, { headers: H }); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch { /* retry */ } await sleep(30000 * (n + 1)); } throw new Error("download failed " + u); }
const out = {};
const outFile = path.join(root, "image-sources.json");
if (fs.existsSync(outFile)) Object.assign(out, JSON.parse(fs.readFileSync(outFile, "utf8")));
for (const p of products) {
  const dest = path.join(root, "images", `${p.slug}.jpg`);
  if (out[p.slug] && fs.existsSync(dest)) continue;
  const u = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ format: "json", action: "query", titles: p.image.title, prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: 1600 })) u.searchParams.set(k, v);
  const j = await getJson(u);
  const i = Object.values(j.query.pages)[0].imageinfo?.[0];
  if (!i) throw new Error("no imageinfo for " + p.image.title);
  const m = i.extmetadata ?? {};
  const bytes = await getBytes(i.thumburl ?? i.url);
  const img = sharp(bytes).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
  const jpg = await img.jpeg({ quality: 86 }).toBuffer();
  fs.writeFileSync(dest, jpg);
  out[p.slug] = { file: `images/${p.slug}.jpg`, commonsTitle: p.image.title, pageUrl: i.descriptionurl, originalSize: `${i.width}x${i.height}`, license: m.LicenseShortName?.value ?? "?", licenseUrl: m.LicenseUrl?.value ?? null, author: text(m.Artist?.value), bytes: jpg.length, note: "Resized to max 1600 px and re-encoded as JPEG; otherwise unmodified." };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`${p.slug}: ${out[p.slug].license} | ${out[p.slug].author.slice(0, 40)} | ${(jpg.length / 1024).toFixed(0)} KB`);
  await sleep(20000);
}
