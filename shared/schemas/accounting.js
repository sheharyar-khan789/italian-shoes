import { z } from "zod";
import { docId, paisa, text, optionalText } from "./common.js";
import { ACCOUNT_TYPES, ROLES, isDateKey } from "../accounting.js";

const dateKey = z.string().refine(isDateKey, "Enter a date");
/** A business date that isn't in the future (a day's grace for time zones). */
const pastDateKey = dateKey.refine((d) => Date.parse(`${d}T00:00:00Z`) <= Date.now() + 2 * 86400000, "The date can't be in the future").refine((d) => d >= "2000-01-01", "Enter a real date");
export const accountCode = z.string().regex(/^\d{3,6}$/, "Use 3–6 digits, e.g. 1010");
const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");

/* ───────── Chart of accounts ───────── */

/** Create an account, or edit one (name, description and parent only; code, type and kind never change). */
export const saveAccountInput = z.object({
  code: accountCode,
  name: text(2, 80),
  type: z.enum(ACCOUNT_TYPES),
  parentCode: accountCode.nullable().default(null),
  isGroup: z.boolean().default(false),
  contra: z.boolean().default(false),
  description: optionalText(200),
});
export const setAccountActiveInput = z.object({ code: accountCode, isActive: z.boolean() });
export const deleteAccountInput = z.object({ code: accountCode });
export const setRoleInput = z.object({ role: z.enum(/** @type {[string, ...string[]]} */ (Object.keys(ROLES))), code: accountCode });

/* ───────── Journals ───────── */

export const journalLineInput = z.object({
  accountCode,
  debit: paisa.default(0),
  credit: paisa.default(0),
  memo: optionalText(200),
  partyType: z.enum(["customer", "supplier"]).nullable().optional(),
  partyId: docId.nullable().optional(),
});

const lines = z.array(journalLineInput).min(2, "A journal needs at least two lines").max(50, "At most 50 lines");

/** A manual journal entry: saved as a draft, or posted straight away. */
export const createJournalInput = z.object({ idempotencyKey: key, date: pastDateKey, memo: text(3, 300), lines, post: z.boolean().default(false) });
export const postDraftInput = z.object({ id: docId, idempotencyKey: key });
export const deleteDraftInput = z.object({ id: docId });
export const reverseJournalInput = z.object({ journalId: docId, reason: text(3, 200), date: pastDateKey.optional() });

/** Opening balances: asset, liability and equity lines only; debits must equal credits. */
export const openingBalanceInput = z.object({ idempotencyKey: key, date: pastDateKey, memo: optionalText(200), lines });
export const previewOpeningInput = z.object({ date: pastDateKey, lines });

export const retryExceptionInput = z.object({ id: z.string().min(1).max(200) });
export const enableAccountingInput = z.object({});

/* ───────── Reports ───────── */

export const asOfInput = z.object({ asOf: dateKey });
export const periodInput = z
  .object({ from: dateKey, to: dateKey })
  .refine((r) => r.to >= r.from, { message: "End date must be after the start date", path: ["to"] })
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 366 * 86400000, { message: "Choose at most one year", path: ["to"] });
/** Any start date (statements from the first journal). */
export const trialBalanceInput = z.object({ from: dateKey, to: dateKey }).refine((r) => r.to >= r.from, { message: "End date must be after the start date", path: ["to"] });
export const generalLedgerInput = z
  .object({ accountCode, from: dateKey, to: dateKey, after: z.object({ id: z.string().min(1).max(200), running: z.number().int() }).nullish() })
  .refine((r) => r.to >= r.from, { message: "End date must be after the start date", path: ["to"] });
export const partyListInput = z.object({ partyType: z.enum(["customer", "supplier"]), after: z.string().max(200).nullish() });
export const RECONCILE_STAGES = /** @type {const} */ (["journals", "sales", "grn", "supplierPayments", "purchaseReturns", "customerPayments", "suppliers"]);
export const reconcileInput = z.object({ stage: z.enum(RECONCILE_STAGES), cursor: z.string().max(200).nullish() });

/* ───────── Period closing and bank reconciliation ───────── */

export const closePeriodInput = z.object({ idempotencyKey: key, through: dateKey, note: optionalText(200) });
/** `through: null` reopens everything; a date reopens from the day after it. */
export const reopenPeriodInput = z.object({ idempotencyKey: key, through: dateKey.nullable(), reason: text(5, 200) });
export const periodChecksInput = z.object({ through: dateKey });
export const reconWorkspaceInput = z.object({ accountCode, statementDate: dateKey });
export const finishReconInput = z.object({
  idempotencyKey: key,
  accountCode,
  statementDate: dateKey,
  /** The ending balance printed on the statement, in paisa (negative when overdrawn). */
  statementBalance: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
  entryIds: z.array(z.string().min(3).max(200)).min(1, "Tick the lines that appear on the statement").max(400, "At most 400 lines at a time"),
  note: optionalText(200),
});
export const undoReconInput = z.object({ idempotencyKey: key, id: docId, reason: text(5, 200) });
export const listReconInput = z.object({ accountCode });
