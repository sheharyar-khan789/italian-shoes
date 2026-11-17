/**
 * Income, expense, cash and bank endpoints. Each checks a permission on the server; the person's identity comes from
 * the verified sign-in token. The accounting itself is done by services/finance.js through the accounting engine.
 *
 *   finance.read     view entries, balances, the dashboard and reports
 *   finance.write    record and edit income, expenses, transfers and cash counts
 *   finance.void     delete (void) entries
 *   finance.approve  approve expenses; enter large expenses without approval
 *   finance.adjust   post cash adjustments
 *   finance.manage   categories, bank accounts, approval limit, recurring expenses
 */
import { secureCallable, hasPermission } from "../lib/callable.js";
import { financeEntryInput, voidFinanceEntryInput, decideExpenseInput, transferInput, cashCountInput, financeCategoryInput, financeCategoryActiveInput, suggestedCategoriesInput, listEntriesInput, financeSettingsInput, addBankAccountInput, recurringInput, recurringActiveInput, emptyInput, financeRangeInput, financeReportInput } from "../shared/schemas/index.js";
import * as fin from "../services/finance.js";
import * as rep from "../services/financeReports.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const P = (permission, limit = 300) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });

export const saveFinanceEntry = secureCallable("saveFinanceEntry", { ...P("finance.write"), schema: financeEntryInput }, (ctx) => fin.saveFinanceEntry(ctx.data, actorOf(ctx), { canApprove: hasPermission(ctx.token, "finance.approve") }));
export const voidFinanceEntry = secureCallable("voidFinanceEntry", { ...P("finance.void", 120), schema: voidFinanceEntryInput }, (ctx) => fin.voidFinanceEntry(ctx.data, actorOf(ctx), { canAdjust: hasPermission(ctx.token, "finance.adjust") }));
export const decideExpense = secureCallable("decideExpense", { ...P("finance.approve", 120), schema: decideExpenseInput }, (ctx) => fin.decideExpense(ctx.data, actorOf(ctx)));
export const createTransfer = secureCallable("createTransfer", { ...P("finance.write", 120), schema: transferInput }, (ctx) => fin.createTransfer(ctx.data, actorOf(ctx)));
export const recordCashCount = secureCallable("recordCashCount", { ...P("finance.write", 120), schema: cashCountInput }, (ctx) => fin.recordCashCount(ctx.data, actorOf(ctx), { canAdjust: hasPermission(ctx.token, "finance.adjust") }));
export const listFinanceEntries = secureCallable("listFinanceEntries", { ...P("finance.read"), schema: listEntriesInput }, ({ data }) => fin.listFinanceEntries(data));

export const listFinanceCategories = secureCallable("listFinanceCategories", { ...P("finance.read"), schema: emptyInput }, () => fin.listFinanceCategories());
export const saveFinanceCategory = secureCallable("saveFinanceCategory", { ...P("finance.manage", 60), schema: financeCategoryInput }, (ctx) => fin.saveFinanceCategory(ctx.data, actorOf(ctx)));
export const setFinanceCategoryActive = secureCallable("setFinanceCategoryActive", { ...P("finance.manage", 60), schema: financeCategoryActiveInput }, (ctx) => fin.setFinanceCategoryActive(ctx.data, actorOf(ctx)));
export const addSuggestedCategories = secureCallable("addSuggestedCategories", { ...P("finance.manage", 30), schema: suggestedCategoriesInput }, (ctx) => fin.addSuggestedCategories(ctx.data, actorOf(ctx)));
export const getFinanceSettings = secureCallable("getFinanceSettings", { ...P("finance.read"), schema: emptyInput }, () => fin.getFinanceSettings());
export const saveFinanceSettings = secureCallable("saveFinanceSettings", { ...P("finance.manage", 30), schema: financeSettingsInput }, (ctx) => fin.saveFinanceSettings(ctx.data, actorOf(ctx)));
export const listMoneyAccounts = secureCallable("listMoneyAccounts", { ...P("finance.read"), schema: emptyInput }, () => fin.listMoneyAccounts());
export const addBankAccount = secureCallable("addBankAccount", { ...P("finance.manage", 30), schema: addBankAccountInput }, (ctx) => fin.addBankAccount(ctx.data, actorOf(ctx)));

export const listRecurring = secureCallable("listRecurring", { ...P("finance.read"), schema: emptyInput }, () => fin.listRecurring());
export const saveRecurring = secureCallable("saveRecurring", { ...P("finance.manage", 60), schema: recurringInput }, (ctx) => fin.saveRecurring(ctx.data, actorOf(ctx)));
export const setRecurringActive = secureCallable("setRecurringActive", { ...P("finance.manage", 60), schema: recurringActiveInput }, (ctx) => fin.setRecurringActive(ctx.data, actorOf(ctx)));
export const runRecurring = secureCallable("runRecurring", { ...P("finance.manage", 30), schema: emptyInput }, (ctx) => fin.runRecurring(actorOf(ctx), { canApprove: hasPermission(ctx.token, "finance.approve") }));

export const financeDashboard = secureCallable("financeDashboard", { ...P("finance.read", 120), schema: financeRangeInput }, ({ data }) => rep.financeDashboard(data));
export const financeReport = secureCallable("financeReport", { ...P("finance.read", 120), schema: financeReportInput }, ({ data }) => rep.financeReport(data));
