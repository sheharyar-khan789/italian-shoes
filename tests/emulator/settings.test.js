/**
 * Settings service and admin notifications against the Firestore emulator (`npm run test:emulator`).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db } = await import("../../functions/lib/admin.js");
const { saveSettings } = await import("../../functions/services/settings.js");
const { notify } = await import("../../functions/lib/notify.js");
const { saveSettingsSchema } = await import("../../functions/shared/schemas/index.js");

const valid = () =>
  saveSettingsSchema.parse({
    public: { storeName: "Italian Shoes", phone: "0342-7530608", address: "Main GT Road, Sarai Alamgir", instagram: "https://www.instagram.com/italianshoesofficial/" },
    private: { orderPrefix: "IS", lowStockThreshold: 3 },
  });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
});

test("first save writes both documents, logs every field and notifies the Owner", async () => {
  const { changed } = await saveSettings(valid(), "owner-1");
  assert.ok(changed.includes("public.storeName") && changed.includes("private.orderPrefix"));

  const pub = (await db.doc("settings/public").get()).data();
  assert.equal(pub.storeName, "Italian Shoes");
  assert.equal(pub.updatedBy, "owner-1");
  assert.equal((await db.doc("settings/private").get()).data().lowStockThreshold, 3);

  const logs = await db.collection("auditLogs").where("action", "==", "settings.updated").get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].data().changes.public.storeName.to, "Italian Shoes");

  const notes = await db.collection("notifications").where("type", "==", "settings.changed").get();
  assert.equal(notes.size, 1);
  assert.equal(notes.docs[0].data().audience, "settings.manage");
  assert.deepEqual(notes.docs[0].data().readBy, []);
});

test("saving the same values again changes nothing and logs nothing", async () => {
  const { changed } = await saveSettings(valid(), "owner-1");
  assert.deepEqual(changed, []);
  assert.equal((await db.collection("auditLogs").where("action", "==", "settings.updated").get()).size, 1);
});

test("a real change is recorded with before and after values", async () => {
  const next = valid();
  next.private.lowStockThreshold = 5;
  const { changed } = await saveSettings(next, "owner-2");
  assert.deepEqual(changed, ["private.lowStockThreshold"]);
  const latest = (await db.collection("auditLogs").where("actorUid", "==", "owner-2").get()).docs[0].data();
  assert.deepEqual(latest.changes.private.lowStockThreshold, { from: 3, to: 5 });
});

test("notify() refuses unknown notification types", () => {
  assert.throws(() => notify({ type: /** @type {any} */ ("made.up"), audience: "staff.manage", title: "x" }), TypeError);
});
