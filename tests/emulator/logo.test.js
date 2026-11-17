/**
 * Store logo upload (`npm run test:emulator`): who may upload, what is accepted, what is stored, and that saving the
 * settings form afterwards does not wipe the logo. Blob storage is replaced by an in-memory store; images are real.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth } = await import("../../functions/lib/admin.js");
const images = await import("../../functions/services/images.js");
const settings = await import("../../functions/services/settings.js");
const { saveSettingsSchema, setStoreLogoInput } = await import("../../functions/shared/schemas/index.js");

const HOST = "https://abc123.public.blob.vercel-storage.com";
const OWNER = "owner-1";
const store = new Map();
const deleted = [];
images.blobIO.fetchSource = async (url) => {
  if (!store.has(url)) throw new Error("missing");
  return store.get(url);
};
images.blobIO.put = async (pathname, body) => {
  const url = `${HOST}/${pathname}`;
  store.set(url, body);
  return url;
};
images.blobIO.del = async (urls) => {
  for (const u of [urls].flat()) {
    deleted.push(u);
    store.delete(u);
  }
};
const upload = (name, buffer, uid = OWNER) => {
  const url = `${HOST}/logo/${uid}/${name}`;
  store.set(url, buffer);
  return url;
};
const png = (w, h, exif = false) => {
  const img = sharp({ create: { width: w, height: h, channels: 4, background: "#102a43" } });
  return (exif ? img.withExif({ IFD0: { Copyright: "camera-owner-secret" } }) : img).png().toBuffer();
};
const TOKENS = {
  owner: { uid: OWNER, staff: true, perms: ["settings.manage"], auth_time: 9999999999 },
  other: { uid: "other-1", staff: true, perms: ["products.write"], auth_time: 9999999999 },
};
const verifyToken = async (t) => TOKENS[t];
const ask = (pathname, token) => images.authorizeBlobUpload({ pathname, authorization: `Bearer ${token}` }, { verifyToken });
const code = (p) => p.then(() => "ok", (e) => e.code);
const publicDoc = async () => (await db.doc("settings/public").get()).data();

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const uid of [OWNER, "other-1"]) await auth.createUser({ uid }).catch(() => {});
});

test("only people who may change the settings can get an upload token, into their own folder", async () => {
  const ok = await ask(`logo/${OWNER}/mine`, "owner");
  assert.deepEqual(ok.allowedContentTypes, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(ok.maximumSizeInBytes, 2 * 1024 * 1024);
  assert.equal(await code(ask(`logo/${OWNER}/mine`, "other")), "permission-denied", "product editors cannot change the logo");
  assert.equal(await code(ask("logo/someone-else/mine", "owner")), "invalid-argument", "not into another folder");
  assert.equal(await code(ask(`logo/${OWNER}/../x`, "owner")), "invalid-argument");
});

test("a real picture becomes a small WebP logo with the metadata removed; the upload is deleted", async () => {
  const url = upload("a1", await png(1600, 1200, true));
  const { logoUrl } = await images.setStoreLogo({ url }, OWNER);
  assert.match(logoUrl, /\/branding\/logo-[a-f0-9]{16}\.webp$/);
  assert.equal((await publicDoc()).logoUrl, logoUrl);
  const meta = await sharp(store.get(logoUrl)).metadata();
  assert.equal(meta.format, "webp");
  assert.ok(Math.max(meta.width, meta.height) <= 600, "shrunk to fit 600 x 600");
  assert.equal(meta.exif, undefined, "metadata removed");
  assert.ok(deleted.includes(url), "the original upload is deleted");
  assert.ok((await db.collection("auditLogs").where("action", "==", "settings.logo_set").get()).size >= 1);
});

test("saving the settings form keeps the logo, and does not report it as changed", async () => {
  const before_ = (await publicDoc()).logoUrl;
  const valid = saveSettingsSchema.parse({ public: { storeName: "Italian Shoes", phone: "0342-7530608", address: "Main GT Road, Sarai Alamgir" }, private: { orderPrefix: "IS", lowStockThreshold: 3 } });
  const first = await settings.saveSettings(valid, OWNER);
  assert.ok(first.changed.length > 0);
  assert.ok(!first.changed.includes("public.logoUrl"), "the logo is not a form field");
  assert.equal((await publicDoc()).logoUrl, before_, "the logo survived the save");
  const second = await settings.saveSettings(valid, OWNER);
  assert.deepEqual(second.changed, [], "saving again changes nothing");
});

test("a replacement deletes the old logo file; removing the logo deletes it too", async () => {
  const old = (await publicDoc()).logoUrl;
  const { logoUrl } = await images.setStoreLogo({ url: upload("a2", await png(300, 300)) }, OWNER);
  assert.notEqual(logoUrl, old);
  assert.ok(deleted.includes(old), "old logo file deleted");
  await images.removeStoreLogo(OWNER);
  assert.equal((await publicDoc()).logoUrl, undefined);
  assert.ok(deleted.includes(logoUrl));
});

test("bad files are refused and cleaned up: not an image, too small, wrong format, someone else's upload, oversized", async () => {
  const bad = upload("junk", Buffer.from("this is not a picture"));
  await assert.rejects(images.setStoreLogo({ url: bad }, OWNER), /isn't a valid image/);
  assert.ok(deleted.includes(bad));
  await assert.rejects(images.setStoreLogo({ url: upload("tiny", await png(20, 20)) }, OWNER), /too small/);
  const gif = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#fff" } }).gif().toBuffer();
  await assert.rejects(images.setStoreLogo({ url: upload("gif", gif) }, OWNER), /JPEG, PNG or WebP/);
  await assert.rejects(images.setStoreLogo({ url: upload("big", Buffer.alloc(2 * 1024 * 1024 + 10, 1)) }, OWNER), /2 MB/);
  await assert.rejects(images.setStoreLogo({ url: upload("x", await png(300, 300), "other-1") }, OWNER), /upload link isn't valid/, "another person's upload");
  await assert.rejects(images.setStoreLogo({ url: "https://evil.example.com/logo/owner-1/x" }, OWNER), /upload link isn't valid/);
  assert.equal((await publicDoc()).logoUrl, undefined, "nothing was saved by the refused uploads");
  assert.equal(setStoreLogoInput.safeParse({ url: "not a url" }).success, false);
});
