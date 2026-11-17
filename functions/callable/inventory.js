/**
 * Advanced inventory endpoints. Each checks a permission on the server; stock only ever changes through
 * services/inventory.js (called by the adjustment, count and transfer services).
 *
 *   inventory.read      overview, alerts, valuation, reports, barcode lookup
 *   inventory.adjust    create stock adjustments (large ones wait for approval)
 *   inventory.count     run physical stock counts
 *   inventory.approve   approve adjustments and counts, apply counts, revalue cost, enter large adjustments directly
 *   inventory.manage    levels, storage locations, alert thresholds, barcodes
 *   transfers.manage    request transfers and receive them (in part, with damaged / missing pairs)
 */
import { secureCallable, hasPermission } from "../lib/callable.js";
import { createAdjustmentInput, decideAdjustmentInput, costAdjustInput, stockPolicyInput, inventorySettingsInput, startCountInput, countLineInput, countActionInput, decideCountInput, receiveTransferLinesInput, assignBarcodeInput, lookupBarcodeInput, emptyInventoryInput, inventoryRangeInput, inventoryReportInput, transferActionInput } from "../shared/schemas/index.js";
import * as adjustments from "../services/stockAdjustments.js";
import * as counts from "../services/stockCounts.js";
import * as transfers from "../services/transfers.js";
import * as insights from "../services/inventoryInsights.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const P = (permission, limit = 300) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });

export const createStockAdjustment = secureCallable("createStockAdjustment", { ...P("inventory.adjust"), schema: createAdjustmentInput }, (ctx) => adjustments.createAdjustment(ctx.data, actorOf(ctx), { canApprove: hasPermission(ctx.token, "inventory.approve") }));
export const decideStockAdjustment = secureCallable("decideStockAdjustment", { ...P("inventory.approve", 120), schema: decideAdjustmentInput }, (ctx) => adjustments.decideAdjustment(ctx.data, actorOf(ctx)));
export const adjustVariantCost = secureCallable("adjustVariantCost", { ...P("inventory.approve", 60), schema: costAdjustInput }, (ctx) => adjustments.adjustCost(ctx.data, actorOf(ctx)));

export const startStockCount = secureCallable("startStockCount", { ...P("inventory.count", 60), schema: startCountInput }, (ctx) => counts.startCount(ctx.data, actorOf(ctx)));
export const saveStockCountLine = secureCallable("saveStockCountLine", { ...P("inventory.count", 1200), schema: countLineInput }, (ctx) => counts.saveCountLine(ctx.data, actorOf(ctx)));
export const submitStockCount = secureCallable("submitStockCount", { ...P("inventory.count", 60), schema: countActionInput }, (ctx) => counts.submitCount(ctx.data, actorOf(ctx)));
export const decideStockCount = secureCallable("decideStockCount", { ...P("inventory.approve", 60), schema: decideCountInput }, (ctx) => counts.decideCount(ctx.data, actorOf(ctx)));
export const applyStockCount = secureCallable("applyStockCount", { ...P("inventory.approve", 60), schema: countActionInput }, (ctx) => counts.applyCount(ctx.data, actorOf(ctx)));
export const cancelStockCount = secureCallable("cancelStockCount", { ...P("inventory.count", 60), schema: countActionInput }, (ctx) => counts.cancelCount(ctx.data, actorOf(ctx)));

export const requestTransfer = secureCallable("requestTransfer", { ...P("transfers.manage", 120), schema: transferActionInput }, ({ data, uid }) => transfers.requestTransfer(data, /** @type {string} */ (uid)));
export const receiveTransferLines = secureCallable("receiveTransferLines", { ...P("transfers.manage", 120), schema: receiveTransferLinesInput }, (ctx) => transfers.receiveTransferLines(ctx.data, actorOf(ctx)));

export const setStockPolicy = secureCallable("setStockPolicy", { ...P("inventory.manage", 300), schema: stockPolicyInput }, (ctx) => insights.setStockPolicy(ctx.data, actorOf(ctx)));
export const getInventorySettings = secureCallable("getInventorySettings", { ...P("inventory.read"), schema: emptyInventoryInput }, () => insights.getInventorySettings());
export const saveInventorySettings = secureCallable("saveInventorySettings", { ...P("inventory.manage", 30), schema: inventorySettingsInput }, (ctx) => insights.saveInventorySettings(ctx.data, actorOf(ctx)));
export const assignBarcode = secureCallable("assignBarcode", { ...P("inventory.manage", 300), schema: assignBarcodeInput }, (ctx) => insights.assignBarcode(ctx.data, actorOf(ctx)));
export const lookupBarcode = secureCallable("lookupBarcode", { ...P("inventory.read", 600), schema: lookupBarcodeInput }, ({ data }) => insights.lookupBarcode(data));

export const inventoryItems = secureCallable("inventoryItems", { ...P("inventory.read", 60), schema: emptyInventoryInput }, () => insights.inventoryItems());
export const inventoryAlerts = secureCallable("inventoryAlerts", { ...P("inventory.read", 60), schema: emptyInventoryInput }, () => insights.inventoryAlerts());
export const inventoryDashboard = secureCallable("inventoryDashboard", { ...P("inventory.read", 60), schema: emptyInventoryInput }, () => insights.inventoryDashboard());
export const inventoryValuation = secureCallable("inventoryValuation", { ...P("inventory.read", 60), schema: inventoryRangeInput }, ({ data }) => insights.inventoryValuation({ asOf: data.to }));
export const inventoryReport = secureCallable("inventoryReport", { ...P("inventory.read", 120), schema: inventoryReportInput }, ({ data }) => insights.inventoryReport(data));
