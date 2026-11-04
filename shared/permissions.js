/**
 * Permission keys and the default permissions of each staff role.
 *
 * Roles are seeded into Firestore (`roles/{key}`) by migration 001 from these defaults; after that
 * the Owner can change them in the admin. A staff member's effective permissions are written into
 * their Firebase Auth custom claims, and every protected Cloud Function and security rule checks
 * those claims on the server.
 */

/** @type {Record<string, string>} permission → description shown in the admin */
export const PERMISSIONS = {
  "products.read": "View products, variants and categories",
  "products.write": "Create, edit, publish and archive products, categories and images",
  "costs.read": "See and edit cost prices",
  "inventory.read": "View stock levels and stock history",
  "inventory.adjust": "Add or adjust stock",
  "orders.read": "View orders",
  "orders.update": "Change order status, add notes and shipments",
  "orders.export": "Export orders and print invoices",
  "payments.update": "Record COD collection and refunds",
  "customers.read": "View customers and their order history",
  "customers.manage": "Disable or re-enable customer accounts",
  "coupons.manage": "Create and edit coupons",
  "shipping.manage": "Set delivery methods and charges",
  "content.manage": "Edit banners, homepage text, pages and FAQs",
  "reviews.moderate": "Approve or reject reviews",
  "reports.sales": "Sales and order reports",
  "reports.inventory": "Inventory reports",
  "staff.manage": "Invite staff and assign roles",
  "settings.manage": "Change store settings",
  "audit.read": "View the activity log",
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/** @type {Record<string, {name: string, permissions: string[]}>} */
export const DEFAULT_ROLES = {
  owner: {
    name: "Owner",
    permissions: ALL_PERMISSIONS,
  },
  inventory_manager: {
    name: "Inventory Manager",
    permissions: ["products.read", "products.write", "costs.read", "inventory.read", "inventory.adjust", "orders.read", "reports.inventory"],
  },
  order_manager: {
    name: "Order Manager",
    permissions: [
      "products.read",
      "orders.read",
      "orders.update",
      "orders.export",
      "payments.update",
      "customers.read",
      "customers.manage",
      "coupons.manage",
      "shipping.manage",
      "reports.sales",
    ],
  },
  content_manager: {
    name: "Content Manager",
    permissions: ["products.read", "content.manage", "reviews.moderate"],
  },
};

/** Permissions only the Owner role may ever hold, whatever the Owner edits. */
export const OWNER_ONLY = ["staff.manage", "settings.manage", "audit.read"];

/**
 * Union of permissions for a set of roles, ignoring unknown keys.
 * @param {string[]} roleKeys
 * @param {Record<string, {permissions: string[]}>} roles
 */
export function effectivePermissions(roleKeys, roles = DEFAULT_ROLES) {
  const set = new Set();
  for (const key of roleKeys) {
    for (const p of roles[key]?.permissions ?? []) {
      if (!(p in PERMISSIONS)) continue;
      if (OWNER_ONLY.includes(p) && key !== "owner") continue;
      set.add(p);
    }
  }
  return [...set].sort();
}
