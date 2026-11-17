export * from "./common.js";
export * from "./catalog.js";
export * from "./checkout.js";
export * from "./commerce.js";
export * from "./account.js";
export * from "./orders.js";

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
export * from "./engage.js";
export * from "./warehouses.js";
export * from "./purchasing.js";
export * from "./sales.js";
export * from "./accounting.js";
export * from "./pos.js";
export * from "./finance.js";
export * from "./inventory.js";
export * from "./crm.js";
export * from "./analytics.js";
export * from "./hr.js";
