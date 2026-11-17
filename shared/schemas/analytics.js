import { z } from "zod";
import { docId, text, optionalText } from "./common.js";
import { isDateKey } from "../accounting.js";
import { ANALYTICS_REPORT_KEYS, GRANULARITIES, SCHEDULE_REPORTS } from "../analytics.js";

const dateKey = z.string().refine(isDateKey, "Use a valid date");
const optDate = z.string().refine((s) => s === "" || isDateKey(s), "Use a valid date").default("");
const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");
const ids = (max) => z.array(docId).max(max).default([]);
const MAX_DAYS = 1100;
const spanOk = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 <= MAX_DAYS;

/** The filters a report can be narrowed by. Every list is optional; empty means "all". */
export const analyticsFiltersInput = z.object({
  productIds: ids(100),
  categoryIds: ids(50),
  supplierIds: ids(50),
  customerIds: ids(50),
  paymentMethods: z.array(z.enum(["cash", "bank_transfer", "jazzcash", "easypaisa", "cod", "card", "mixed", "other"])).max(8).default([]),
  warehouseId: docId.nullable().optional(),
  channel: z.enum(["", "online", "pos"]).default(""),
  accountCode: optionalText(20),
}).default({ productIds: [], categoryIds: [], supplierIds: [], customerIds: [], paymentMethods: [], channel: "", accountCode: "" });

const range = z.object({ from: dateKey, to: dateKey, compareFrom: optDate, compareTo: optDate });
const rangeChecks = (r) => r.to >= r.from && spanOk(r.from, r.to) && (r.compareFrom === "") === (r.compareTo === "") && (r.compareFrom === "" || (r.compareTo >= r.compareFrom && spanOk(r.compareFrom, r.compareTo)));
const rangeMessage = { message: "Check the dates: the end can't be before the start, a period is at most about three years, and a comparison needs both dates.", path: ["to"] };

export const analyticsReportInput = range
  .extend({ report: z.enum(ANALYTICS_REPORT_KEYS), granularity: z.enum(GRANULARITIES).default("day"), filters: analyticsFiltersInput, limit: z.number().int().min(1).max(500).default(50) })
  .refine(rangeChecks, rangeMessage);
export const analyticsExecutiveInput = range.refine(rangeChecks, rangeMessage);
export const analyticsExportInput = z.object({ report: z.enum([...ANALYTICS_REPORT_KEYS, "executive"]), format: z.enum(["csv", "excel", "pdf", "print"]), from: dateKey, to: dateKey });

export const saveReportConfigInput = z.object({
  id: docId.optional(),
  name: text(2, 60),
  report: z.enum(ANALYTICS_REPORT_KEYS),
  granularity: z.enum(GRANULARITIES).default("day"),
  /** A saved range is relative so the report stays useful tomorrow. */
  period: z.enum(["today", "yesterday", "week", "month", "year", "last30", "last90"]).default("month"),
  compare: z.boolean().default(false),
  filters: analyticsFiltersInput,
});
export const reportConfigIdInput = z.object({ id: docId });
export const analyticsEmptyInput = z.object({});

export const saveScheduleInput = z.object({
  id: docId.optional(),
  report: z.enum(/** @type {[string, ...string[]]} */ (Object.keys(SCHEDULE_REPORTS))),
  name: text(2, 60),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  /** Staff members who see the result in their report inbox. */
  recipientUids: z.array(z.string().min(8).max(128)).min(1, "Choose at least one recipient").max(20),
  isActive: z.boolean().default(true),
});
export const scheduleActiveInput = z.object({ id: docId, isActive: z.boolean() });
export const runSchedulesInput = z.object({ idempotencyKey: key.optional() });
export const reportInboxInput = z.object({ limit: z.number().int().min(1).max(50).default(20) });
export const reportRunIdInput = z.object({ id: docId });
