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
  { key: "inventory-dashboard", label: "Inventory Dashboard", path: "/admin/inventory-dashboard", perm: "inventory.read", load: () => import("./views/inventoryDashboard.js") },
  { key: "stock-levels", label: "Stock Levels & Barcodes", path: "/admin/stock-levels", perm: "inventory.read", load: () => import("./views/stockLevels.js") },
  { key: "stock-adjustments", label: "Stock Adjustments", path: "/admin/stock-adjustments", perm: "inventory.read", load: () => import("./views/stockAdjustments.js") },
  { key: "stock-counts", label: "Stock Counts", path: "/admin/stock-counts", perm: "inventory.read", load: () => import("./views/stockCounts.js") },
  { key: "inventory-reports", label: "Inventory Reports", path: "/admin/inventory-reports", perm: "inventory.read", load: () => import("./views/inventoryReports.js") },
  { key: "warehouses", label: "Warehouses", path: "/admin/warehouses", perm: "inventory.read", load: () => import("./views/warehouses.js") },
  { key: "transfers", label: "Stock Transfers", path: "/admin/transfers", perm: "inventory.read", load: () => import("./views/transfers.js") },
  { key: "suppliers", label: "Suppliers", path: "/admin/suppliers", perm: "purchases.read", load: () => import("./views/suppliers.js") },
  { key: "purchase-orders", label: "Purchase Orders", path: "/admin/purchase-orders", perm: "purchases.read", load: () => import("./views/purchaseOrders.js") },
  { key: "goods-received", label: "Goods Received", path: "/admin/goods-received", perm: "purchases.read", load: () => import("./views/goodsReceived.js") },
  { key: "supplier-payments", label: "Supplier Payments", path: "/admin/supplier-payments", perm: "purchases.read", load: () => import("./views/supplierPayments.js") },
  { key: "purchase-returns", label: "Purchase Returns", path: "/admin/purchase-returns", perm: "purchases.read", load: () => import("./views/purchaseReturns.js") },
  { key: "supplier-ledger", label: "Supplier Ledger", path: "/admin/supplier-ledger", perm: "purchases.read", load: () => import("./views/supplierLedger.js") },
  { key: "purchase-dashboard", label: "Purchase Dashboard", path: "/admin/purchase-dashboard", perm: "purchases.read", load: () => import("./views/purchaseDashboard.js") },
  { key: "purchase-reports", label: "Purchase Reports", path: "/admin/purchase-reports", perm: "purchases.read", load: () => import("./views/purchaseReports.js") },
  { key: "categories", label: "Categories & Sizes", path: "/admin/categories", perm: "products.write", load: () => import("./views/catalogue.js") },
  { key: "orders", label: "Orders", path: "/admin/orders", perm: "orders.read", load: () => import("./views/orders.js") },
  { key: "sales", label: "Sales", path: "/admin/sales", perm: "sales.read", load: () => import("./views/sales.js") },
  { key: "pos", label: "Point of Sale", path: "/admin/pos", perm: "pos.access", load: () => import("./views/pos.js") },
  { key: "pos-sync", label: "Offline Sync", path: "/admin/pos-sync", perm: "pos.access", load: () => import("./views/posSync.js") },
  { key: "pos-sessions", label: "Register Sessions", path: "/admin/pos-sessions", perm: "pos.sessions.read", load: () => import("./views/posSessions.js") },
  { key: "pos-reports", label: "POS Reports", path: "/admin/pos-reports", perm: "pos.reports", load: () => import("./views/posReports.js") },
  { key: "sales-report", label: "Sales Report", path: "/admin/sales-report", perm: "sales.read", load: () => import("./views/salesReport.js") },
  { key: "finance", label: "Financial Dashboard", path: "/admin/finance", perm: "finance.read", load: () => import("./views/finance.js") },
  { key: "income", label: "Income", path: "/admin/income", perm: "finance.read", load: () => import("./views/income.js") },
  { key: "expenses", label: "Expenses", path: "/admin/expenses", perm: "finance.read", load: () => import("./views/expenses.js") },
  { key: "money", label: "Cash & Bank Management", path: "/admin/money", perm: "finance.read", load: () => import("./views/money.js") },
  { key: "finance-reports", label: "Financial Reports", path: "/admin/finance-reports", perm: "finance.read", load: () => import("./views/financeReports.js") },
  { key: "finance-settings", label: "Finance Settings", path: "/admin/finance-settings", perm: "finance.read", load: () => import("./views/financeSettings.js") },
  { key: "payments", label: "Payments", path: "/admin/payments", perm: "payments.update", load: () => import("./views/payments.js") },
  { key: "shipping", label: "Shipping", path: "/admin/shipping", perm: "shipping.manage", load: () => import("./views/shipping.js") },
  { key: "customers", label: "Customers", path: "/admin/customers", perm: "customers.read", load: () => import("./views/customers.js") },
  { key: "analytics", label: "Business Dashboard", path: "/admin/analytics", perm: "analytics.executive", load: () => import("./views/analyticsDashboard.js") },
  { key: "analytics-reports", label: "Report Builder", path: "/admin/analytics-reports", perm: "analytics.read", load: () => import("./views/analyticsReports.js") },
  { key: "analytics-financial", label: "Financial Analytics", path: "/admin/analytics-financial", perm: "analytics.financial", load: () => import("./views/analyticsFinancial.js") },
  { key: "analytics-schedules", label: "Report Inbox & Schedules", path: "/admin/analytics-schedules", perm: "analytics.read", load: () => import("./views/analyticsSchedules.js") },
  { key: "hr-dashboard", label: "HR Dashboard", path: "/admin/hr-dashboard", perm: "hr.read", load: () => import("./views/hrDashboard.js") },
  { key: "hr-employees", label: "Employees", path: "/admin/hr-employees", perm: "hr.read", load: () => import("./views/hrEmployees.js") },
  { key: "hr-attendance", label: "Attendance", path: "/admin/hr-attendance", perm: "hr.read", load: () => import("./views/hrAttendance.js") },
  { key: "hr-leave", label: "Leave", path: "/admin/hr-leave", perm: "hr.read", load: () => import("./views/hrLeave.js") },
  { key: "hr-payroll", label: "Payroll", path: "/admin/hr-payroll", perm: "hr.salary.read", load: () => import("./views/hrPayroll.js") },
  { key: "hr-advances", label: "Advances & Loans", path: "/admin/hr-advances", perm: "hr.salary.read", load: () => import("./views/hrAdvances.js") },
  { key: "hr-reports", label: "HR Reports", path: "/admin/hr-reports", perm: "hr.read", load: () => import("./views/hrReports.js") },
  { key: "hr-settings", label: "HR Settings", path: "/admin/hr-settings", perm: "hr.read", load: () => import("./views/hrSettings.js") },
  { key: "hr-self", label: "My HR", path: "/admin/hr-self", perm: "hr.self", load: () => import("./views/hrSelf.js") },
  { key: "crm-dashboard", label: "Customer Dashboard", path: "/admin/crm-dashboard", perm: "crm.read", load: () => import("./views/crmDashboard.js") },
  { key: "crm", label: "Customers (CRM)", path: "/admin/crm", perm: "crm.read", load: () => import("./views/crm.js") },
  { key: "crm-reports", label: "Customer Reports", path: "/admin/crm-reports", perm: "crm.read", load: () => import("./views/crmReports.js") },
  { key: "crm-settings", label: "Customer Settings", path: "/admin/crm-settings", perm: "crm.read", load: () => import("./views/crmSettings.js") },
  { key: "coupons", label: "Coupons & Offers", path: "/admin/coupons", perm: "coupons.manage", load: () => import("./views/coupons.js") },
  { key: "reviews", label: "Reviews", path: "/admin/reviews", perm: "reviews.moderate", load: () => import("./views/reviews.js") },
  { key: "reports", label: "Analytics & Reports", path: "/admin/reports", perm: "reports.sales", load: () => import("./views/reports.js") },
  { key: "content", label: "Website Content", path: "/admin/content", perm: "content.manage", load: () => import("./views/content.js") },
  { key: "accounting", label: "Accounting", path: "/admin/accounting", perm: "accounting.read", load: () => import("./views/accountingOverview.js") },
  { key: "chart-of-accounts", label: "Chart of Accounts", path: "/admin/chart-of-accounts", perm: "accounting.read", load: () => import("./views/chartOfAccounts.js") },
  { key: "journals", label: "Journal Entries", path: "/admin/journals", perm: "accounting.read", load: () => import("./views/journals.js") },
  { key: "general-ledger", label: "General Ledger", path: "/admin/general-ledger", perm: "accounting.read", load: () => import("./views/generalLedger.js") },
  { key: "trial-balance", label: "Trial Balance", path: "/admin/trial-balance", perm: "accounting.read", load: () => import("./views/trialBalance.js") },
  { key: "receivables", label: "Accounts Receivable", path: "/admin/receivables", perm: "accounting.read", load: () => import("./views/receivables.js") },
  { key: "payables", label: "Accounts Payable", path: "/admin/payables", perm: "accounting.read", load: () => import("./views/payables.js") },
  { key: "cash-bank", label: "Cash & Bank", path: "/admin/cash-bank", perm: "accounting.read", load: () => import("./views/cashBank.js") },
  { key: "accounting-reports", label: "Accounting Reports", path: "/admin/accounting-reports", perm: "accounting.read", load: () => import("./views/accountingReports.js") },
  { key: "opening-balances", label: "Opening Balances", path: "/admin/opening-balances", perm: "accounting.read", load: () => import("./views/openingBalances.js") },
  { key: "bank-reconciliation", label: "Bank Reconciliation", path: "/admin/bank-reconciliation", perm: "accounting.reconcile", load: () => import("./views/bankReconciliation.js") },
  { key: "period-close", label: "Period Close", path: "/admin/period-close", perm: "accounting.read", load: () => import("./views/periodClose.js") },
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
