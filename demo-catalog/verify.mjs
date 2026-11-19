/**
 * Checks that the demo catalogue really is in the (emulated) database and on the storefront. Called by run.mjs; writes
 * demo-catalog/verification.json and screenshots to demo-catalog/screenshots/.
 */
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const shots = path.join(here, "screenshots");


/** Pages with many photos never reach the "load" event quickly; wait for the document instead. */
function fastGoto(pg) { const g = pg.goto.bind(pg); pg.goto = (u, o) => g(u, { waitUntil: "domcontentloaded", ...o }); return pg; }

export async function run({ BASE, owner, browser, products, results, photoHost, cdn }) {
  fs.mkdirSync(shots, { recursive: true });
  const { db } = await import("../functions/lib/admin.js");
  const report = { at: new Date().toISOString(), photoHost, firestore: {}, images: {}, storefront: {}, mobile: {}, adminEditArchive: {}, problems: [], perProduct: [] };
  const problems = report.problems;

  /* 1. Firestore (emulator): every product saved with its photo, brand, category, variants, price */
  const snap = await db.collection("products").get();
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  report.firestore.productDocuments = docs.length;
  report.firestore.expected = products.length;
  report.firestore.duplicateSlugs = docs.length - bySlug.size;
  report.firestore.duplicateNames = docs.length - new Set(docs.map((d) => d.name)).size;
  const brands = new Map((await db.collection("brands").get()).docs.map((d) => [d.id, d.data().name]));
  const categories = new Map((await db.collection("categories").get()).docs.map((d) => [d.id, d.data().name]));

  for (const p of products) {
    const d = bySlug.get(p.slug);
    const row = { slug: p.slug, name: p.name, brand: p.brand, category: p.category, sellPKR: p.sellPKR, sizes: p.sizes, checks: {} };
    report.perProduct.push(row);
    if (!d) { row.checks.saved = false; problems.push(`${p.name}: not in Firestore`); continue; }
    const vsnap = await db.collection(`products/${d.id}/variants`).get();
    const img = d.images?.[0];
    row.productId = d.id;
    row.checks.saved = true;
    row.checks.status = d.status;
    row.checks.brand = brands.get(d.brandId) === p.brand;
    row.checks.category = categories.get(d.categoryId) === p.category;
    row.checks.variants = vsnap.size === p.sizes.length;
    row.checks.priceOk = vsnap.docs.every((v) => v.data().price === p.sellPKR * 100);
    row.checks.imageProvider = img?.provider ?? null;
    row.checks.publicId = img?.publicId ?? null;
    row.imageUrls = img?.paths ?? null;
    for (const [k, v] of Object.entries(row.checks)) if (v === false) problems.push(`${p.name}: ${k} check failed`);

    /* 2. The three stored image addresses answer with a real picture (permanent URL, not blob:/data:) */
    row.checks.imageUrlsLoad = true;
    for (const w of [400, 800, 1600]) {
      const url = img?.paths?.[w];
      if (!url || /^(blob|data):/.test(url)) { row.checks.imageUrlsLoad = false; problems.push(`${p.name}: bad image address ${w}`); continue; }
      const res = await fetch(url).catch(() => null);
      if (!res?.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) { row.checks.imageUrlsLoad = false; problems.push(`${p.name}: ${url} -> ${res?.status}`); }
    }
  }
  report.images.storedInCloudinary = cdn ? cdn.state.uploads : "real account (check the Cloudinary dashboard)";
  report.images.standInStoredIds = cdn ? cdn.store.size : null;
  report.images.allPublicIdsInFolder = report.perProduct.every((r) => !r.checks.publicId || r.checks.publicId.startsWith("shoe-store/products/"));

  /* 3. Storefront, desktop: listing, each product page, sizes, price, image loaded */
  const money = (n) => n.toLocaleString("en-PK");
  const watch = async (page, bucket) => {
    page.on("pageerror", (e) => problems.push(`${bucket}: pageerror ${e.message}`));
    page.on("requestfailed", (r) => { if (r.resourceType() === "image") problems.push(`${bucket}: image failed ${r.url().slice(0, 100)}`); });
    page.on("response", (r) => { if (r.status() >= 400 && /\.(jpe?g|png|webp)|image\/upload/i.test(r.url())) problems.push(`${bucket}: ${r.status()} ${r.url().slice(0, 100)}`); });
  };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = fastGoto(await ctx.newPage());
  page.setDefaultTimeout(30000);
  await watch(page, "desktop");
  await page.goto(`${BASE}/shop`);
  await page.waitForFunction((n) => document.querySelectorAll("img[data-media]").length >= n, Math.min(products.length, 12), { timeout: 40000 }).catch(() => {});
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);
  const listing = await page.evaluate(() => ({ text: document.body.innerText, imgs: [...document.querySelectorAll("img[data-media]")].map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })) }));
  report.storefront.shopListingImages = listing.imgs.length;
  report.storefront.shopListingBrokenImages = listing.imgs.filter((i) => !i.ok).length;
  report.storefront.shopListingNamesFound = products.filter((p) => listing.text.includes(p.name)).length;
  await page.screenshot({ path: path.join(shots, "shop-desktop.png"), fullPage: false });
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, "home-desktop.png") });

  for (const row of report.perProduct) {
    if (!row.productId) continue;
    const sf = (row.storefront = {});
    await page.goto(`${BASE}/product/${row.slug}`);
    await page.waitForFunction(() => document.body.innerText.length > 200).catch(() => {});
    await page.locator("[data-gallery-main] img[data-media]").first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => { const i = document.querySelector("[data-gallery-main] img[data-media]"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }).catch(() => {});
    const view = await page.evaluate(() => { const i = document.querySelector("[data-gallery-main] img[data-media]"); return { text: document.body.innerText, img: i ? { src: i.src, ok: i.complete && i.naturalWidth > 0 } : null, sizeInputs: [...document.querySelectorAll('input[name="size"]')].length }; });
    sf.name = view.text.includes(row.name);
    sf.brand = view.text.toLowerCase().includes(row.brand.toLowerCase());
    sf.price = view.text.includes(money(row.sellPKR));
    sf.sizeCount = view.sizeInputs;
    sf.sizesOk = view.sizeInputs === row.sizes.length;
    sf.imageLoaded = Boolean(view.img?.ok);
    sf.imageIsStoredUrl = view.img?.src === row.imageUrls?.[800];
    for (const [k, v] of Object.entries(sf)) if (v === false) problems.push(`${row.name}: storefront ${k}`);
  }
  await page.goto(`${BASE}/product/${report.perProduct[0].slug}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, "product-desktop.png") });
  await ctx.close();

  /* 4. Mobile (iPhone-sized): shop + one product page: no sideways scrolling, images load */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = fastGoto(await mctx.newPage());
  m.setDefaultTimeout(30000);
  await watch(m, "mobile");
  for (const [name, url] of [["shop", `${BASE}/shop`], ["product", `${BASE}/product/${report.perProduct[0].slug}`], ["home", `${BASE}/`]]) {
    await m.goto(url);
    await m.waitForTimeout(2500);
    for (let i = 0; i < 6; i++) { await m.mouse.wheel(0, 1200); await m.waitForTimeout(200); }
    const r = await m.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, broken: [...document.querySelectorAll("img[data-media]")].filter((i) => !(i.complete && i.naturalWidth > 0)).length, imgs: document.querySelectorAll("img[data-media]").length }));
    report.mobile[name] = r;
    if (r.overflow > 1) problems.push(`mobile ${name}: sideways overflow ${r.overflow}px`);
    await m.evaluate(() => window.scrollTo(0, 0));
    await m.screenshot({ path: path.join(shots, `${name}-mobile.png`) });
  }
  await mctx.close();

  /* 5. Admin: every product opens for editing; a real edit + archive/restore on one product */
  const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const a = fastGoto(await actx.newPage());
  a.setDefaultTimeout(30000);
  await a.goto(`${BASE}/admin`);
  await a.locator("#adm-email").fill(owner.email);
  await a.locator("#adm-password").fill(owner.password);
  await a.getByRole("button", { name: "Sign in" }).click();
  await a.locator("#adm-nav").waitFor({ timeout: 30000 });
  let editable = 0;
  for (const row of report.perProduct) {
    if (!row.productId) continue;
    await a.goto(`${BASE}/admin/products/${row.productId}`);
    await a.locator("#pd-name").waitFor();
    const enabled = await a.getByRole("button", { name: "Save details" }).isEnabled().catch(() => false);
    const thumb = await a.locator("[data-photos] img").first().evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
    row.adminEditorOpens = enabled;
    row.adminPhotoShows = thumb;
    if (enabled) editable++;
    if (!thumb) problems.push(`${row.name}: admin editor photo not showing`);
  }
  report.adminEditArchive.editorsThatOpenAndCanSave = editable;
  const t = report.perProduct.find((r) => r.productId);
  if (t) {
    await a.goto(`${BASE}/admin/products/${t.productId}`);
    await a.locator("#pd-description").waitFor();
    const before = await a.locator("#pd-description").inputValue();
    await a.locator("#pd-description").fill(before + " (edited in the Admin Panel)");
    await a.getByRole("button", { name: "Save details" }).click();
    await a.waitForTimeout(2000);
    const after = (await db.doc(`products/${t.productId}`).get()).data().description;
    report.adminEditArchive.editSaved = after.endsWith("(edited in the Admin Panel)");
    await a.goto(`${BASE}/admin/products/${t.productId}`);
    await a.locator("#pd-description").waitFor();
    await a.locator("#pd-description").fill(before);
    await a.getByRole("button", { name: "Save details" }).click();
    await a.waitForTimeout(2000);
    report.adminEditArchive.editReverted = (await db.doc(`products/${t.productId}`).get()).data().description === before;
    // Archive = how the Admin Panel removes a product from the shop (there is no hard delete); then restore + republish
    await a.locator("[data-status=archived]").click();
    await a.locator("dialog[open]").getByRole("button", { name: "Archive" }).click();
    await a.locator("[data-status=draft]").waitFor();
    const p2 = await actxPage(browser, BASE, t.slug);
    report.adminEditArchive.archivedProductGoneFromShop = !p2.found;
    await a.locator("[data-status=draft]").click();
    await a.locator("dialog[open]").getByRole("button", { name: /Restore/ }).click();
    await a.locator("[data-status=published]").waitFor();
    await a.locator("[data-status=published]").click();
    await a.locator("dialog[open]").getByRole("button", { name: "Publish" }).click();
    await a.locator("[data-status=draft]").waitFor();
    const p3 = await actxPage(browser, BASE, t.slug);
    report.adminEditArchive.restoredProductBackOnShop = p3.found;
    for (const [k, v] of Object.entries(report.adminEditArchive)) if (v === false) problems.push(`admin ${k} failed`);
  }
  await actx.close();

  fs.writeFileSync(path.join(here, "verification.json"), JSON.stringify(report, null, 2));
  const bad = problems.length;
  console.log(`\nVerification: ${products.length - results.filter((r) => r.status === "FAILED").length}/${products.length} products created; ${bad} problem(s) recorded${bad ? ":\n - " + problems.slice(0, 25).join("\n - ") : "."}`);
  console.log(`Details: demo-catalog/verification.json, screenshots in demo-catalog/screenshots/`);
  return report;
}

async function actxPage(browser, BASE, slug) {
  const c = await browser.newContext();
  const p = fastGoto(await c.newPage());
  await p.goto(`${BASE}/product/${slug}`);
  await p.waitForTimeout(3000);
  const found = await p.evaluate(() => document.querySelectorAll("[data-gallery-main] img[data-media]").length > 0 && document.querySelectorAll('input[name="size"]').length > 0);
  await c.close();
  return { found };
}
