/** Financial analytics: the report builder opened on the accounting-based statements. */
import analyticsReports from "./analyticsReports.js";

/** @param {any} ctx */
export default function analyticsFinancial(ctx) {
  return analyticsReports(ctx, { start: "fin_pnl" });
}
