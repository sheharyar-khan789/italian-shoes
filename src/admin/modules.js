/**
 * Admin modules. `perm` decides who sees a module in the sidebar (the server enforces access again).
 * Modules marked `soon` are shown as disabled, labelled items — never as working buttons — until
 * the phase that builds them.
 */

/** @typedef {{ key: string, label: string, path: string, perm: string | null, soon?: string, load?: () => Promise<{ default: (ctx: any) => any }> }} AdminModule */

/** @type {AdminModule[]} */
export const MODULES = [
  { key: "overview", label: "Overview", path: "/admin", perm: null, load: () => import("./views/overview.js") },
  { key: "products", label: "Products", path: "/admin/products", perm: "products.read", load: () => import("./views/products.js") },
  { key: "inventory", label: "Inventory & Stock", path: "/admin/inventory", perm: "inventory.read", load: () => import("./views/inventory.js") },
  { key: "categories", label: "Categories & Sizes", path: "/admin/categories", perm: "products.write", load: () => import("./views/catalogue.js") },
  { key: "orders", label: "Orders", path: "/admin/orders", perm: "orders.read", load: () => import("./views/orders.js") },
  { key: "payments", label: "Payments", path: "/admin/payments", perm: "payments.update", load: () => import("./views/payments.js") },
  { key: "shipping", label: "Shipping", path: "/admin/shipping", perm: "shipping.manage", load: () => import("./views/shipping.js") },
  { key: "customers", label: "Customers", path: "/admin/customers", perm: "customers.read", load: () => import("./views/customers.js") },
  { key: "coupons", label: "Coupons & Offers", path: "/admin/coupons", perm: "coupons.manage", load: () => import("./views/coupons.js") },
  { key: "reviews", label: "Reviews", path: "/admin/reviews", perm: "reviews.moderate", load: () => import("./views/reviews.js") },
  { key: "reports", label: "Analytics & Reports", path: "/admin/reports", perm: "reports.sales", load: () => import("./views/reports.js") },
  { key: "content", label: "Website Content", path: "/admin/content", perm: "content.manage", load: () => import("./views/content.js") },
  { key: "staff", label: "Staff & Roles", path: "/admin/staff", perm: "staff.manage", load: () => import("./views/staff.js") },
  { key: "notifications", label: "Notifications", path: "/admin/notifications", perm: null, load: () => import("./views/notifications.js") },
  { key: "activity", label: "Activity Log", path: "/admin/activity", perm: "audit.read", load: () => import("./views/activity.js") },
  { key: "settings", label: "Store Settings", path: "/admin/settings", perm: "settings.manage", load: () => import("./views/settings.js") },
];

/** Modules this person may see. @param {string[]} perms */
export const visibleModules = (perms) => MODULES.filter((m) => !m.perm || perms.includes(m.perm));

/**
 * Module for a path, plus the sub-path segments ("/admin/products/abc" → products, ["abc"]).
 * @param {string} path
 */
export const moduleForPath = (path) => {
  const clean = path.replace(/\/+$/, "") || "/admin";
  if (clean === "/admin") return MODULES[0];
  return MODULES.find((m) => m.path !== "/admin" && (clean === m.path || clean.startsWith(`${m.path}/`))) ?? null;
};

/** @param {string} path @param {AdminModule} mod */
export const subPath = (path, mod) =>
  path
    .replace(/\/+$/, "")
    .slice(mod.path.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
