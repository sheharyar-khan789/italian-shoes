/**
 * The ONE way to define a server endpoint in this project (it runs on Vercel, in api/call.js).
 * An endpoint is defined with secureCallable(); runEndpoint() then applies, in order:
 *
 *   1. Auth          — the Firebase ID token in "Authorization: Bearer <token>" is VERIFIED by the Admin SDK
 *   2. Permission    — `permission: "orders.update"` checks the staff custom claims inside that token,
 *                      and (for staff) that the account is still enabled and not revoked
 *   3. Rate limit    — per user (or per IP when signed out), stored in Firestore
 *   4. Validation    — the shared Zod schema; only cleaned data reaches the handler
 *   5. Safe errors   — internal errors never reach the browser (see errors.js)
 *
 * Usage:
 *   export const placeOrder = secureCallable("placeOrder",
 *     { auth: "required", schema: placeOrderSchema, rateLimit: { limit: 10, windowSeconds: 600 } },
 *     async ({ data, uid }) => orders.place(data, uid));
 */
import { AppError, toApiError } from "./errors.js";
import { auth as adminAuth } from "./admin.js";
import { parse } from "./validate.js";
import { consumeRateLimit, callerIp } from "./rateLimit.js";

/** Default limit when an endpoint doesn't set its own: 60 calls per minute per caller. */
const DEFAULT_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

/**
 * @typedef {{ data: any, uid: string | null, token: Record<string, any> | null }} Ctx
 * @typedef {{ __endpoint: true, name: string, options: { auth: "required" | "optional", permission?: string, schema?: import("zod").ZodType, rateLimit: { limit: number, windowSeconds: number } | false }, handler: (ctx: Ctx) => Promise<any> }} Endpoint
 */

/**
 * @param {string} name
 * @param {{
 *   auth?: "required" | "optional",
 *   permission?: string,
 *   schema?: import("zod").ZodType,
 *   rateLimit?: { limit: number, windowSeconds: number } | false,
 * }} options
 * @param {(ctx: Ctx) => Promise<any>} handler
 * @returns {Endpoint}
 */
export function secureCallable(name, options, handler) {
  const { auth = "required", permission, schema, rateLimit = DEFAULT_RATE_LIMIT } = options;
  if (permission && auth !== "required") throw new Error(`${name}: a permission check requires auth: "required"`);
  return { __endpoint: true, name, options: { auth, permission, schema, rateLimit }, handler };
}

/** Verify a Firebase ID token. Rejects expired or forged tokens. @param {string} idToken */
const defaultVerify = (idToken) => adminAuth.verifyIdToken(idToken);

/**
 * Run one request through an endpoint. Never throws: returns the HTTP status and JSON body to send.
 * @param {Endpoint} endpoint
 * @param {{ authorization?: string, body: unknown, headers?: Record<string, any> }} req
 * @param {{ verifyToken?: (idToken: string) => Promise<Record<string, any>> }} [deps]
 * @returns {Promise<{ status: number, body: Record<string, any> }>}
 */
export async function runEndpoint(endpoint, req, { verifyToken = defaultVerify } = {}) {
  const { name, options, handler } = endpoint;
  try {
    /** @type {Record<string, any> | null} */
    let token = null;
    const bearer = /^Bearer (.+)$/i.exec(req.authorization ?? "")?.[1];
    if (bearer) {
      try {
        token = await verifyToken(bearer);
      } catch {
        throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
      }
    }
    const uid = token?.uid ?? null;

    if (options.auth === "required" && !uid) throw new AppError("unauthenticated", "Please sign in to continue.");
    if (options.permission) {
      if (!hasPermission(token, options.permission)) throw new AppError("permission-denied", "You don't have permission to do this.");
      await assertSessionStillValid(/** @type {string} */ (uid), /** @type {Record<string, any>} */ (token));
    }
    if (options.rateLimit) await consumeRateLimit(name, uid ?? `ip:${callerIp({ headers: req.headers })}`, options.rateLimit);

    // The browser sends { data: ... }; anything else is treated as no data.
    const raw = req.body && typeof req.body === "object" && "data" in req.body ? /** @type {any} */ (req.body).data : undefined;
    const data = options.schema ? parse(options.schema, raw) : raw;
    const result = await handler({ data, uid, token });
    return { status: 200, body: { data: result ?? null } };
  } catch (error) {
    return toApiError(error, name);
  }
}

/**
 * @param {Record<string, any> | null} token decoded Firebase ID token (custom claims included)
 * @param {string} permission
 */
export function hasPermission(token, permission) {
  return Boolean(token && token.staff === true && Array.isArray(token.perms) && token.perms.includes(permission));
}

/**
 * Firebase ID tokens stay valid for up to an hour. For staff actions, check live that the account
 * is still enabled and that its sessions were not revoked after this token was issued (revocation
 * happens when a staff member is disabled, loses a role, or changes their password).
 * @param {string} uid
 * @param {Record<string, any>} token
 */
export async function assertSessionStillValid(uid, token) {
  const user = await adminAuth.getUser(uid);
  if (user.disabled) throw new AppError("permission-denied", "This account has been disabled.");
  const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) / 1000 : 0;
  if (Number(token.auth_time) < validAfter) throw new AppError("unauthenticated", "Your session has ended. Please sign in again.");
}
