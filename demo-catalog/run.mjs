/**
 * Populates the LOCAL EMULATORS with the demo catalogue by driving the REAL Admin Panel in Chrome (nothing is written to
 * Firestore behind the Admin Panel's back, nothing touches production).
 *
 *   node scripts/emulators.mjs exec "node demo-catalog/run.mjs"            run, verify, print the report data, stop
 *   node scripts/emulators.mjs exec "node demo-catalog/run.mjs --hold"     ... and then keep the site up at http://localhost:5183 until Ctrl+C
 *   add  --limit 3  to try only the first 3 products
 *
 * Photos go through the real Cloudinary code path against a local stand-in (tests/e2e/cloudinaryStandIn.mjs) unless you have
 * set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET yourself (then they really go to your Cloudinary account -
 * only do that on purpose). Needs `npm run build:e2e` once (done automatically when dist-e2e is missing).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const here = import.meta.dirname;
const args = process.argv.slice(2);
const hold = args.includes("--hold");
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const PORT = 5183;
const BASE = `http://localhost:${PORT}`;
const PROJECT = "demo-italianshoes";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("Run it through the emulators: node scripts/emulators.mjs exec \"node demo-catalog/run.mjs\"");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(path.join(here, "products.json"), "utf8"));
const sources = JSON.parse(fs.readFileSync(path.join(here, "image-sources.json"), "utf8"));
const products = data.products.slice(0, limit);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.includes("--rebuild") || !fs.existsSync(path.join(root, "dist-e2e", "sw.js"))) {
  console.log("Building the local bundle …");
  const b = spawnSync(npm, ["run", "build:e2e"], { cwd: root, stdio: "inherit", shell: true });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

/* ── Cloudinary: the local stand-in unless real variables are present ── */
let cdn = null;
const realCloudinary = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET && !process.env.CLOUDINARY_API_BASE);
if (!realCloudinary) {
  const cfg = { cloudName: "demo-cloud", apiKey: "100200300", apiSecret: "demo-secret-" + randomBytes(6).toString("hex"), port: 5184 };
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: cfg.cloudName, CLOUDINARY_API_KEY: cfg.apiKey, CLOUDINARY_API_SECRET: cfg.apiSecret, CLOUDINARY_API_BASE: `http://localhost:${cfg.port}`, CLOUDINARY_DELIVERY_BASE: `http://localhost:${cfg.port}` });
  const { startCloudinaryStandIn } = await import("../tests/e2e/cloudinaryStandIn.mjs");
  cdn = await startCloudinaryStandIn(cfg);
}
const photoHost = realCloudinary ? "Cloudinary (your account)" : "local Cloudinary stand-in (tests/e2e/cloudinaryStandIn.mjs)";

/* ── Empty emulators + the minimum a store needs: roles, an Owner, store settings, accounting ── */
process.env.GCLOUD_PROJECT = PROJECT;
const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
const auHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
await fetch(`http://${fsHost}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
await fetch(`http://${auHost}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
await promisify(execFile)(process.execPath, [path.join(root, "functions/scripts/migrate.mjs")], { env: { ...process.env, GCLOUD_PROJECT: PROJECT } });
const { auth, db } = await import("../functions/lib/admin.js");
const staff = await import("../functions/services/staff.js");
const pos = await import("../functions/services/pos.js");
const accounting = await import("../functions/services/accounting.js");
const owner = { email: "demo-owner@example.test", password: `Aa1-${randomBytes(9).toString("base64url")}` };
const u = await auth.createUser({ email: owner.email, password: owner.password, displayName: "Demo Owner", emailVerified: true });
await staff.setStaffRoles({ uid: u.uid, roles: ["owner"], actorUid: u.uid });
await pos.createPosRoles(u.uid);
await db.doc("settings/public").set({ storeName: "Italian Shoes", phone: "0300 0000000", address: "Demo address", isOpen: true, currency: "PKR" });
await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 2, notifyLowStock: true, taxEnabled: false });
await accounting.initializeAccounting(u.uid);
fs.writeFileSync(path.join(here, ".local-login.txt"), `Local demo Owner (emulator only, new password every run)\nemail: ${owner.email}\npassword: ${owner.password}\n`);

/* ── The app, served from the built bundle with its /api ── */
const server = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "preview", "--mode", "e2e", "--outDir", "dist-e2e", "--port", String(PORT), "--strictPort"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => {
  try { server.kill(); } catch { /* gone */ }
  try { cdn?.stop(); } catch { /* gone */ }
};
process.on("exit", stop);
for (let i = 0, up = false; i < 60 && !up; i++) {
  try { up = (await fetch(`${BASE}/api/healthCheck`)).ok; } catch { await sleep(500); }
  if (i === 59 && !up) { console.error("The app did not start:\n" + serverLog); process.exit(1); }
}

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const _goto = page.goto.bind(page);
page.goto = (u, o) => _goto(u, { waitUntil: "domcontentloaded", ...o });
page.setDefaultTimeout(30000);
const log = [];
const note = (m) => { log.push(m); console.log(m); };

async function signIn() {
  await page.goto(`${BASE}/admin`);
  await page.locator("#adm-email").fill(owner.email);
  await page.locator("#adm-password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("#adm-nav").waitFor({ timeout: 30000 });
}

/** One entry of Categories & Sizes through its own form. */
async function addCatalogItem(tab, expectText, fill) {
  // Switching tabs reloads and redraws the panel asynchronously, so only click when we are not already on that tab.
  if ((await page.locator(`#tab-${tab}`).getAttribute("aria-selected")) !== "true") { await page.locator(`#tab-${tab}`).click(); await sleep(1500); }
  await page.locator("[data-form]").waitFor();
  // The form is redrawn (emptied) after each save: wait for that before typing the next one.
  await page.waitForFunction(() => { const i = document.querySelector("[data-form] input[name=name], [data-form] input[name=value]"); return i !== null && i.value === ""; }, null, { timeout: 20000 });
  await fill();
  await page.locator("[data-form] button[type=submit]").click();
  // Done only when the new row is really in the list (the form is saved through the server first).
  try {
    await page.locator("[data-list]").getByText(expectText, { exact: true }).first().waitFor({ timeout: 20000 });
  } catch (e) {
    const alert = await page.locator("[data-form-alert]").innerText().catch(() => "");
    const fieldErrs = await page.locator("[data-form] .field-error:not([hidden])").allInnerTexts().catch(() => []);
    await page.screenshot({ path: path.join(here, "fail-catalog.png") }).catch(() => {});
    throw new Error(`"${expectText}" did not appear in ${tab} list. Form said: ${alert} ${fieldErrs.join(" / ")}`, { cause: e });
  }
}

/** A pattern that matches a label whose whole text is exactly `t` (so "White" does not match "White / Red / Black"). */
const exactText = (t) => new RegExp("^[ ]*" + t.replace(/[^A-Za-z0-9 ]/g, (c) => "[" + c + "]") + "[ ]*$");

const results = [];
try {
  await signIn();
  note("Signed in to the real Admin Panel as the local Owner.");

  /* Building blocks: categories, brands, colours, sizes */
  await page.goto(`${BASE}/admin/categories`);
  await page.locator("#tab-category").waitFor();
  const categories = [...new Set(products.map((p) => p.category))];
  const brands = [...new Set(products.map((p) => p.brand))];
  const colours = new Map(products.map((p) => [p.colorName, p.colorHex]));
  const sizes = [...new Set(products.flatMap((p) => p.sizes))].sort((a, b) => Number(a) - Number(b));
  for (const name of categories) await addCatalogItem("category", name, async () => { await page.locator("#cat-category-name").fill(name); });
  for (const name of brands) await addCatalogItem("brand", name, async () => { await page.locator("#cat-brand-name").fill(name); });
  for (const [name, hex] of colours) await addCatalogItem("color", name, async () => {
    await page.locator("#cat-color-name").fill(name);
    await page.locator("#cat-color-hex").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, hex);
  });
  for (const s of sizes) await addCatalogItem("size", `EU ${s}`, async () => { await page.locator("#cat-size-system").selectOption("EU"); await page.locator("#cat-size-value").fill(s); await page.locator("#cat-size-sortOrder").fill(s); });
  note(`Created ${categories.length} categories, ${brands.length} brands, ${colours.size} colours, ${sizes.length} sizes through Categories & Sizes.`);

  /* Products */
  for (const p of products) {
    const row = { slug: p.slug, name: p.name, status: "started" };
    results.push(row);
    try {
      await page.goto(`${BASE}/admin/products/new`);
      await page.locator("#pd-name").waitFor();
      await page.locator("#pd-name").fill(p.name);
      await page.locator("#pd-sku").fill(p.sku);
      await page.locator("#pd-slug").fill(p.slug);
      await page.locator("#pd-categoryId").selectOption({ label: p.category });
      await page.locator("#pd-brandId").selectOption({ label: p.brand });
      await page.locator("#pd-description").fill(p.description);
      if (p.featured) await page.locator('input[name="isFeatured"]').check();
      if (p.isNewArrival) await page.locator('input[name="isNewArrival"]').check();
      await page.locator("#pd-photo").setInputFiles(path.join(here, sources[p.slug].file));
      await page.getByRole("button", { name: "Save and continue" }).click();
      await page.waitForURL(/\/admin\/products\/(?!new)[^/]+$/, { timeout: 60000 });
      row.productId = page.url().split("/").pop();
      await page.locator("[data-photos] figure.adm-photo img").first().waitFor({ timeout: 30000 });

      // Sizes & colours with the price
      const addForm = page.locator("[data-add-form]");
      if (!(await addForm.isVisible())) await page.locator("summary", { hasText: "Add sizes and colours" }).click();
      await addForm.locator("fieldset[data-field=colorIds] label", { hasText: exactText(p.colorName) }).locator("input").check();
      for (const s of p.sizes) await addForm.locator("fieldset[data-field=sizeIds] label", { hasText: new RegExp(`^\\s*EU ${s}\\s*$`) }).locator("input").check();
      await page.locator("#av-price").fill(String(p.sellPKR));
      const cost = page.locator("#av-costPrice");
      if (await cost.count()) await cost.fill("");
      await addForm.getByRole("button", { name: /Add sizes/ }).click();
      await page.locator("[data-variants] table, [data-variants] li, [data-variants] tr").first().waitFor({ timeout: 30000 });

      // Publish
      await page.locator("[data-status=published]").click();
      await page.locator("dialog[open]").getByRole("button", { name: "Publish" }).click();
      await page.locator("[data-status=draft]").waitFor({ timeout: 30000 });
      row.status = "created";
      note(`✔ ${p.name}: saved with photo, ${p.sizes.length} sizes, published.`);
    } catch (e) {
      row.status = "FAILED";
      row.error = String(e.message).split("\n")[0];
      await page.screenshot({ path: path.join(here, `fail-${p.slug}.png`) }).catch(() => {});
      note(`✖ ${p.name}: ${row.error}`);
    }
  }

  /* Demo stock: a recorded stock adjustment per size, through the real Stock adjustments dialog */
  await page.goto(`${BASE}/admin/stock-adjustments`);
  await page.locator("[data-new]").waitFor();
  for (const p of products) {
    const row = results.find((r) => r.slug === p.slug);
    if (row?.status !== "created") continue;
    for (const s of p.sizes) {
      try {
        await page.locator("[data-new]").click();
        const d = page.locator("dialog[open]");
        await d.locator("#pd-productId").selectOption({ label: p.name });
        await d.locator("select[name=variantId]").waitFor();
        await page.waitForFunction((label) => [...document.querySelectorAll("dialog[open] select[name=variantId] option")].some((o) => o.textContent.includes(label)), `EU ${s}`);
        await d.locator("select[name=variantId]").selectOption({ label: `${p.colorName} · EU ${s}` });
        await d.locator("select[name=warehouseId]").selectOption("main");
        await d.locator("select[name=reason]").selectOption("correction");
        await d.locator("select[name=direction]").selectOption("in");
        await d.locator("input[name=qty]").fill(String(p.stockPerSize ?? 3));
        const desc = d.locator("[name=description]");
        if (await desc.count()) await desc.fill("Demo stock for the local demonstration catalogue - not real inventory");
        await d.getByRole("button", { name: "Record adjustment" }).click();
        await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 30000 });
        row.stocked = (row.stocked ?? 0) + 1;
      } catch (e) {
        row.error = (row.error ?? "") + ` stock ${s}: ${String(e.message).split("\n")[0]}`;
        await page.screenshot({ path: path.join(here, `fail-stock-${p.slug}-${s}.png`) }).catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    note(`  stock recorded for ${p.name}: ${row.stocked ?? 0}/${p.sizes.length} sizes`);
  }
} finally {
  fs.writeFileSync(path.join(here, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), photoHost, results, log }, null, 2));
}

/* ── Verification is a separate script (verify.mjs) so it can be re-run; it needs the same live emulators ── */
const verify = await import("./verify.mjs");
await verify.run({ BASE, owner, browser, products, results, photoHost, cdn });

if (hold) {
  console.log(`\nThe demo store is up: ${BASE}  (admin: ${BASE}/admin, login in demo-catalog/.local-login.txt). Press Ctrl+C to stop.`);
  await new Promise(() => {});
}
await browser.close();
stop();
process.exit(results.some((r) => r.status === "FAILED") ? 1 : 0);
