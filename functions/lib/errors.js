/**
 * Errors with a safe, customer-facing message.
 *
 * Throw AppError for anything the caller should know about (bad input, not allowed, out of stock).
 * Anything else is an unexpected failure: it is logged in full on the server and the caller only
 * sees a generic message, so internal details and database errors never leak to customers.
 */
import { HttpsError } from "firebase-functions/v2/https";
import { log } from "./logger.js";

/** Codes understood by Firebase callable functions. */
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
]);

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
 * Convert any thrown value into an HttpsError for callable functions.
 * @param {unknown} error
 * @param {string} where function name, for the log
 */
export function toHttpsError(error, where) {
  if (error instanceof HttpsError) return error;
  if (error instanceof AppError) return new HttpsError(/** @type {any} */ (error.code), error.message, error.details);
  log.error(`Unexpected error in ${where}`, error);
  return new HttpsError("internal", "Something went wrong on our side. Please try again.");
}

/**
 * Wrap a callable handler so every error goes through toHttpsError.
 * @template T
 * @param {string} name
 * @param {(request: import("firebase-functions/v2/https").CallableRequest) => Promise<T>} handler
 */
export const safeHandler = (name, handler) => async (request) => {
  try {
    return await handler(request);
  } catch (error) {
    throw toHttpsError(error, name);
  }
};
