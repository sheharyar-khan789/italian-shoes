export * from "./common.js";
export * from "./catalog.js";
export * from "./checkout.js";
export * from "./commerce.js";

/**
 * Turn a Zod error into { field: message } for forms and API responses.
 * Nested paths are joined with dots ("items.0.qty").
 * @param {import("zod").ZodError} error
 */
export function fieldErrors(error) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
