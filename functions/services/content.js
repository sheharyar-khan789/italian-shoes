/**
 * Website content written by the owner: banners, FAQs, pages and home-page sections.
 * Everything is plain text (the storefront escapes it), links are validated, and nothing is
 * pre-filled: until the owner writes something, the storefront simply shows nothing for it.
 *
 *   banners/{id}  faqs/{id}  pages/{slug}  content/home
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

const stamp = (actorUid) => ({ updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });

async function saveWithId(collection, entity, input, actorUid) {
  const { id, ...data } = input;
  const ref = id ? db.collection(collection).doc(id) : db.collection(collection).doc();
  if (id && !(await ref.get()).exists) throw new AppError("not-found", "That item no longer exists.");
  await ref.set({ ...data, ...stamp(actorUid), ...(id ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
  await writeAudit({ actorUid, action: `${entity}.${id ? "updated" : "created"}`, entityType: entity, entityId: ref.id, changes: { after: data } });
  return { id: ref.id };
}

export const saveBanner = (input, actorUid) => saveWithId("banners", "banner", input, actorUid);
export const saveFaq = (input, actorUid) => saveWithId("faqs", "faq", input, actorUid);

export async function deleteContent(kind, id, actorUid) {
  const ref = db.collection(kind === "banner" ? "banners" : "faqs").doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That item no longer exists.");
  await ref.delete();
  await writeAudit({ actorUid, action: `${kind}.deleted`, entityType: kind, entityId: id });
  return { id };
}

export async function savePage(input, actorUid) {
  const { slug, ...data } = input;
  const ref = db.collection("pages").doc(slug);
  const existed = (await ref.get()).exists;
  await ref.set({ ...data, ...stamp(actorUid), ...(existed ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
  await writeAudit({ actorUid, action: existed ? "page.updated" : "page.created", entityType: "page", entityId: slug, changes: { isPublished: data.isPublished } });
  return { slug };
}

export async function deletePage(slug, actorUid) {
  const ref = db.collection("pages").doc(slug);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That page no longer exists.");
  await ref.delete();
  await writeAudit({ actorUid, action: "page.deleted", entityType: "page", entityId: slug });
  return { slug };
}

/** Featured products must exist and be published, so the home page never links to a dead product. */
export async function saveHome(input, actorUid) {
  if (input.featuredProductIds.length) {
    const snaps = await db.getAll(...input.featuredProductIds.map((id) => db.collection("products").doc(id)));
    const bad = snaps.filter((s) => !s.exists || s.data().status !== "published");
    if (bad.length) throw new AppError("invalid-argument", "Only published products can be featured.", { fields: { featuredProductIds: "Includes an unpublished or missing product" } });
  }
  await db.doc("content/home").set({ ...input, ...stamp(actorUid) });
  await writeAudit({ actorUid, action: "home.updated", entityType: "content", entityId: "home", changes: { after: input } });
  return { ok: true };
}
