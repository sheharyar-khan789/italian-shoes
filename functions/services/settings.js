/**
 * Store settings. `settings/public` is readable by everyone (storefront); `settings/private`
 * only by staff with settings.manage. Both are written only here, after validation.
 */
import { db, FieldValue } from "../lib/admin.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { markCatalogDirty } from "./catalogSnapshot.js";

/** Field-by-field differences, for the activity log. */
function diff(before = {}, after = {}) {
  /** @type {Record<string, {from: unknown, to: unknown}>} */
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "updatedAt" || key === "updatedBy") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}

/**
 * @param {{ public: Record<string, unknown>, private: Record<string, unknown> }} settings already validated
 * @param {string} actorUid
 * @returns {Promise<{ changed: string[] }>}
 */
export async function saveSettings(settings, actorUid) {
  const pubRef = db.collection("settings").doc("public");
  const privRef = db.collection("settings").doc("private");

  return db.runTransaction(async (tx) => {
    const [pub, priv] = await Promise.all([tx.get(pubRef), tx.get(privRef)]);
    // The logo is changed by its own upload (setStoreLogo), never by this form, so saving the form must keep it.
    const incomingPublic = { ...settings.public, ...(pub.data()?.logoUrl ? { logoUrl: pub.data()?.logoUrl } : {}) };
    const changes = {
      public: diff(pub.data(), incomingPublic),
      private: diff(priv.data(), settings.private),
    };
    const changed = [...Object.keys(changes.public).map((k) => `public.${k}`), ...Object.keys(changes.private).map((k) => `private.${k}`)];
    if (!changed.length) return { changed };

    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    tx.set(pubRef, { ...incomingPublic, ...stamp });
    tx.set(privRef, { ...settings.private, ...stamp });
    markCatalogDirty(tx);
    writeAudit({ actorUid, action: "settings.updated", entityType: "settings", entityId: "store", changes }, tx);
    notify(
      {
        type: "settings.changed",
        audience: "settings.manage",
        title: "Store settings were changed",
        body: `${changed.length} setting${changed.length === 1 ? "" : "s"} updated.`,
        link: "/admin/settings",
        data: { fields: changed },
      },
      tx,
    );
    return { changed };
  });
}
