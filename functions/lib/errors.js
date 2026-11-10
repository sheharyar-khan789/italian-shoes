/**
 * Errors with a safe, customer-facing message.
 *
 * Throw AppError for anything the caller should know about (bad input, not allowed, out of stock).
 * Anything else is an unexpected failure: it is logged in full on the server and the caller only
 * sees a generic message, so internal details and database errors never leak to customers.
 */
import { log } from "./logger.js";

/** Error codes (same names Firebase callable functions used, so the screens didn't change). */
const CODES = new Set([
  "invalid-argument",
  "failed-precondition",
  "out-of-range",
  "unauthenticated",
  "permission-denied",
  "not-found",
  "already-exists",
  "resource-exhausted",
  "aborted",
  "unavailable",
  "internal",
]);

/** HTTP status for each code. */
export const STATUS_OF = {
  "invalid-argument": 400,
  "failed-precondition": 400,
  "out-of-range": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  aborted: 409,
  "resource-exhausted": 429,
  unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe to show to the user
   * @param {Record<string, unknown>} [details] safe to show (e.g. field errors)
   */
  constructor(code, message, details) {
    super(message);
    if (!CODES.has(code)) throw new TypeError(`Unknown error code ${code}`);
    this.code = code;
    this.details = details;
  }
}

/**
 * Convert any thrown value into the safe error the browser receives.
 * @param {unknown} error
 * @param {string} where endpoint name, for the log
 * @returns {{ status: number, body: { error: { code: string, message: string, details?: Record<string, unknown> } } }}
 */
export function toApiError(error, where) {
  if (error instanceof AppError) {
    return { status: STATUS_OF[error.code] ?? 500, body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } };
  }
  log.error(`Unexpected error in ${where}`, error);
  return { status: 500, body: { error: { code: "internal", message: "Something went wrong on our side. Please try again." } } };
}
