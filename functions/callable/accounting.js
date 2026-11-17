/**
 * Accounting endpoints. Every one checks a permission on the server; no browser can write a journal, an account
 * or a ledger line any other way (the security rules deny all client writes to these collections).
 *
 *   accounting.read     reports, ledgers, trial balance, reconciliation
 *   accounting.manage   chart of accounts, posting accounts, opening balances
 *   accounting.post     manual journals, retrying failed automatic postings
 *   accounting.reverse  reversing posted journals
 *   accounting.close    close / reopen periods   accounting.reconcile  match bank and wallet accounts to the statement
 */
import { secureCallable } from "../lib/callable.js";
import {
  enableAccountingInput,
  saveAccountInput,
  setAccountActiveInput,
  deleteAccountInput,
  setRoleInput,
  previewOpeningInput,
  openingBalanceInput,
  createJournalInput,
  postDraftInput,
  deleteDraftInput,
  reverseJournalInput,
  retryExceptionInput,
  asOfInput,
  periodInput,
  trialBalanceInput,
  generalLedgerInput,
  partyListInput,
  reconcileInput,
  closePeriodInput,
  reopenPeriodInput,
  periodChecksInput,
  reconWorkspaceInput,
  finishReconInput,
  undoReconInput,
  listReconInput,
} from "../shared/schemas/index.js";
import * as accounting from "../services/accounting.js";
import * as reports from "../services/accountingReports.js";
import * as periods from "../services/accountingPeriods.js";
import * as bank from "../services/bankReconciliation.js";

const MANAGE = { auth: /** @type {const} */ ("required"), permission: "accounting.manage", rateLimit: { limit: 120, windowSeconds: 600 } };
const POST = { auth: /** @type {const} */ ("required"), permission: "accounting.post", rateLimit: { limit: 240, windowSeconds: 600 } };
const READ = { auth: /** @type {const} */ ("required"), permission: "accounting.read", rateLimit: { limit: 240, windowSeconds: 600 } };

export const initializeAccounting = secureCallable("initializeAccounting", { ...MANAGE, schema: enableAccountingInput }, ({ uid }) => accounting.initializeAccounting(uid));
export const saveAccount = secureCallable("saveAccount", { ...MANAGE, schema: saveAccountInput }, ({ data, uid }) => accounting.saveAccount(data, uid));
export const setAccountActive = secureCallable("setAccountActive", { ...MANAGE, schema: setAccountActiveInput }, ({ data, uid }) => accounting.setAccountActive(data, uid));
export const deleteAccount = secureCallable("deleteAccount", { ...MANAGE, schema: deleteAccountInput }, ({ data, uid }) => accounting.deleteAccount(data, uid));
export const setAccountRole = secureCallable("setAccountRole", { ...MANAGE, schema: setRoleInput }, ({ data, uid }) => accounting.setRoleAccount(data, uid));
export const previewOpeningBalances = secureCallable("previewOpeningBalances", { ...MANAGE, schema: previewOpeningInput }, ({ data }) => accounting.previewOpening(data));
export const postOpeningBalances = secureCallable("postOpeningBalances", { ...MANAGE, rateLimit: { limit: 20, windowSeconds: 600 }, schema: openingBalanceInput }, ({ data, uid }) => accounting.postOpeningBalances(data, uid));

export const createJournal = secureCallable("createJournal", { ...POST, schema: createJournalInput }, ({ data, uid }) => accounting.createJournal(data, uid));
export const postDraftJournal = secureCallable("postDraftJournal", { ...POST, schema: postDraftInput }, ({ data, uid }) => accounting.postDraft(data, uid));
export const deleteDraftJournal = secureCallable("deleteDraftJournal", { ...POST, schema: deleteDraftInput }, ({ data, uid }) => accounting.deleteDraft(data, uid));
export const retryPosting = secureCallable("retryPosting", { ...POST, schema: retryExceptionInput }, ({ data, uid }) => accounting.retryException(data, uid));
export const reverseJournal = secureCallable("reverseJournal", { auth: "required", permission: "accounting.reverse", rateLimit: { limit: 60, windowSeconds: 600 }, schema: reverseJournalInput }, ({ data, uid }) => accounting.reverseJournal(data, uid));

export const accountingOverview = secureCallable("accountingOverview", { ...READ, schema: enableAccountingInput }, () => reports.overview());
export const trialBalance = secureCallable("trialBalance", { ...READ, schema: trialBalanceInput }, ({ data }) => reports.trialBalance(data));
export const generalLedger = secureCallable("generalLedger", { ...READ, schema: generalLedgerInput }, ({ data }) => reports.generalLedger(data));
export const profitAndLoss = secureCallable("profitAndLoss", { ...READ, schema: periodInput }, ({ data }) => reports.profitAndLoss(data));
export const balanceSheet = secureCallable("balanceSheet", { ...READ, schema: asOfInput }, ({ data }) => reports.balanceSheet(data));
export const cashFlow = secureCallable("cashFlow", { ...READ, schema: periodInput }, ({ data }) => reports.cashFlow(data));
export const partyBalances = secureCallable("partyBalances", { ...READ, schema: partyListInput }, ({ data }) => reports.partyList(data));
export const reconcile = secureCallable("reconcile", { ...READ, rateLimit: { limit: 600, windowSeconds: 600 }, schema: reconcileInput }, ({ data }) => reports.reconcileStage(data));

const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const CLOSE = { auth: /** @type {const} */ ("required"), permission: "accounting.close", rateLimit: { limit: 30, windowSeconds: 600 } };
const RECON = { auth: /** @type {const} */ ("required"), permission: "accounting.reconcile", rateLimit: { limit: 120, windowSeconds: 600 } };

export const periodChecks = secureCallable("periodChecks", { ...CLOSE, schema: periodChecksInput }, ({ data }) => periods.periodChecks(data.through));
export const closePeriod = secureCallable("closePeriod", { ...CLOSE, schema: closePeriodInput }, (ctx) => periods.closePeriod(ctx.data, actorOf(ctx)));
export const reopenPeriod = secureCallable("reopenPeriod", { ...CLOSE, schema: reopenPeriodInput }, (ctx) => periods.reopenPeriod(ctx.data, actorOf(ctx)));
export const listPeriods = secureCallable("listPeriods", { ...READ, schema: enableAccountingInput }, () => periods.listPeriods());

export const reconWorkspace = secureCallable("reconWorkspace", { ...RECON, schema: reconWorkspaceInput }, ({ data }) => bank.reconciliationWorkspace(data));
export const finishReconciliation = secureCallable("finishReconciliation", { ...RECON, schema: finishReconInput }, (ctx) => bank.finishReconciliation(ctx.data, actorOf(ctx)));
export const undoReconciliation = secureCallable("undoReconciliation", { ...RECON, schema: undoReconInput }, (ctx) => bank.undoReconciliation(ctx.data, actorOf(ctx)));
export const listReconciliations = secureCallable("listReconciliations", { ...READ, schema: listReconInput }, ({ data }) => bank.listReconciliations(data));
