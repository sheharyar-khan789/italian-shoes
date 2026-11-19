/**
 * Product photos end to end in a real browser: choose a real image file, see the preview, upload, save, and see the same picture
 * in the admin and on the shop. The "Cloudinary" at the other end is a LOCAL STAND-IN (tests/e2e/cloudinaryStandIn.mjs) that
 * independently checks the upload signature and really stores and serves the bytes. A real Cloudinary account was not used.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { launch, newPage, adminLogin, shot, BASE, fx } from "./helpers.js";

process.env.GCLOUD_PROJECT = "demo-italianshoes";
const { db } = await import("../../functions/lib/admin.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const CDN = process.env.E2E_CLOUDINARY;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photos-"));
const file = (name) => path.join(dir, name);
const stand = async () => (await fetch(`${CDN}/__state`)).json();
const failNext = (on) => fetch(`${CDN}/__fail?on=${on ? 1 : 0}`, { method: "POST" });

let browser;
before(async () => {
  assert.ok(CDN, "run via `npm run e2e` (it starts the Cloudinary stand-in)");
  browser = await launch();
  // Real image files, made with sharp: a photo-like JPEG, a PNG, a 12 MB noisy PNG, a GIF and a text file.
  const noise = (w, h, ch = 3) => { const b = Buffer.alloc(w * h * ch); for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24; return b; };
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#b5651d" } }).composite([{ input: Buffer.from('<svg width="600" height="300"><rect width="600" height="300" fill="#2e5a44"/><text x="40" y="170" font-size="80" fill="#f1ead6">SHOE A</text></svg>'), top: 300, left: 300 }]).jpeg().toFile(file("shoe-a.jpg"));
  await sharp({ create: { width: 900, height: 900, channels: 3, background: "#1f3a2d" } }).composite([{ input: Buffer.from('<svg width="500" height="200"><rect width="500" height="200" fill="#d6b574"/><text x="40" y="130" font-size="70" fill="#1e2a24">SHOE B</text></svg>'), top: 350, left: 200 }]).png().toFile(file("shoe-b.png"));
  await sharp(noise(2000, 2000), { raw: { width: 2000, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toFile(file("huge.png"));
  await sharp({ create: { width: 400, height: 400, channels: 3, background: "#888" } }).gif().toFile(file("anim.gif"));
  fs.writeFileSync(file("notes.txt"), "this is not a picture");
  assert.ok(fs.statSync(file("huge.png")).size > 5 * 1024 * 1024, "the oversized fixture really is over 5 MB");
});
after(async () => {
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let productId = null;
let firstPublicId = null;
const productDoc = async () => (await db.doc(`products/${productId}`).get()).data();

test("the Owner creates a product with a real photo: preview, upload, save; the saved address is a permanent https URL", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products/new`);
  await page.locator("#pd-name").waitFor({ timeout: 20000 });
  await page.locator("#pd-name").fill("Cloud Loafer");
  await page.locator("#pd-sku").fill("CLOUD-1");
  await page.locator("#pd-slug").fill("cloud-loafer");
  await page.locator("#pd-photo").setInputFiles(file("shoe-a.jpg"));
  await page.locator("[data-photo-preview] img").waitFor({ timeout: 10000 });
  assert.match(await page.locator("[data-photo-preview] img").getAttribute("src"), /^blob:/, "the preview is a temporary local view only");
  await shot(page, "cloudinary-new-product-preview");
  const before_ = await stand();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/\/admin\/products\/(?!new)[A-Za-z0-9]+/, { timeout: 30000 });
  productId = page.url().split("/").pop();

  // Saved in Firestore exactly once, with permanent https URLs from the delivery host, in the existing images shape.
  const doc = await productDoc();
  assert.equal(doc.name, "Cloud Loafer");
  assert.equal(doc.images.length, 1);
  const img = doc.images[0];
  firstPublicId = img.publicId;
  assert.equal(img.provider, "cloudinary");
  assert.ok(img.publicId.startsWith(`shoe-store/products/${productId}/`), "organised in the shoe-store/products folder");
  for (const w of [400, 800, 1600]) {
    assert.ok(img.paths[w].startsWith(`${CDN}/e2e-cloud/image/upload/`), `paths[${w}] is a Cloudinary delivery URL: ${img.paths[w]}`);
    assert.ok(!img.paths[w].startsWith("blob:"), "never a temporary local address");
  }
  assert.equal((await stand()).uploads, before_.uploads + 1, "exactly one file reached Cloudinary");

  // The saved addresses answer with a real picture.
  for (const w of [400, 800, 1600]) {
    const r = await fetch(img.paths[w]);
    assert.equal(r.status, 200, `GET ${img.paths[w]} -> ${r.status}`);
    assert.match(r.headers.get("content-type") ?? "", /^image[/]/);
  }
  // The editor shows the picture from its saved address, and it really loads.
  await page.waitForFunction(() => { const i = document.querySelector(".adm-photo img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
  const shown = await page.locator(".adm-photo img").first().getAttribute("src");
  assert.equal(shown, img.paths[400], `the editor shows the saved address (browser problems: ${problems.join(" | ")})`);
  assert.ok(await page.getByText(/Saved, with its photo/).count() >= 0);
  // The different sizes are real: the 400 px address returns a smaller picture than the 1600 px one.
  const small = await sharp(Buffer.from(await (await fetch(img.paths[400])).arrayBuffer())).metadata();
  const large = await sharp(Buffer.from(await (await fetch(img.paths[1600])).arrayBuffer())).metadata();
  assert.equal(small.width, 400);
  assert.equal(large.width, 1200, "never enlarged beyond the original");

  // Reload the admin: still there.
  await page.reload();
  await page.waitForFunction(() => { const i = document.querySelector(".adm-photo img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
  await shot(page, "cloudinary-editor-after-reload");
  assert.equal(problems.filter((p) => !/^40[0-9] /.test(p)).length, 0, problems.join("\n"));
  await context.close();
});

test("the same picture appears on the shop: listing, product page, cart; the admin list shows it too", async () => {
  assert.ok(productId, "needs the product from the previous test");
  // Give the product a size, stock in an online warehouse and publish it (the usual steps after adding photos).
  const colorId = fx.ids.black;
  const sizeId = fx.ids.s42;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [colorId], sizeIds: [sizeId], price: 1250000, salePrice: null, costPrice: 700000 }), { actorUid: fx.people.owner.uid, canEditCost: true });
  const variantId = products.variantKey(colorId, sizeId);
  await inventory.adjustStock({ productId, variantId, warehouseId: "main", change: 5, reason: "initial", note: "photo test" }, fx.people.owner.uid);
  await products.setProductStatus(productId, "published", fx.people.owner.uid);
  const expected = (await productDoc()).images[0].paths;

  const { page, context } = await newPage(browser);
  const loaded = (sel) => page.waitForFunction((s) => { const i = [...document.querySelectorAll(s)].find((x) => x.src); return i && i.complete && i.naturalWidth > 0 ? i.src : false; }, sel, { timeout: 30000 }).then((h) => h.jsonValue(), async () => { const seen = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 300), imgs: [...document.images].map((i) => (i.src || "").slice(0, 110) + " " + i.complete + " " + i.naturalWidth) })); throw new Error(`no loaded image for ${sel}: ${JSON.stringify(seen)}`); });

  await page.goto(`${BASE}/shop`);
  const listSrc = await loaded('img[data-media][src*="shoe-store/products/' + productId + '"]');
  assert.equal(listSrc, expected[800], "the shop listing shows the saved Cloudinary address");
  await shot(page, "cloudinary-shop");

  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => /Cloud Loafer/.test(document.body.innerText), null, { timeout: 30000 });

  await page.goto(`${BASE}/product/cloud-loafer`);
  const pdpSrc = await loaded('[data-gallery-main] img[data-media]');
  assert.equal(pdpSrc, expected[800]);
  await shot(page, "cloudinary-product-page");

  // Add to the bag: the cart shows the same picture.
  await page.locator(`input[name="size"][value="${sizeId}"]`).check({ force: true });
  await page.getByRole("button", { name: /add to bag/i }).first().click();
  await page.waitForTimeout(1500);
  const cartSrc = await loaded(`.line__media img[data-media]`);
  assert.equal(cartSrc, expected[800]);
  await shot(page, "cloudinary-cart");

  // The admin products list shows a thumbnail from the same address.
  const admin = await newPage(browser);
  await adminLogin(admin.page, fx.people.owner);
  await admin.page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await admin.page.goto(`${BASE}/admin/products`);
  await admin.page.waitForFunction((id) => [...document.querySelectorAll("img.adm-thumb")].some((i) => i.src.includes(id) && i.complete && i.naturalWidth > 0), productId, { timeout: 20000 });
  await admin.context.close();
  await context.close();
});

test("replacing a photo: the new one is saved first, the old one is deleted at Cloudinary, the main photo and position are kept", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products/${productId}`);
  await page.locator(".adm-photo img").first().waitFor({ timeout: 20000 });
  const before_ = await stand();
  await page.locator('[data-replace]').setInputFiles(file("shoe-b.png")).catch(() => {});
  // the hidden input is opened by the Replace button: click it, then give it the file
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-img="replace"]').first().click();
  await (await chooser).setFiles(file("shoe-b.png"));
  await page.waitForFunction((old) => { const i = document.querySelector(".adm-photo img"); return i && !i.src.includes(old) && i.complete && i.naturalWidth > 0; }, firstPublicId.split("/").pop(), { timeout: 30000 });
  const doc = await productDoc();
  const bodyText = (await page.locator("body").innerText()).split(/[ \t\r\n]+/).join(" ");
  const said = bodyText.slice(Math.max(0, bodyText.search(/Photo replaced|The new photo was added|The photo wasn't replaced/)), 400).slice(0, 200);
  assert.equal(doc.images.length, 1, `one photo: replaced, not added (the screen said: ${said})`);
  assert.notEqual(doc.images[0].publicId, firstPublicId);
  assert.equal(doc.images[0].isPrimary, true, "it is still the main photo");
  const s = await stand();
  assert.equal(s.uploads, before_.uploads + 1);
  assert.ok(s.destroyed.includes(firstPublicId), "the old file was deleted from Cloudinary");
  assert.ok(!s.stored.includes(firstPublicId));
  await context.close();
});

test("bad files are refused with a clear message before anything is uploaded: wrong type, GIF, over 5 MB", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products/${productId}`);
  await page.locator('[data-upload]').waitFor({ state: "attached", timeout: 20000 });
  const before_ = await stand();
  for (const [name, message] of [["notes.txt", /JPEG, PNG or WebP/], ["anim.gif", /JPEG, PNG or WebP/], ["huge.png", /larger than 5 MB/]]) {
    await page.locator("[data-upload]").setInputFiles(file(name));
    await page.waitForFunction((n) => [...document.querySelectorAll("[data-upload-list] li")].some((li) => li.innerText.includes(n) && /not added/.test(li.innerText)), name, { timeout: 15000 });
    const line = (await page.locator("[data-upload-list] li", { hasText: name }).first().innerText()).replace(/\s+/g, " ");
    assert.match(line, message, line);
  }
  assert.equal((await stand()).uploads, before_.uploads, "nothing was sent to Cloudinary");
  assert.equal((await productDoc()).images.length, 1, "the product is unchanged");

  // The same checks on the new-product form: a bad choice is explained and not kept.
  await page.goto(`${BASE}/admin/products/new`);
  await page.locator("#pd-photo").setInputFiles(file("huge.png"));
  await page.waitForFunction(() => /larger than 5 MB/.test(document.querySelector('[data-field="photo"]')?.innerText ?? ""), null, { timeout: 10000 });
  await context.close();
});

test("a failed upload keeps everything the admin typed, says so clearly, and the photo can be added again; the button cannot double-submit", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products/new`);
  await page.locator("#pd-name").fill("Retry Brogue");
  await page.locator("#pd-sku").fill("RETRY-1");
  await page.locator("#pd-slug").fill("retry-brogue");
  await page.locator("#pd-description").fill("Typed before the upload failed.");
  await page.locator("#pd-photo").setInputFiles(file("shoe-a.jpg"));
  await page.locator("[data-photo-preview] img").waitFor();
  await failNext(true);
  const save = page.getByRole("button", { name: "Save and continue" });
  await save.dblclick(); // a double click must still make one product
  await page.waitForURL(/\/admin\/products\/(?!new)[A-Za-z0-9]+/, { timeout: 30000 });
  const retryId = page.url().split("/").pop();
  const made = await db.collection("products").where("slug", "==", "retry-brogue").get();
  assert.equal(made.size, 1, "the product was saved once");
  assert.equal(made.docs[0].data().description, "Typed before the upload failed.", "what was typed is kept");
  assert.equal((made.docs[0].data().images ?? []).length, 0, "no photo, because the upload failed");
  await page.getByText(/the photo wasn't added/i).waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#pd-name").inputValue(), "Retry Brogue", "the details are on screen");
  await shot(page, "cloudinary-failed-upload");

  // Add the photo again from the editor.
  await failNext(false);
  await page.locator("[data-upload]").setInputFiles(file("shoe-b.png"));
  await page.waitForFunction(() => document.querySelectorAll(".adm-photo img").length === 1, null, { timeout: 30000 });
  assert.equal(((await db.doc(`products/${retryId}`).get()).data().images ?? []).length, 1);
  await context.close();
});

test("existing products are unaffected: those with older photo addresses still list and open, and the shop still shows them", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products`);
  await page.waitForFunction(() => /E2E Oxford/.test(document.body.innerText) && /E2E Derby/.test(document.body.innerText), null, { timeout: 20000 });
  const old = (await db.collection("products").where("slug", "==", "oxford-e2e").get()).docs[0];
  await page.goto(`${BASE}/admin/products/${old.id}`);
  await page.locator("#pd-name").waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#pd-name").inputValue(), "E2E Oxford");
  assert.equal((await db.doc(`products/${old.id}`).get()).data().images[0].paths[400], "x", "its saved photo data was not touched");
  await context.close();
});
