/**
 * Sales endpoints. Sales themselves are created by placeOrder (in its transaction); these are the staff actions
 * on sales: the report, recording payments and reversing a mistaken payment entry.
 */
import { secureCallable, hasPermission } from "../lib/callable.js";
import { reportRangeInput, recordSalePaymentInput, reverseSalePaymentInput } from "../shared/schemas/index.js";
import * as reports from "../services/salesReports.js";
import * as salePayments from "../services/salePayments.js";

export const salesSummary = secureCallable("salesSummary", { auth: "required", permission: "sales.read", schema: reportRangeInput, rateLimit: { limit: 60, windowSeconds: 600 } }, ({ data, token }) =>
  reports.salesSummary(data, { canSeeCost: hasPermission(token, "costs.read") }),
);

const PAY = { auth: /** @type {const} */ ("required"), permission: "payments.update", rateLimit: { limit: 120, windowSeconds: 600 } };
export const recordSalePayment = secureCallable("recordSalePayment", { ...PAY, schema: recordSalePaymentInput }, ({ data, uid }) => salePayments.recordSalePayment(data, uid));
export const reverseSalePayment = secureCallable("reverseSalePayment", { ...PAY, rateLimit: { limit: 30, windowSeconds: 600 }, schema: reverseSalePaymentInput }, ({ data, uid }) => salePayments.reverseSalePayment(data, uid));
