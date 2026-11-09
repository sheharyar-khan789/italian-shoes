/**
 * Catalogue building blocks: categories, brands, colours and sizes.
 * Written only here; the storefront and admin read them directly (public read in firestore.rules).
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

const COLLECTION = { category: "categories", brand: "brands", color: "colors", size: "sizes" };

/**
 * Create or update one item. Slugs (categories, brands) must be unique.
 * @param {"category" | "brand" | "color" | "size"} kind
 * @param {Record<string, any> & { id?: string }} input already validated
 * @param {string} actorUid
 */
export async function saveCatalogItem(kind, input, actorUid) {
  const col = db.collection(COLLECTION[kind]);
  const { id, ...data } = input;
  const ref = id ? col.doc(id) : col.doc();

  await db.runTransaction(async (tx) => {
    const current = id ? await tx.get(ref) : null;
    if (id && !current.exists) throw new AppError("not-found", "That item no longer exists.");

    if ("slug" in data) {
      const clash = await tx.get(col.where("slug", "==", data.slug).limit(2));
      if (clash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `The web address "${data.slug}" is already used. Choose another.`, { fields: { slug: "Already used" } });
    }
    if (kind === "category" && data.parentId) {
      if (data.parentId === ref.id) throw new AppError("invalid-argument", "A category can't be inside itself.", { fields: { parentId: "Choose another parent" } });
      const parent = await tx.get(col.doc(data.parentId));
      if (!parent.exists) throw new AppError("invalid-argument", "The parent category doesn't exist.", { fields: { parentId: "Not found" } });
      if (parent.data().parentId) throw new AppError("invalid-argument", "Categories can be nested one level deep only.", { fields: { parentId: "Choose a top-level category" } });
    }
    if (kind === "color") {
      const clash = await tx.get(col.where("name", "==", data.name).limit(2));
      if (clash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `A colour called "${data.name}" already exists.`, { fields: { name: "Already exists" } });
    }
    if (kind === "size") {
      const clash = await tx.get(col.where("system", "==", data.system).where("value", "==", data.value).limit(2));
      if (clash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `Size ${data.system} ${data.value} already exists.`, { fields: { value: "Already exists" } });
    }

    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (current) tx.update(ref, { ...data, ...stamp });
    else tx.create(ref, { ...data, ...stamp, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: `${kind}.${current ? "updated" : "created"}`, entityType: kind, entityId: ref.id, changes: { after: data } }, tx);
  });
  return { id: ref.id };
}

/**
 * Delete an item only if nothing uses it (products, variants or sub-categories). Otherwise the
 * owner should deactivate it instead, so past orders and products keep their meaning.
 * @param {"category" | "brand" | "color" | "size"} kind
 * @param {string} id
 * @param {string} actorUid
 */
export async function deleteCatalogItem(kind, id, actorUid) {
  const ref = db.collection(COLLECTION[kind]).doc(id);
  const usage = {
    category: () => db.collection("products").where("categoryId", "==", id).limit(1).get(),
    brand: () => db.collection("products").where("brandId", "==", id).limit(1).get(),
    color: () => db.collectionGroup("variants").where("colorId", "==", id).limit(1).get(),
    size: () => db.collectionGroup("variants").where("sizeId", "==", id).limit(1).get(),
  }[kind];

  if (!(await usage()).empty) {
    throw new AppError("failed-precondition", `This ${kind} is used by products, so it can't be deleted.${kind === "category" ? " Mark it inactive instead." : ""}`);
  }
  if (kind === "category" && !(await db.collection("categories").where("parentId", "==", id).limit(1).get()).empty) {
    throw new AppError("failed-precondition", "This category has sub-categories. Move or delete them first.");
  }
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That item no longer exists.");
  await ref.delete();
  await writeAudit({ actorUid, action: `${kind}.deleted`, entityType: kind, entityId: id, changes: { before: snap.data() } });
  return { id };
}
