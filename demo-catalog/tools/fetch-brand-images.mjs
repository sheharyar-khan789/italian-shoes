// For products with image.pageUrl: reads the main product image (og:image) in Chrome, downloads it, saves demo-catalog/images/<slug>.jpg
// and records where it came from in image-sources.json. These are brand/retailer images (NOT openly licensed): local demo only.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { launch } from "../../tests/e2e/helpers.js";
const root = path.resolve(import.meta.dirname, "..");
const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8")).products;
const outFile = path.join(root, "image-sources.json");
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
const b = await launch();
const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
for (const p of products) {
  if (!p.image.pageUrl || (out[p.slug] && fs.existsSync(path.join(root, "images", `${p.slug}.jpg`)))) continue;
  const page = await ctx.newPage();
  try {
    await page.goto(p.image.pageUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(4500);
    let og = await page.evaluate(() => document.querySelector('meta[property="og:image"]')?.content ?? null);
    if (!og) og = await page.evaluate(() => [...document.images].map((i) => i.currentSrc || i.src).find((u) => /static[.]nike[.]com[/]a[/]images/.test(u)) ?? null);
    if (!og) throw new Error("no og:image");
    og = og.replace(/sw=[0-9]+/, "sw=1200");
    if (og.startsWith("http://")) og = og.replace("http://", "https://");
    const res = await fetch(og, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const jpg = await sharp(Buffer.from(await res.arrayBuffer())).flatten({ background: "#ffffff" }).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    fs.writeFileSync(path.join(root, "images", `${p.slug}.jpg`), jpg);
    out[p.slug] = { file: `images/${p.slug}.jpg`, pageUrl: p.image.pageUrl, imageUrl: og, license: "Brand/retailer product image - not openly licensed; local demo only", author: p.brand, bytes: jpg.length };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`OK  ${p.slug} ${(jpg.length / 1024).toFixed(0)} KB`);
  } catch (e) { console.log(`ERR ${p.slug}: ${String(e.message).split(String.fromCharCode(10))[0]}`); }
  await page.close();
}
await b.close();
