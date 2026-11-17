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
  "warehouses.manage": "Create, edit, activate and deactivate warehouses",
  "transfers.manage": "Create, send, receive and cancel stock transfers",
  "purchases.read": "View suppliers, purchase orders, goods received, supplier payments, returns, ledgers and purchase reports",
  "suppliers.manage": "Create, edit and deactivate suppliers",
  "purchases.manage": "Create and approve purchase orders, receive goods and record purchase returns",
  "suppliers.pay": "Record payments made to suppliers",
  "sales.read": "View the unified sales list, sale details and sales totals",
  "accounting.read": "View the chart of accounts, journals, ledgers, trial balance and accounting reports",
  "accounting.manage": "Set up the chart of accounts, opening balances and posting accounts",
  "accounting.post": "Create and post manual journal entries",
  "accounting.close": "Close and reopen accounting periods (nothing can be posted into a closed period)",
  "accounting.reconcile": "Reconcile bank and wallet accounts with the statement",
  "accounting.reverse": "Reverse posted journal entries",
  "pos.access": "Open the point of sale screen",
  "pos.sell": "Make point-of-sale sales and take payments",
  "pos.register": "Open and close a cash register",
  "pos.cash": "Record cash in and cash out of a register, and close other people's registers",
  "pos.override": "Give discounts and change prices at the counter",
  "pos.sessions.read": "View register sessions and their cash reconciliation",
  "pos.reports": "View point-of-sale reports",
  "pos.return": "Take back goods from a walk-in sale: refund, store the stock again, or exchange",
  "finance.read": "View income, expenses, cash and bank movements, the financial dashboard and reports",
  "finance.write": "Record and edit income, expenses, transfers and cash counts",
  "finance.void": "Delete (void) income, expense and transfer entries; the books are corrected by a reversal",
  "finance.approve": "Approve or reject expenses that need approval, and enter large expenses without approval",
  "finance.adjust": "Post authorised cash adjustments after a cash count",
  "finance.manage": "Set up income and expense categories, bank accounts, approval limit and recurring expenses",
  "suppliers.adjust": "Record advance payments to suppliers, supplier refunds and manual supplier balance adjustments",
  "inventory.count": "Run physical stock counts",
  "inventory.approve": "Approve stock adjustments and stock counts, enter large adjustments directly, and revalue stock cost",
  "inventory.manage": "Set stock levels, storage locations, alert thresholds and barcodes",
  "crm.read": "View CRM customers, their purchase history, loyalty points and CRM reports (includes contact details)",
  "crm.write": "Create and edit CRM customers, add notes, complaints and follow-ups, and create a customer at the POS",
  "crm.manage": "Set up customer types, groups, membership tiers, loyalty rules and customer discounts; archive customers",
  "crm.loyalty": "Adjust a customer's loyalty points by hand",
  "analytics.read": "View sales, product, customer, inventory and purchase analytics (customer and cost detail also need crm.read / costs.read)",
  "analytics.financial": "View profit, financial statements and financial analytics (needs accounting.read and costs.read too)",
  "analytics.executive": "View the executive business dashboard (all sales, financial, stock and customer figures together)",
  "analytics.export": "Export, print and download analytics reports",
  "analytics.manage": "Save report configurations and set up scheduled reports",
  "hr.read": "View the employee directory, attendance, leave and the HR dashboard (includes personal contact details, not salary or CNIC)",
  "hr.write": "Add and edit employees, departments, designations and assignments",
  "hr.sensitive": "View and manage employee CNIC numbers and personal documents",
  "hr.salary.read": "View salaries, payslips, advances, loans and payroll",
  "hr.salary.write": "Set or change an employee's basic salary and allowances",
  "hr.attendance": "Mark and correct attendance; manage shifts and holidays",
  "hr.leave.manage": "Approve or reject leave and adjust leave balances",
  "hr.payroll.generate": "Generate and recalculate monthly payroll and add bonuses or deductions",
  "hr.payroll.approve": "Approve or reverse a payroll run (posts it to the accounts)",
  "hr.payroll.pay": "Record salary payments",
  "hr.advances.manage": "Approve and pay out salary advances and employee loans",
  "hr.manage": "Set up leave types, employment types, commission rules and HR rules",
  "hr.export": "Export, print and download HR and payroll reports",
  "hr.self": "View your own profile, attendance and payslips, and apply for leave",
};

/**
 * Permissions added after the roles were first seeded into Firestore (migration 001). Role documents
 * already in the database keep their saved list, so loadRoles() (services/staff.js) adds these to the
 * system roles that hold them by default. Nothing is removed and no role document is rewritten.
 */
export const PERMISSIONS_ADDED_LATER = ["warehouses.manage", "transfers.manage", "purchases.read", "suppliers.manage", "purchases.manage", "suppliers.pay", "sales.read", "accounting.read", "accounting.manage", "accounting.post", "accounting.reverse", "accounting.close", "accounting.reconcile", "pos.access", "pos.sell", "pos.register", "pos.cash", "pos.override", "pos.sessions.read", "pos.reports", "pos.return", "finance.read", "finance.write", "finance.void", "finance.approve", "finance.adjust", "finance.manage", "suppliers.adjust", "inventory.count", "inventory.approve", "inventory.manage", "crm.read", "crm.write", "crm.manage", "crm.loyalty", "analytics.read", "analytics.financial", "analytics.executive", "analytics.export", "analytics.manage", "hr.read", "hr.write", "hr.sensitive", "hr.salary.read", "hr.salary.write", "hr.attendance", "hr.leave.manage", "hr.payroll.generate", "hr.payroll.approve", "hr.payroll.pay", "hr.advances.manage", "hr.manage", "hr.export", "hr.self"];

/**
 * Roles the owner can create for the counter (an explicit owner action, never automatic). A cashier can sell and
 * run their own register, but cannot move cash, change prices, see other registers or grant anyone anything.
 * @type {Record<string, { name: string, permissions: string[] }>}
 */
export const POS_ROLES = {
  cashier: { name: "Cashier", permissions: ["pos.access", "pos.sell", "pos.register"] },
  pos_manager: { name: "POS Manager", permissions: ["pos.access", "pos.sell", "pos.register", "pos.cash", "pos.override", "pos.sessions.read", "pos.reports", "pos.return"] },
};

/**
 * HR roles (created by the Owner with one action, like the POS roles; existing roles are left alone). The HR Manager runs people, attendance, leave and payroll
 * preparation; the Payroll Accountant approves and pays payroll but can't change who works here; the Employee role sees only their own records.
 * @type {Record<string, { name: string, permissions: string[] }>}
 */
export const HR_ROLES = {
  hr_manager: { name: "HR Manager", permissions: ["hr.read", "hr.write", "hr.sensitive", "hr.attendance", "hr.leave.manage", "hr.payroll.generate", "hr.advances.manage", "hr.manage", "hr.salary.read", "hr.salary.write", "hr.export"] },
  payroll_accountant: { name: "Payroll Accountant", permissions: ["hr.read", "hr.salary.read", "hr.payroll.approve", "hr.payroll.pay", "hr.advances.manage", "hr.export", "accounting.read", "finance.read"] },
  employee: { name: "Employee", permissions: ["hr.self"] },
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/**
 * A Firebase sign-in token can carry at most 1,000 characters of custom claims, and the Owner holds every permission (the list no longer fits).
 * So a person who holds ALL permissions is given the single claim "*"; the server, the security rules and the admin app expand it back. Everyone
 * else keeps the plain list. Future permissions are automatically included for the Owner.
 */
export const ALL_CLAIM = "*";
/** The claim to store for a set of permissions: "*" when it is all of them. @param {string[]} perms */
export const claimPerms = (perms) => (ALL_PERMISSIONS.every((p) => perms.includes(p)) ? [ALL_CLAIM] : perms);
/** The real permission list from a claim. @param {unknown} claim @returns {string[]} */
export const expandClaimPerms = (claim) => (Array.isArray(claim) ? (claim.includes(ALL_CLAIM) ? ALL_PERMISSIONS : claim) : []);

/** @type {Record<string, {name: string, permissions: string[]}>} */
export const DEFAULT_ROLES = {
  owner: {
    name: "Owner",
    permissions: ALL_PERMISSIONS,
  },
  inventory_manager: {
    name: "Inventory Manager",
    permissions: ["products.read", "products.write", "costs.read", "inventory.read", "inventory.adjust", "orders.read", "reports.inventory", "warehouses.manage", "transfers.manage", "purchases.read", "suppliers.manage", "purchases.manage"],
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
      "sales.read",
    ],
  },
  content_manager: {
    name: "Content Manager",
    permissions: ["products.read", "content.manage", "reviews.moderate"],
  },
};

/** Permissions only the Owner role may ever hold, whatever the Owner edits. */
export const OWNER_ONLY = ["staff.manage", "settings.manage", "audit.read", "analytics.executive"];

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
