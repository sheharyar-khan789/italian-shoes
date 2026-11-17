/**
 * Point-of-sale endpoints. Each checks a permission on the server; the cashier's identity always comes from the
 * verified sign-in token, never from the request.
 *
 *   pos.access        open the counter screen, search products, reprint own receipts
 *   pos.sell          make sales, take payments, look up customers
 *   pos.register      open and close a register
 *   pos.cash          cash in / cash out, close other people's registers
 *   pos.override      discounts and lowered prices
 *   pos.sessions.read view register sessions   pos.reports   POS reports
 *   pos.return        take goods back from a walk-in sale (refund, restock, exchange)
 */
import { secureCallable, hasPermission } from "../lib/callable.js";
import { openRegisterInput, closeRegisterInput, registerCashInput, posCheckoutInput, posPaymentInput, posSearchInput, posCustomerInput, posQuoteInput, posReceiptInput, posContextInput, posSyncSaleInput, posReturnInput, posReturnListInput, posSyncDiscardInput, posSyncListInput, posCatalogInput, reportRangeInput, enableAccountingInput } from "../shared/schemas/index.js";
import * as pos from "../services/pos.js";
import * as posReturns from "../services/posReturns.js";
import * as crmInsights from "../services/crmInsights.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx @returns {pos.Actor} */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const rate = { limit: 600, windowSeconds: 600 };
const P = (permission, extra = {}) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: rate, ...extra });

export const posContext = secureCallable("posContext", { ...P("pos.access"), schema: posContextInput }, (ctx) => pos.posContext(actorOf(ctx)));
export const posSearch = secureCallable("posSearch", { ...P("pos.access"), schema: posSearchInput }, ({ data }) => pos.posSearch(data));
export const posCustomerLookup = secureCallable("posCustomerLookup", { ...P("pos.sell", { rateLimit: { limit: 120, windowSeconds: 600 } }), schema: posCustomerInput }, (ctx) => pos.posCustomerLookup(ctx.data, actorOf(ctx)));
export const posCrmQuote = secureCallable("posCrmQuote", { ...P("pos.sell", { rateLimit: { limit: 300, windowSeconds: 600 } }), schema: posQuoteInput }, ({ data }) => crmInsights.posQuote(data));
export const posCheckout = secureCallable("posCheckout", { ...P("pos.sell", { rateLimit: { limit: 300, windowSeconds: 600 } }), schema: posCheckoutInput }, (ctx) => pos.posCheckout(ctx.data, actorOf(ctx), { canOverride: hasPermission(ctx.token, "pos.override") }));
export const posRecordPayment = secureCallable("posRecordPayment", { ...P("pos.sell", { rateLimit: { limit: 300, windowSeconds: 600 } }), schema: posPaymentInput }, (ctx) => pos.posRecordPayment(ctx.data, actorOf(ctx)));
export const posReceipt = secureCallable("posReceipt", { ...P("pos.access"), schema: posReceiptInput }, (ctx) => pos.posReceipt(ctx.data, actorOf(ctx), { canViewAll: hasPermission(ctx.token, "pos.sessions.read") }));

export const posSyncSale = secureCallable("posSyncSale", { ...P("pos.sell", { rateLimit: { limit: 600, windowSeconds: 600 } }), schema: posSyncSaleInput }, (ctx) => pos.syncOfflineSale(ctx.data, actorOf(ctx), { canOverride: hasPermission(ctx.token, "pos.override") }));
export const posSyncDiscard = secureCallable("posSyncDiscard", { ...P("pos.override", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: posSyncDiscardInput }, (ctx) => pos.posSyncDiscard(ctx.data, actorOf(ctx)));
export const posSyncList = secureCallable("posSyncList", { ...P("pos.sessions.read", { rateLimit: { limit: 120, windowSeconds: 600 } }), schema: posSyncListInput }, ({ data }) => pos.posSyncList(data));
export const posCatalog = secureCallable("posCatalog", { ...P("pos.access", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: posCatalogInput }, ({ data }) => pos.posCatalog(data));

export const openRegister = secureCallable("openRegister", { ...P("pos.register", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: openRegisterInput }, (ctx) => pos.openRegister(ctx.data, actorOf(ctx)));
export const closeRegister = secureCallable("closeRegister", { ...P("pos.register", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: closeRegisterInput }, (ctx) => pos.closeRegister(ctx.data, actorOf(ctx), { canCloseOthers: hasPermission(ctx.token, "pos.cash") }));
export const registerCash = secureCallable("registerCash", { ...P("pos.cash", { rateLimit: { limit: 120, windowSeconds: 600 } }), schema: registerCashInput }, (ctx) => pos.registerCash(ctx.data, actorOf(ctx)));

export const posReport = secureCallable("posReport", { ...P("pos.reports", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: reportRangeInput }, ({ data }) => pos.posReport(data));
export const createPosRoles = secureCallable("createPosRoles", { auth: "required", permission: "staff.manage", rateLimit: { limit: 10, windowSeconds: 600 }, schema: enableAccountingInput }, ({ uid }) => pos.createPosRoles(/** @type {string} */ (uid)));

export const posReturn = secureCallable("posReturn", { ...P("pos.return", { rateLimit: { limit: 60, windowSeconds: 600 } }), schema: posReturnInput }, (ctx) => posReturns.createPosReturn(ctx.data, actorOf(ctx)));
export const posReturnList = secureCallable("posReturnList", { ...P("pos.return", { rateLimit: { limit: 120, windowSeconds: 600 } }), schema: posReturnListInput }, ({ data }) => posReturns.listPosReturns(data));
