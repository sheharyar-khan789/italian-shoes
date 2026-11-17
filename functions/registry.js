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
import * as warehouses from "./callable/warehouses.js";
import * as purchasing from "./callable/purchasing.js";
import * as sales from "./callable/sales.js";
import * as accounting from "./callable/accounting.js";
import * as pos from "./callable/pos.js";
import * as finance from "./callable/finance.js";
import * as inventoryAdvanced from "./callable/inventory.js";
import * as crmEndpoints from "./callable/crm.js";
import * as analyticsEndpoints from "./callable/analytics.js";
import * as hrEndpoints from "./callable/hr.js";

/** @type {Record<string, import("./lib/callable.js").Endpoint>} */
export const endpoints = {};
for (const mod of [staff, settings, catalog, orders, payments, coupons, engage, warehouses, purchasing, sales, accounting, pos, finance, inventoryAdvanced, crmEndpoints, analyticsEndpoints, hrEndpoints]) {
  for (const value of Object.values(mod)) {
    if (value && typeof value === "object" && "__endpoint" in value) {
      const name = /** @type {any} */ (value).name;
      // Two endpoints with one name would silently replace each other: refuse to start instead.
      if (endpoints[name]) throw new Error(`Duplicate endpoint name "${name}"`);
      endpoints[name] = /** @type {any} */ (value);
    }
  }
}
