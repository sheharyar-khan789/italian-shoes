/**
 * Business-intelligence rules shared by the server and the browser: the report catalogue (with the permissions each report needs),
 * period arithmetic, and the PURE calculations behind growth, margins, stock movement, turnover, cover and ageing.
 * Money is integer paisa; dates are YYYY-MM-DD keys (Pakistan time). Nothing here reads a database.
 *
 * Verified vs estimated: figures taken from posted journals or saved sale / cost records are VERIFIED. Anything that looks forward or
 * depends on a rule of thumb (days of stock left, reorder quantities, slow / dead stock) is an ESTIMATE and is labelled as such.
 */
import { addDays, daysBetween } from "./finance.js";

/** Report catalogue. `perms` are ALL required (the server checks them again). */
export const ANALYTICS_REPORTS = {
  sales_trend: { label: "Sales trend (daily / weekly / monthly)", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_year: { label: "Year-on-year sales comparison", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_product: { label: "Sales by product", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_category: { label: "Sales by category", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_size: { label: "Sales by size", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_colour: { label: "Sales by colour", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_variant: { label: "Sales by variant", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_payment: { label: "Payment methods (cash vs bank)", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_warehouse: { label: "Sales by shop / warehouse", group: "Sales", perms: ["analytics.read", "sales.read"] },
  sales_person: { label: "Salesperson performance", group: "Sales", perms: ["analytics.read", "sales.read"] },
  profit_product: { label: "Gross profit by product", group: "Profit", perms: ["analytics.financial", "costs.read"] },
  profit_category: { label: "Gross profit by category", group: "Profit", perms: ["analytics.financial", "costs.read"] },
  profit_monthly: { label: "Monthly profit and margin (from the books)", group: "Profit", perms: ["analytics.financial", "accounting.read"] },
  profit_impact: { label: "Discount and return impact", group: "Profit", perms: ["analytics.financial", "costs.read"] },
  profit_expenses: { label: "Operating expense analysis", group: "Profit", perms: ["analytics.financial", "accounting.read"] },
  product_performance: { label: "Product performance intelligence", group: "Products", perms: ["analytics.read", "sales.read", "inventory.read"] },
  customer_analytics: { label: "Customer analytics", group: "Customers", perms: ["analytics.read", "crm.read"] },
  inventory_intel: { label: "Inventory intelligence", group: "Inventory", perms: ["analytics.read", "inventory.read"] },
  purchase_analytics: { label: "Purchase and supplier analytics", group: "Purchases", perms: ["analytics.read", "purchases.read"] },
  fin_pnl: { label: "Profit & loss statement", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_balance_sheet: { label: "Balance sheet", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_cash_flow: { label: "Cash flow statement", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_trial_balance: { label: "Trial balance", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_ledger: { label: "General ledger (one account)", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_ar_aging: { label: "Accounts receivable ageing", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_ap_aging: { label: "Accounts payable ageing", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_expenses: { label: "Expense breakdown", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_income: { label: "Income breakdown", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
  fin_monthly: { label: "Monthly financial comparison", group: "Financial", perms: ["analytics.financial", "accounting.read"] },
};
export const ANALYTICS_REPORT_KEYS = /** @type {[string, ...string[]]} */ (Object.keys(ANALYTICS_REPORTS));
export const GRANULARITIES = ["day", "week", "month", "year"];
export const SCHEDULE_REPORTS = {
  daily_sales: { label: "Daily sales summary", frequency: "daily", perms: ["analytics.read", "sales.read"] },
  weekly_performance: { label: "Weekly performance summary", frequency: "weekly", perms: ["analytics.read", "sales.read"] },
  monthly_financial: { label: "Monthly financial summary", frequency: "monthly", perms: ["analytics.financial", "accounting.read"] },
  low_stock: { label: "Low-stock report", frequency: "daily", perms: ["analytics.read", "inventory.read"] },
  outstanding: { label: "Outstanding payments summary", frequency: "weekly", perms: ["analytics.financial", "accounting.read"] },
};

/** Can this person run the report? @param {string} report @param {string[]} perms */
export const canRunReport = (report, perms) => Boolean(ANALYTICS_REPORTS[report]) && ANALYTICS_REPORTS[report].perms.every((p) => perms.includes(p));

/* ───────── Periods ───────── */

/** The period of the same length immediately before [from, to]. @param {string} from @param {string} to */
export function previousPeriod(from, to) {
  const n = daysBetween(from, to).length;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/** The same dates one year earlier (for year-on-year). @param {string} key */
export const yearBefore = (key) => {
  const y = Number(key.slice(0, 4)) - 1;
  const md = key.slice(5);
  return md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
};

/** Percentage change from `prev` to `cur`, one decimal; null when there is nothing to compare with. @param {number} cur @param {number} prev */
export const growth = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Profit as a percentage of net sales, one decimal; null when there are no sales. @param {number} profit @param {number} net */
export const marginPercent = (profit, net) => (net > 0 ? Math.round((profit / net) * 1000) / 10 : null);

/** The bucket a date falls in: the day, the Monday of its week, its month, or its year. @param {string} key @param {"day" | "week" | "month" | "year"} g */
export function bucketOf(key, g) {
  if (g === "day") return key;
  if (g === "month") return key.slice(0, 7);
  if (g === "year") return key.slice(0, 4);
  const dow = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(key, -dow);
}

/** Every bucket from `from` to `to`, so a quiet day or week still shows as zero. @param {string} from @param {string} to @param {"day" | "week" | "month" | "year"} g */
export function bucketsBetween(from, to, g) {
  const out = [];
  for (const d of daysBetween(from, to)) {
    const b = bucketOf(d, g);
    if (out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

/* ───────── Stock movement (ESTIMATES from sales history) ───────── */

export const MOVEMENT_DEFAULTS = { fastCoverDays: 21, slowCoverDays: 90 };

/**
 * Fast / normal / slow / dead, from how fast the product sold and how much is on hand. An ESTIMATE: it assumes the recent rate continues.
 * @param {{ sold: number, onHand: number, days: number }} p @param {typeof MOVEMENT_DEFAULTS} [cfg]
 * @returns {"dead" | "slow" | "fast" | "normal" | "none"}
 */
export function classifyMovement({ sold, onHand, days }, cfg = MOVEMENT_DEFAULTS) {
  if (onHand <= 0) return sold > 0 ? "fast" : "none";
  if (sold <= 0) return "dead";
  const cover = daysOfCover({ onHand, sold, days });
  if (cover === null) return "dead";
  if (cover <= cfg.fastCoverDays) return "fast";
  if (cover > cfg.slowCoverDays) return "slow";
  return "normal";
}

/** Days the stock on hand would last at the rate it sold in the period; null when nothing sold. ESTIMATE. @param {{ onHand: number, sold: number, days: number }} p */
export const daysOfCover = ({ onHand, sold, days }) => (sold > 0 && days > 0 ? Math.round((onHand / (sold / days)) * 10) / 10 : null);

/**
 * Stock turnover = cost of goods sold ÷ average inventory value (opening and closing valuation). Not annualised.
 * @param {{ cogs: number, openingValue: number, closingValue: number }} p @returns {number | null}
 */
export function turnover({ cogs, openingValue, closingValue }) {
  const avg = (openingValue + closingValue) / 2;
  return avg > 0 ? Math.round((cogs / avg) * 100) / 100 : null;
}

/**
 * A suggested reorder quantity (ESTIMATE): enough to cover the lead time plus a safety margin at the recent selling rate, less what is on hand
 * (and on order); capped by the maximum stock when one is set. 0 when nothing needs ordering.
 * @param {{ onHand: number, onOrder?: number, sold: number, days: number, leadDays: number, safetyDays: number, maxStock?: number }} p
 */
export function reorderQty({ onHand, onOrder = 0, sold, days, leadDays, safetyDays, maxStock = 0 }) {
  if (!(sold > 0) || !(days > 0)) return 0;
  const need = Math.ceil((sold / days) * (leadDays + safetyDays));
  let qty = need - onHand - onOrder;
  if (maxStock > 0) qty = Math.min(qty, maxStock - onHand - onOrder);
  return Math.max(0, qty);
}

/** Overstock: more than `coverDays` of stock at the recent rate (or stock above the set maximum). @param {{ onHand: number, sold: number, days: number, maxStock?: number }} p @param {number} coverDays */
export function isOverstock({ onHand, sold, days, maxStock = 0 }, coverDays = 180) {
  if (maxStock > 0 && onHand > maxStock) return true;
  const c = daysOfCover({ onHand, sold, days });
  return c !== null && c > coverDays;
}

/* ───────── Ageing ───────── */

/** @type {[string, string, number][]} */
export const AGING_BUCKETS = [["current", "Not yet due / 0–30 days", 0], ["d31", "31–60 days", 31], ["d61", "61–90 days", 61], ["d90", "Over 90 days", 91]];

/** Which ageing bucket an age in days belongs to. @param {number} ageDays */
export function agingBucket(ageDays) {
  let k = "current";
  for (const [key, , from] of AGING_BUCKETS) if (ageDays >= from) k = /** @type {string} */ (key);
  return k;
}

/** Whole days from one date key to another (never negative). @param {string} from @param {string} to */
export const ageInDays = (from, to) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));
