/**
 * Fixed-window rate limiting backed by Firestore, so the limit holds across every Cloud Functions
 * instance (an in-memory counter would reset per instance and be easy to bypass).
 *
 * Documents live in `_rateLimits/{bucket}` and carry `expireAt`; enable a Firestore TTL policy on
 * that field (see SECURITY.md) so old buckets are deleted automatically.
 */
import { createHash } from "node:crypto";
import { db, Timestamp } from "./admin.js";
import { AppError } from "./errors.js";

/**
 * @param {string} action   e.g. "placeOrder"
 * @param {string} identity uid, or the caller's IP for signed-out requests
 * @param {{ limit: number, windowSeconds: number }} rule
 * @param {{ now?: number, firestore?: import("firebase-admin/firestore").Firestore }} [deps]
 */
export async function consumeRateLimit(action, identity, { limit, windowSeconds }, { now = Date.now(), firestore = db } = {}) {
  if (!identity) identity = "unknown";
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  // Hash the identity so raw IP addresses and uids are not stored as document ids.
  const bucket = createHash("sha256").update(`${action}|${identity}|${windowStart}`).digest("hex").slice(0, 40);
  const ref = firestore.collection("_rateLimits").doc(bucket);

  const count = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = (snap.exists ? snap.data().count : 0) + 1;
    if (next > limit) return next;
    tx.set(ref, { action, count: next, windowStart, expireAt: Timestamp.fromMillis(windowStart + windowMs * 2) });
    return next;
  });

  if (count > limit) {
    const retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
    throw new AppError("resource-exhausted", `Too many attempts. Please wait ${retryAfter} seconds and try again.`, { retryAfter });
  }
  return { remaining: limit - count };
}

/** Best-effort client IP for signed-out callers (Cloud Functions sit behind Google's front end). */
export function callerIp(rawRequest) {
  const forwarded = rawRequest?.headers?.["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first || rawRequest?.ip || "unknown").trim();
}
