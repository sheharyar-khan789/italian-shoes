/**
 * HTTP layer for the endpoints, independent of Vercel so it can be tested directly.
 * api/call.js passes each request here and sends back what it returns.
 */
import { endpoints } from "./registry.js";
import { runEndpoint } from "./lib/callable.js";
import { db } from "./lib/admin.js";
import { log } from "./lib/logger.js";
import { loadPublicCatalog } from "./services/publicCatalog.js";

/**
 * @param {{ method: string, name: string, headers: Record<string, any>, body: unknown }} req
 * @param {{ verifyToken?: (idToken: string) => Promise<Record<string, any>> }} [deps]
 * @returns {Promise<{ status: number, body: Record<string, any>, headers?: Record<string, string> }>}
 */
export async function handleApi({ method, name, headers, body }, deps) {
  const noStore = { "Cache-Control": "no-store" };

  if (name === "healthCheck") {
    if (method !== "GET") return { status: 405, body: { ok: false, error: "Method not allowed" }, headers: { ...noStore, Allow: "GET" } };
    try {
      await db.collection("_migrations").limit(1).get();
      return { status: 200, body: { ok: true, firestore: "reachable" }, headers: noStore };
    } catch (error) {
      log.error("Health check: Firestore unreachable", error);
      return { status: 503, body: { ok: false, firestore: "unreachable" }, headers: noStore };
    }
  }

  if (name === "catalog") {
    if (method !== "GET") return { status: 405, body: { error: { code: "invalid-argument", message: "Method not allowed." } }, headers: { ...noStore, Allow: "GET" } };
    try {
      // Public data: cached at the edge for 30 s (stale copy served while refreshing), so traffic doesn't hit the database.
      return { status: 200, body: await loadPublicCatalog(), headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" } };
    } catch (error) {
      log.error("Catalog unavailable", error);
      return { status: 503, body: { error: { code: "unavailable", message: "The shop is unavailable right now." } }, headers: noStore };
    }
  }

  const endpoint = Object.hasOwn(endpoints, name) ? endpoints[name] : null;
  if (!endpoint) return { status: 404, body: { error: { code: "not-found", message: "Not found." } }, headers: noStore };
  if (method !== "POST") return { status: 405, body: { error: { code: "invalid-argument", message: "Method not allowed." } }, headers: { ...noStore, Allow: "POST" } };
  if (!/^application\/json/i.test(String(headers["content-type"] ?? ""))) {
    return { status: 415, body: { error: { code: "invalid-argument", message: "Send JSON." } }, headers: noStore };
  }

  const result = await runEndpoint(endpoint, { authorization: headers.authorization, body, headers }, deps);
  return { ...result, headers: noStore };
}
