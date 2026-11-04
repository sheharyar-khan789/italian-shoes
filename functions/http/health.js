import { onRequest } from "firebase-functions/v2/https";
import { db } from "../lib/admin.js";
import { log } from "../lib/logger.js";

/**
 * GET /healthCheck — confirms the functions runtime is up and Firestore is reachable.
 * Returns no data beyond status, so it is safe to leave public.
 */
export const healthCheck = onRequest({ cors: false }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).set("Allow", "GET").json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const migrations = await db.collection("_migrations").count().get();
    res.set("Cache-Control", "no-store").json({ ok: true, firestore: "reachable", migrationsApplied: migrations.data().count });
  } catch (error) {
    log.error("Health check: Firestore unreachable", error);
    res.status(503).set("Cache-Control", "no-store").json({ ok: false, firestore: "unreachable" });
  }
});
