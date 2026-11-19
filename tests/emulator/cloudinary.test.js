/**
 * Cloudinary product photos against the Firestore emulator (`npm run test:emulator`).
 * Firestore, the endpoints, permissions and validation are real. Cloudinary's NETWORK is replaced by an in-memory stand-in
 * (`cloudinaryIO`), because no real Cloudinary account is available to tests; the browser tests use a local stand-in server.
 * Nothing here proves a real Cloudinary upload works — see docs/CLOUDINARY.md for the manual check with real credentials.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const cdn = await import("../../functions/services/cloudinary.js");
const images = await import("../../functions/services/images.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const schemas = await import("../../functions/shared/schemas/index.js");

const STAFF = "staff-1";
const SECRET = "test-secret-not-real";
const saved = { ...process.env };
const TOKENS = {
  writer: { uid: "w-1", staff: true, perms: ["products.write"], auth_time: 9999999999 },
  reader: { uid: "r-1", staff: true, perms: ["products.read"], auth_time: 9999999999 },
  customer: { uid: "c-1" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });

/** Cloudinary stand-in: what the "account" holds, and every deletion requested. */
const held = new Map();
const destroyed = [];
cdn.cloudinaryIO.fetchResource = async (id) => held.get(id) ?? null;
cdn.cloudinaryIO.destroy = async (id) => {
  destroyed.push(id);
  held.delete(id);
};
const info = (publicId, over = {}) => ({ public_id: publicId, type: "upload", resource_type: "image", format: "jpg", bytes: 200_000, width: 1200, height: 900, version: 1700000001, secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1700000001/${publicId}.jpg`, ...over });
let pid;
let seq = 0;
const newId = () => `${pid}`.length && `shoe-store/products/${pid}/${String(++seq).padStart(2, "0")}abcdefghijklmnopqr`;
const give = (over = {}) => {
  const id = newId();
  held.set(id, info(id, over));
  return id;
};

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of ["w-1", "r-1"]) await auth.createUser({ uid: t }).catch(() => {});
  const cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  pid = (await products.saveProduct(schemas.saveProductInput.parse({ name: "Cloud Shoe", slug: "cloud-shoe", categoryId: cat, sku: "CL-1" }), STAFF)).id;
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: "test-cloud", CLOUDINARY_API_KEY: "123456", CLOUDINARY_API_SECRET: SECRET });
});
after(() => {
  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("without Cloudinary configured the endpoints say so plainly (the admin then uses the Blob route), and never reveal values", async () => {
  const keep = { ...process.env };
  for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) delete process.env[k];
  try {
    const r = await call("cloudinarySignature", "writer", { productId: pid });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.details.notConfigured, true);
    assert.match(r.body.error.message, /isn't connected/);
    const h = await handleApi({ method: "GET", name: "healthCheck", headers: {} });
    assert.equal(h.body.cloudinary, "not-connected");
  } finally {
    Object.assign(process.env, keep);
  }
  const h2 = await handleApi({ method: "GET", name: "healthCheck", headers: {} });
  assert.equal(h2.body.cloudinary, "connected");
  assert.ok(!JSON.stringify(h2.body).includes(SECRET), "the secret is never in an answer");
});

test("only people with products.write can get a signature or attach a photo", async () => {
  for (const name of ["cloudinarySignature", "addCloudinaryImage"]) {
    const data = name === "cloudinarySignature" ? { productId: pid } : { productId: pid, publicId: `shoe-store/products/${pid}/aaaaaaaaaaaaaaaaaaaa` };
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "reader", data)).status, 403, `${name} read-only staff`);
  }
});

test("the signature covers exactly the folder, id, formats and time, is made with the server secret, and the secret is not returned", async () => {
  const r = await call("cloudinarySignature", "writer", { productId: pid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.data;
  assert.ok(s.publicId.startsWith(`shoe-store/products/${pid}/`));
  assert.equal(s.allowed_formats, "jpg,jpeg,png,webp");
  assert.equal(s.maxBytes, 5 * 1024 * 1024);
  assert.equal(s.uploadUrl, "https://api.cloudinary.com/v1_1/test-cloud/image/upload");
  assert.equal(s.apiKey, "123456");
  assert.equal(s.signature, cdn.signParams({ allowed_formats: s.allowed_formats, public_id: s.publicId, timestamp: s.timestamp }, SECRET));
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.ok(Math.abs(s.timestamp - Math.floor(Date.now() / 1000)) < 60);
  const again = (await call("cloudinarySignature", "writer", { productId: pid })).body.data;
  assert.notEqual(again.publicId, s.publicId, "every upload gets its own id");
  assert.equal((await call("cloudinarySignature", "writer", { productId: "no-such-product" })).status, 404);
});

test("a real upload is checked at Cloudinary, then saved in the existing images shape with permanent https URLs", async () => {
  const id = give();
  const r = await call("addCloudinaryImage", "writer", { productId: pid, publicId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = (await db.doc(`products/${pid}`).get()).data();
  assert.equal(doc.images.length, 1);
  const img = doc.images[0];
  assert.equal(img.provider, "cloudinary");
  assert.equal(img.publicId, id);
  assert.equal(img.isPrimary, true, "the first photo is the main one");
  assert.deepEqual([img.width, img.height], [1200, 900]);
  for (const w of [400, 800, 1600]) {
    assert.match(img.paths[w], /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/c_limit,w_\d+,f_auto,q_auto\/v1700000001\/shoe-store\/products\//);
    assert.ok(img.paths[w].endsWith(id));
  }
  // The very same shape the storefront already reads (src/data/product.js): paths[800] || paths[400].
  assert.ok(img.paths[800] && img.paths[400]);
  assert.equal(destroyed.includes(id), false, "nothing is deleted on success");
  const again = await call("addCloudinaryImage", "writer", { productId: pid, publicId: id });
  assert.equal(again.body.data.existing, true, "sending it twice adds nothing");
  assert.equal((await db.doc(`products/${pid}`).get()).data().images.length, 1);
  assert.ok((await db.collection("auditLogs").where("action", "==", "product.image_added").get()).docs.some((d) => d.data().changes?.provider === "cloudinary"));
});

test("bad uploads are refused and removed from Cloudinary: wrong format, over 5 MB, too small, odd answers, someone else's file, unknown file", async () => {
  const before_ = (await db.doc(`products/${pid}`).get()).data().images.length;
  const cases = [
    ["a GIF", { format: "gif" }, /JPEG, PNG or WebP/],
    ["6 MB", { bytes: 6 * 1024 * 1024 }, /larger than 5 MB/],
    ["exactly 5 MB + 1", { bytes: 5 * 1024 * 1024 + 1 }, /larger than 5 MB/],
    ["too small", { width: 200, height: 900 }, /too small/],
    ["a raw file", { resource_type: "raw" }, /isn't a normal photo/],
    ["a private upload", { type: "private" }, /isn't a normal photo/],
    ["an address on another host", { secure_url: "https://evil.example.com/test-cloud/image/upload/v1/x" }, /unexpected address/],
    ["a missing version", { version: 0 }, /unexpected answer/],
  ];
  for (const [label, over, message] of cases) {
    const id = give(over);
    const r = await call("addCloudinaryImage", "writer", { productId: pid, publicId: id });
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error.message, message, label);
    assert.ok(destroyed.includes(id), `${label}: the rejected file was deleted from Cloudinary`);
  }
  // exactly 5 MB is allowed
  const edge = give({ bytes: 5 * 1024 * 1024 });
  assert.equal((await call("addCloudinaryImage", "writer", { productId: pid, publicId: edge })).status, 200, "5 MB exactly is accepted");
  // an id that belongs to another product's folder
  const other = "shoe-store/products/someone-else/zzzzzzzzzzzzzzzzzzzz";
  held.set(other, info(other));
  assert.equal((await call("addCloudinaryImage", "writer", { productId: pid, publicId: other })).status, 400);
  assert.ok(held.has(other), "another product's file is left alone");
  // never uploaded
  const ghost = `shoe-store/products/${pid}/ghostghostghostghost`;
  assert.equal((await call("addCloudinaryImage", "writer", { productId: pid, publicId: ghost })).status, 404);
  assert.equal((await db.doc(`products/${pid}`).get()).data().images.length, before_ + 1, "only the accepted photo was added");
});

test("a product keeps at most 12 photos; the extra upload is deleted", async () => {
  while (((await db.doc(`products/${pid}`).get()).data().images?.length ?? 0) < 12) {
    const id = give();
    assert.equal((await call("addCloudinaryImage", "writer", { productId: pid, publicId: id })).status, 200);
  }
  const extra = give();
  const r = await call("addCloudinaryImage", "writer", { productId: pid, publicId: extra });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /at most 12/);
  assert.ok(destroyed.includes(extra));
  assert.equal((await call("cloudinarySignature", "writer", { productId: pid })).status, 400, "no signature once the product is full");
});

test("deleting a Cloudinary photo deletes its file; deleting an old (Blob) photo still goes through Blob; the other photos are untouched", async () => {
  const doc = (await db.doc(`products/${pid}`).get()).data();
  const target = doc.images[3];
  const blobDeleted = [];
  images.blobIO.del = async (urls) => blobDeleted.push(...[urls].flat());
  // add an "old" photo in the pre-Cloudinary shape (no provider), as existing products have
  const legacy = { id: "legacyphoto000000001", paths: { 400: "https://abc.public.blob.vercel-storage.com/products/x/legacy-400.webp", 800: "https://abc.public.blob.vercel-storage.com/products/x/legacy-800.webp", 1600: "https://abc.public.blob.vercel-storage.com/products/x/legacy-1600.webp" }, width: 900, height: 900, alt: "", isPrimary: false };
  await db.doc(`products/${pid}`).update({ images: [...doc.images.slice(0, 11), legacy] });
  const r = await call("productImageAction", "writer", { productId: pid, action: "delete", imageId: target.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(destroyed.includes(target.publicId), "the Cloudinary file was deleted");
  assert.deepEqual(blobDeleted, [], "nothing was sent to Blob for a Cloudinary photo");
  const r2 = await call("productImageAction", "writer", { productId: pid, action: "delete", imageId: legacy.id });
  assert.equal(r2.status, 200);
  assert.equal(blobDeleted.length, 3, "an old photo is still deleted from Blob");
  assert.equal((await db.doc(`products/${pid}`).get()).data().images.some((i) => i.id === legacy.id || i.id === target.id), false);
});

test("existing products are unaffected: old-shape photos still read as before, and a product with no photos can get its first one", async () => {
  const cat = (await db.collection("categories").limit(1).get()).docs[0].id;
  const p2 = (await products.saveProduct(schemas.saveProductInput.parse({ name: "Old Shoe", slug: "old-shoe", categoryId: cat, sku: "OLD-1" }), STAFF)).id;
  await db.doc(`products/${p2}`).update({ images: [{ id: "oldphoto0000000000001", paths: { 400: "https://abc.public.blob.vercel-storage.com/a-400.webp", 800: "https://abc.public.blob.vercel-storage.com/a-800.webp", 1600: "https://abc.public.blob.vercel-storage.com/a-1600.webp" }, width: 800, height: 800, alt: "x", isPrimary: true }] });
  const id = `shoe-store/products/${p2}/newphotonewphotonewp`;
  held.set(id, info(id));
  assert.equal((await call("addCloudinaryImage", "writer", { productId: p2, publicId: id })).status, 200);
  const imgs = (await db.doc(`products/${p2}`).get()).data().images;
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].paths[400], "https://abc.public.blob.vercel-storage.com/a-400.webp", "the old photo is exactly as it was");
  assert.equal(imgs[0].isPrimary, true);
  assert.equal(imgs[1].isPrimary, false, "a new photo does not take the main place from an existing one");
});
