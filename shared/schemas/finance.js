import { z } from "zod";
import { docId, paisa, pricePaisa, text, optionalText } from "./common.js";
import { FINANCE_METHODS, isReceiptUrl } from "../finance.js";
import { isDateKey } from "../accounting.js";

const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");
const dateKey = z.string().refine(isDateKey, "Use a valid date");
const account = z.string().regex(/^[0-9]{3,10}$/, "Invalid account");
const method = z.enum(FINANCE_METHODS);

export const attachmentInput = z.object({
  url: z.string().max(600).refine(isReceiptUrl, "That file wasn't uploaded through the receipt uploader"),
  name: text(1, 120),
  type: z.string().max(60),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
});

/** Create (no id) or edit (id + expectedVersion) an income or expense entry. */
export const financeEntryInput = z
  .object({
    idempotencyKey: key.optional(),
    id: docId.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    type: z.enum(["income", "expense"]),
    date: dateKey,
    amount: pricePaisa,
    title: text(2, 120),
    description: optionalText(500),
    categoryId: docId,
    method,
    accountCode: account.nullable().optional(),
    reference: optionalText(80),
    vendorName: optionalText(120),
    supplierId: docId.nullable().optional(),
    attachments: z.array(attachmentInput).max(5).default([]),
    recurringId: docId.nullable().optional(),
  })
  .refine((e) => (e.id ? e.expectedVersion !== undefined : Boolean(e.idempotencyKey)), { message: "Missing key or version", path: ["idempotencyKey"] });

export const voidFinanceEntryInput = z.object({ id: docId, reason: text(3, 200) });
export const decideExpenseInput = z.object({ id: docId, decision: z.enum(["approve", "reject"]), note: optionalText(200) });
export const transferInput = z.object({ idempotencyKey: key, date: dateKey, fromAccount: account, toAccount: account, amount: pricePaisa, reference: optionalText(80), note: optionalText(200) }).refine((t) => t.fromAccount !== t.toAccount, { message: "Choose two different accounts", path: ["toAccount"] });
export const cashCountInput = z.object({ idempotencyKey: key, accountCode: account, date: dateKey, countedAmount: paisa, note: optionalText(300), adjust: z.boolean().default(false) });
export const financeCategoryInput = z.object({ id: docId.optional(), kind: z.enum(["income", "expense"]), name: text(2, 60), accountCode: account.nullable().optional() });
export const financeCategoryActiveInput = z.object({ id: docId, isActive: z.boolean() });
export const suggestedCategoriesInput = z.object({ kind: z.enum(["income", "expense"]) });
export const listEntriesInput = z.object({ type: z.enum(["income", "expense", "transfer", "adjustment"]).optional(), status: z.enum(["posted", "pending", "rejected", "void"]).optional(), from: dateKey.optional(), to: dateKey.optional(), accountCode: account.optional(), categoryId: docId.optional(), after: docId.nullable().optional(), limit: z.number().int().min(1).max(100).default(50) });
export const financeSettingsInput = z.object({ approvalThreshold: paisa });
export const addBankAccountInput = z.object({ idempotencyKey: key, name: text(2, 60) });
export const recurringInput = z.object({
  id: docId.optional(),
  title: text(2, 120),
  description: optionalText(500),
  amount: pricePaisa,
  categoryId: docId,
  method,
  accountCode: account.nullable().optional(),
  vendorName: optionalText(120),
  frequency: z.enum(["weekly", "monthly"]),
  startDate: dateKey,
  isActive: z.boolean().default(true),
});
export const recurringActiveInput = z.object({ id: docId, isActive: z.boolean() });
export const emptyInput = z.object({});
export const financeRangeInput = z.object({ from: dateKey, to: dateKey }).refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const financeReportInput = z
  .object({ report: z.enum(["daily", "monthly", "cashflow", "pnl", "cashregister", "bank", "expensecat", "incomecat", "ledger"]), from: dateKey, to: dateKey, accountCode: account.optional() })
  .refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
