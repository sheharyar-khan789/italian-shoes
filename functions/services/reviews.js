/**
 * Reviews. Only a customer whose order containing the product was DELIVERED can review it
 * (so every review is a verified purchase). One review per customer per product; editing it sends
 * it back for moderation. Only approved reviews are public.
 *
 *   reviews/{productId}__{uid}   productId, userId, authorName, rating, title, body, status, reply
 *   products/{id}.rating         { avg, count } over approved reviews (computed here, never by browsers)
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { assertNotSuspended } from "./orders.js";

const reviews = () => db.collection("reviews");

/** "Ayesha Khan" → "Ayesha K." so a full name is never published. */
export function publicName(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Customer";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export async function recomputeRating(productId) {
  const approved = await reviews().where("productId", "==", productId).where("status", "==", "approved").get();
  const count = approved.size;
  const avg = count ? Math.round((approved.docs.reduce((n, d) => n + d.data().rating, 0) / count) * 10) / 10 : 0;
  const ref = db.collection("products").doc(productId);
  if ((await ref.get()).exists) await ref.update({ rating: { avg, count } });
  return { avg, count };
}

/** @param {Record<string, any>} input validated submitReviewInput @param {{ uid: string }} who */
export async function submitReview(input, { uid }) {
  await assertNotSuspended(uid);
  const delivered = await db.collection("orders").where("userId", "==", uid).where("status", "==", "delivered").get();
  const order = delivered.docs.find((d) => d.data().items?.some((l) => l.productId === input.productId));
  if (!order) throw new AppError("failed-precondition", "You can review a product after your order for it has been delivered.");
  const line = order.data().items.find((l) => l.productId === input.productId);

  const ref = reviews().doc(`${input.productId}__${uid}`);
  const existed = (await ref.get()).exists;
  await ref.set(
    {
      productId: input.productId,
      productName: line.productName,
      userId: uid,
      orderId: order.id,
      authorName: publicName(order.data().customer?.name),
      rating: input.rating,
      title: input.title,
      body: input.body,
      status: "pending",
      reply: "",
      verifiedPurchase: true,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existed ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  if (existed) await recomputeRating(input.productId); // an edited review leaves the public list until re-approved
  await notify({ type: "review.new", audience: "reviews.moderate", title: `New review for ${line.productName}`, body: `${input.rating}★`, link: "/admin/reviews", data: { reviewId: ref.id } });
  return { id: ref.id, status: "pending" };
}

/** @param {{ reviewId: string, status: string, reply: string }} input @param {string} actorUid */
export async function moderateReview({ reviewId, status, reply }, actorUid) {
  const ref = reviews().doc(reviewId);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That review no longer exists.");
  await ref.update({ status, reply, moderatedBy: actorUid, moderatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid, action: "review.moderated", entityType: "review", entityId: reviewId, changes: { from: snap.data().status, to: status } });
  return { reviewId, ...(await recomputeRating(snap.data().productId)) };
}

export async function deleteReview(reviewId, actorUid) {
  const ref = reviews().doc(reviewId);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That review no longer exists.");
  await ref.delete();
  await writeAudit({ actorUid, action: "review.deleted", entityType: "review", entityId: reviewId });
  await recomputeRating(snap.data().productId);
  return { reviewId };
}
