/**
 * Every server endpoint, by name. api/call.js looks the requested name up here.
 * (Cloud Functions are not used: the project stays on free plans, so the same code runs on Vercel.)
 */
import * as staff from "./callable/staff.js";
import * as settings from "./callable/settings.js";
import * as catalog from "./callable/catalog.js";
import * as orders from "./callable/orders.js";
import * as payments from "./callable/payments.js";
import * as coupons from "./callable/coupons.js";
import * as engage from "./callable/engage.js";

/** @type {Record<string, import("./lib/callable.js").Endpoint>} */
export const endpoints = {};
for (const mod of [staff, settings, catalog, orders, payments, coupons, engage]) {
  for (const value of Object.values(mod)) {
    if (value && typeof value === "object" && "__endpoint" in value) endpoints[/** @type {any} */ (value).name] = /** @type {any} */ (value);
  }
}
