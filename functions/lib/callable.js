/**
 * The ONE way to create a callable Cloud Function in this project. It applies, in order:
 *
 *   1. App Check     — rejects requests that don't come from the real website (when enabled)
 *   2. Auth          — `auth: "required"` rejects signed-out callers
 *   3. Permission    — `permission: "orders.update"` checks the caller's staff custom claims
 *   4. Rate limit    — per user (or per IP when signed out)
 *   5. Validation    — the shared Zod schema; only cleaned data reaches the handler
 *   6. Safe errors   — internal errors never reach the browser
 *
 * Usage (from Phase 3):
 *   export const placeOrder = secureCallable("placeOrder",
 *     { auth: "optional", schema: placeOrderSchema, rateLimit: { limit: 10, windowSeconds: 600 } },
 *     async ({ data, uid }) => orders.place(data, uid));
 */
import { onCall } from "firebase-functions/v2/https";
import { AppError, safeHandler } from "./errors.js";
import { auth as adminAuth } from "./admin.js";
import { parse } from "./validate.js";
import { consumeRateLimit, callerIp } from "./rateLimit.js";

/**
 * App Check is enforced in production once a reCAPTCHA Enterprise key is configured
 * (APP_CHECK_ENFORCE=true in functions/.env.<project>). Never in the emulators.
 */
export const appCheckEnforced = () => process.env.FUNCTIONS_EMULATOR !== "true" && process.env.APP_CHECK_ENFORCE === "true";

/** Default limit when a function doesn't set its own: 60 calls per minute per caller. */
const DEFAULT_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

/**
 * @template T
 * @param {string} name
 * @param {{
 *   auth?: "required" | "optional",
 *   permission?: string,
 *   schema?: import("zod").ZodType,
 *   rateLimit?: { limit: number, windowSeconds: number } | false,
 * }} options
 * @param {(ctx: { data: any, uid: string | null, token: Record<string, any> | null, request: import("firebase-functions/v2/https").CallableRequest }) => Promise<T>} handler
 */
export function secureCallable(name, options, handler) {
  const { auth = "required", permission, schema, rateLimit = DEFAULT_RATE_LIMIT } = options;
  if (permission && auth !== "required") throw new Error(`${name}: a permission check requires auth: "required"`);

  return onCall(
    { enforceAppCheck: appCheckEnforced(), consumeAppCheckToken: false },
    safeHandler(name, async (request) => {
      const uid = request.auth?.uid ?? null;
      const token = request.auth?.token ?? null;

      if (auth === "required" && !uid) throw new AppError("unauthenticated", "Please sign in to continue.");
      if (permission) {
        if (!hasPermission(token, permission)) throw new AppError("permission-denied", "You don't have permission to do this.");
        await assertSessionStillValid(uid, token);
      }
      if (rateLimit) await consumeRateLimit(name, uid ?? `ip:${callerIp(request.rawRequest)}`, rateLimit);

      const data = schema ? parse(schema, request.data) : request.data;
      return handler({ data, uid, token, request });
    }),
  );
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
async function assertSessionStillValid(uid, token) {
  const user = await adminAuth.getUser(uid);
  if (user.disabled) throw new AppError("permission-denied", "This account has been disabled.");
  const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) / 1000 : 0;
  if (Number(token.auth_time) < validAfter) throw new AppError("unauthenticated", "Your session has ended. Please sign in again.");
}
