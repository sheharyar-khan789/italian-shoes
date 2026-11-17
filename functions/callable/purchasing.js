/**
 * Supplier and purchasing endpoints. Each checks a permission on the server; stock only ever changes through
 * services/inventory.js (called from the goods-receipt and purchase-return services).
 */
import { secureCallable } from "../lib/callable.js";
import {
  saveSupplierInput,
  setSupplierActiveInput,
  savePurchaseOrderInput,
  purchaseOrderActionInput,
  receiveGoodsInput,
  supplierPaymentInput,
  purchaseReturnInput,
  supplierRefundInput,
  supplierAdjustmentInput,
  purchaseDashboardInput,
  purchaseReportTablesInput,
  reportRangeInput,
} from "../shared/schemas/index.js";
import * as suppliers from "../services/suppliers.js";
import * as purchaseOrders from "../services/purchaseOrders.js";
import * as goodsReceipts from "../services/goodsReceipts.js";
import * as payments from "../services/supplierPayments.js";
import * as returns from "../services/purchaseReturns.js";
import * as reports from "../services/purchaseReports.js";
import * as adjustments from "../services/supplierAdjustments.js";
import * as dashboard from "../services/purchaseDashboard.js";
import { hasPermission } from "../lib/callable.js";

const rate = { limit: 240, windowSeconds: 600 };
const SUPPLIERS = { auth: /** @type {const} */ ("required"), permission: "suppliers.manage", rateLimit: rate };
const PURCHASES = { auth: /** @type {const} */ ("required"), permission: "purchases.manage", rateLimit: rate };

export const saveSupplier = secureCallable("saveSupplier", { ...SUPPLIERS, schema: saveSupplierInput }, ({ data, uid }) => suppliers.saveSupplier(data, uid));
export const setSupplierActive = secureCallable("setSupplierActive", { ...SUPPLIERS, schema: setSupplierActiveInput }, ({ data, uid }) => suppliers.setSupplierActive(data, uid));

export const savePurchaseOrder = secureCallable("savePurchaseOrder", { ...PURCHASES, schema: savePurchaseOrderInput }, ({ data, uid }) => purchaseOrders.savePurchaseOrder(data, uid));
export const approvePurchaseOrder = secureCallable("approvePurchaseOrder", { ...PURCHASES, schema: purchaseOrderActionInput }, ({ data, uid }) => purchaseOrders.approvePurchaseOrder(data, uid));
export const cancelPurchaseOrder = secureCallable("cancelPurchaseOrder", { ...PURCHASES, schema: purchaseOrderActionInput }, ({ data, uid }) => purchaseOrders.cancelPurchaseOrder(data, uid));
export const closePurchaseOrder = secureCallable("closePurchaseOrder", { ...PURCHASES, schema: purchaseOrderActionInput }, ({ data, uid }) => purchaseOrders.closePurchaseOrder(data, uid));
export const receiveGoods = secureCallable("receiveGoods", { ...PURCHASES, schema: receiveGoodsInput }, ({ data, uid }) => goodsReceipts.receiveGoods(data, uid));
export const createPurchaseReturn = secureCallable("createPurchaseReturn", { ...PURCHASES, schema: purchaseReturnInput }, ({ data, uid }) => returns.createPurchaseReturn(data, uid));

export const recordSupplierPayment = secureCallable("recordSupplierPayment", { auth: "required", permission: "suppliers.pay", rateLimit: rate, schema: supplierPaymentInput }, (ctx) => payments.recordSupplierPayment(ctx.data, /** @type {string} */ (ctx.uid), { canAdvance: hasPermission(ctx.token, "suppliers.adjust") }));

export const purchaseReport = secureCallable("purchaseReport", { auth: "required", permission: "purchases.read", rateLimit: { limit: 60, windowSeconds: 600 }, schema: reportRangeInput }, ({ data }) => reports.purchaseReport(data));

export const recordSupplierRefund = secureCallable("recordSupplierRefund", { auth: "required", permission: "suppliers.adjust", rateLimit: rate, schema: supplierRefundInput }, ({ data, uid }) => adjustments.recordSupplierRefund(data, uid));
export const recordSupplierAdjustment = secureCallable("recordSupplierAdjustment", { auth: "required", permission: "suppliers.adjust", rateLimit: rate, schema: supplierAdjustmentInput }, ({ data, uid }) => adjustments.recordSupplierAdjustment(data, uid));
export const purchaseDashboard = secureCallable("purchaseDashboard", { auth: "required", permission: "purchases.read", rateLimit: { limit: 120, windowSeconds: 600 }, schema: purchaseDashboardInput }, ({ data }) => dashboard.purchaseDashboard(data));
export const purchaseReportTables = secureCallable("purchaseReportTables", { auth: "required", permission: "purchases.read", rateLimit: { limit: 120, windowSeconds: 600 }, schema: purchaseReportTablesInput }, ({ data }) => dashboard.purchaseReportTables(data));
