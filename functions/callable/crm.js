/**
 * CRM, loyalty and customer-discount endpoints. Each checks a permission on the server; the person's identity comes from the
 * verified sign-in token.
 *
 *   crm.read     view customers, profiles, history, loyalty, reports (customer contact details are personal data)
 *   crm.write    create and edit customers, add notes / complaints / follow-ups (also used to create a customer at the POS)
 *   crm.manage   settings (types, groups, tiers, loyalty rules), discounts, archive, recalculate, expire points
 *   crm.loyalty  adjust a customer's points by hand
 */
import { secureCallable } from "../lib/callable.js";
import { saveCrmCustomerInput, crmCustomerActiveInput, crmListInput, crmIdInput, crmNoteInput, crmNoteUpdateInput, crmNotesListInput, crmSettingsInput, loyaltyAdjustInput, loyaltyHistoryInput, saveCrmDiscountInput, crmDiscountActiveInput, crmReportInput, crmEmptyInput, crmQuickCreateInput } from "../shared/schemas/index.js";
import * as crm from "../services/crm.js";
import * as loyalty from "../services/loyalty.js";
import * as discounts from "../services/crmDiscounts.js";
import * as insights from "../services/crmInsights.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const P = (permission, limit = 300) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });

export const getCrmSettings = secureCallable("getCrmSettings", { ...P("crm.read"), schema: crmEmptyInput }, () => crm.getCrmSettings());
export const saveCrmSettings = secureCallable("saveCrmSettings", { ...P("crm.manage", 30), schema: crmSettingsInput }, (ctx) => crm.saveCrmSettings(ctx.data, actorOf(ctx)));

export const saveCrmCustomer = secureCallable("saveCrmCustomer", { ...P("crm.write", 200), schema: saveCrmCustomerInput }, (ctx) => crm.saveCustomer(ctx.data, actorOf(ctx)));
export const setCrmCustomerActive = secureCallable("setCrmCustomerActive", { ...P("crm.manage", 60), schema: crmCustomerActiveInput }, (ctx) => crm.setCustomerActive(ctx.data, actorOf(ctx)));
export const crmListCustomers = secureCallable("crmListCustomers", { ...P("crm.read", 300), schema: crmListInput }, ({ data }) => crm.listCustomers(data));
export const crmCustomerProfile = secureCallable("crmCustomerProfile", { ...P("crm.read", 300), schema: crmIdInput }, async ({ data }) => {
  await crm.refreshCustomerStats(data.id);
  return crm.customerProfile(data);
});
export const crmQuickCreate = secureCallable("crmQuickCreate", { ...P("crm.write", 120), schema: crmQuickCreateInput }, (ctx) => insights.quickCreate(ctx.data, actorOf(ctx)));

export const crmAddNote = secureCallable("crmAddNote", { ...P("crm.write", 300), schema: crmNoteInput }, (ctx) => crm.addNote(ctx.data, actorOf(ctx)));
export const crmUpdateNote = secureCallable("crmUpdateNote", { ...P("crm.write", 300), schema: crmNoteUpdateInput }, (ctx) => crm.updateNote(ctx.data, actorOf(ctx)));
export const crmListNotes = secureCallable("crmListNotes", { ...P("crm.read", 300), schema: crmNotesListInput }, ({ data }) => crm.listNotes(data));

export const loyaltySummary = secureCallable("loyaltySummary", { ...P("crm.read", 300), schema: loyaltyHistoryInput }, ({ data }) => loyalty.loyaltySummary(data));
export const loyaltyAdjust = secureCallable("loyaltyAdjust", { ...P("crm.loyalty", 120), schema: loyaltyAdjustInput }, (ctx) => loyalty.adjustPoints(ctx.data, actorOf(ctx)));
export const expireLoyaltyPoints = secureCallable("expireLoyaltyPoints", { ...P("crm.manage", 30), schema: crmEmptyInput }, () => loyalty.expirePoints());

export const saveCrmDiscount = secureCallable("saveCrmDiscount", { ...P("crm.manage", 120), schema: saveCrmDiscountInput }, (ctx) => discounts.saveDiscount(ctx.data, actorOf(ctx)));
export const setCrmDiscountActive = secureCallable("setCrmDiscountActive", { ...P("crm.manage", 120), schema: crmDiscountActiveInput }, (ctx) => discounts.setDiscountActive(ctx.data, actorOf(ctx)));
export const listCrmDiscounts = secureCallable("listCrmDiscounts", { ...P("crm.read"), schema: crmEmptyInput }, () => discounts.listDiscounts());

export const crmDashboard = secureCallable("crmDashboard", { ...P("crm.read", 60), schema: crmEmptyInput }, () => insights.crmDashboard());
export const crmReport = secureCallable("crmReport", { ...P("crm.read", 120), schema: crmReportInput }, ({ data }) => insights.crmReport(data));
export const refreshCrmStats = secureCallable("refreshCrmStats", { ...P("crm.manage", 10), schema: crmEmptyInput }, (ctx) => insights.refreshAllStats(actorOf(ctx)));
