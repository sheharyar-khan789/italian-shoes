import { z } from "zod";
import { docId, paisa, pricePaisa, text, optionalText } from "./common.js";
import { ADJUST_REASON_KEYS } from "../inventory.js";
import { isDateKey } from "../accounting.js";

const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");
const dateKey = z.string().refine(isDateKey, "Use a valid date");
const qty = z.number().int("Whole pairs only").min(0).max(1000000);

/** A signed change in pairs (negative = remove) with a reason; stock is never overwritten, only changed by a recorded amount. */
export const createAdjustmentInput = z.object({
  idempotencyKey: key,
  productId: docId,
  variantId: docId,
  warehouseId: docId,
  reason: z.enum(ADJUST_REASON_KEYS),
  change: z.number().int("Whole pairs only").min(-1000000).max(1000000).refine((n) => n !== 0, "Enter a change other than zero"),
  description: text(3, 300),
  /** What the person saw on screen. If the stock has changed since, the adjustment is refused instead of overwriting newer movements. */
  seenOnHand: qty.optional(),
});
export const decideAdjustmentInput = z.object({ id: docId, decision: z.enum(["approve", "reject"]), note: optionalText(200) });
export const costAdjustInput = z.object({ idempotencyKey: key, productId: docId, variantId: docId, newCost: pricePaisa, reason: text(3, 200) });

export const stockPolicyInput = z
  .object({
    productId: docId,
    variantId: docId,
    minStock: qty.nullable().default(null),
    reorderLevel: qty.nullable().default(null),
    maxStock: qty.nullable().default(null),
    /** Where the pairs are kept, per warehouse (shelf / bin). */
    locations: z.record(docId, text(0, 40)).default({}),
  })
  .refine((p) => p.maxStock === null || p.minStock === null || p.maxStock >= p.minStock, { message: "The maximum can't be below the minimum", path: ["maxStock"] })
  .refine((p) => p.reorderLevel === null || p.minStock === null || p.reorderLevel >= p.minStock, { message: "The reorder level can't be below the minimum", path: ["reorderLevel"] });

export const inventorySettingsInput = z.object({ lowStock: qty, slowDays: z.number().int().min(7).max(720), deadDays: z.number().int().min(14).max(1440), adjustApprovalUnits: qty, adjustApprovalValue: paisa }).refine((s) => s.deadDays > s.slowDays, { message: "Dead stock days must be more than slow-moving days", path: ["deadDays"] });

export const startCountInput = z.object({ idempotencyKey: key, warehouseId: docId, name: optionalText(80), prefill: z.boolean().default(true) });
export const countLineInput = z.object({ sessionId: docId, productId: docId, variantId: docId, countedQty: qty });
export const countActionInput = z.object({ id: docId });
export const decideCountInput = z.object({ id: docId, decision: z.enum(["approve", "reject"]), note: optionalText(200) });

/** Receive a dispatched transfer, in whole or in part, reporting damaged and missing pairs. */
export const receiveTransferLinesInput = z
  .object({
    idempotencyKey: key,
    id: docId,
    lines: z.array(z.object({ lineIndex: z.number().int().min(0).max(200), receivedQty: qty, damagedQty: qty.default(0), missingQty: qty.default(0) })).min(1).max(200),
    note: optionalText(200),
  })
  .refine((r) => r.lines.some((l) => l.receivedQty + l.damagedQty + l.missingQty > 0), { message: "Enter at least one quantity", path: ["lines"] })
  .refine((r) => new Set(r.lines.map((l) => l.lineIndex)).size === r.lines.length, { message: "A line appears twice", path: ["lines"] });

export const assignBarcodeInput = z.object({ productId: docId, variantId: docId, barcode: z.string().regex(/^\d{8,14}$/, "Use 8 to 14 digits").optional() });
export const lookupBarcodeInput = z.object({ code: text(3, 40) });
export const inventoryRangeInput = z.object({ from: dateKey, to: dateKey, warehouseId: docId.optional() }).refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const inventoryReportInput = z
  .object({
    report: z.enum(["summary", "product", "size", "colour", "warehouse", "movements", "adjustments", "transfers", "counts", "valuation", "low", "slow"]),
    from: dateKey,
    to: dateKey,
    warehouseId: docId.optional(),
  })
  .refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const emptyInventoryInput = z.object({});
