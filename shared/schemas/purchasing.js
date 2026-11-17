import { z } from "zod";
import { docId, paisa, pricePaisa, text, optionalText, longText } from "./common.js";
import { PURCHASE_MAX_LINES, SUPPLIER_PAY_METHODS } from "../purchase.js";
import { attachmentInput } from "./finance.js";
import { isDateKey } from "../accounting.js";

/** A date from a form (YYYY-MM-DD or ISO), not before 2000 and not more than a day ahead. */
const businessDate = z.coerce.date().refine((d) => d.getFullYear() >= 2000 && d.getTime() <= Date.now() + 86400000, "Enter a real date, not in the future");

/** Chosen by the browser once per button press; makes a repeated request apply only once. */
export const idempotencyKey = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");

/* ───────── Suppliers ───────── */

export const saveSupplierInput = z.object({
  id: docId.optional(),
  name: text(2, 120),
  contactPerson: optionalText(120),
  phone: optionalText(30),
  email: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.string().max(254).refine((s) => s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), "Enter a valid email address"))
    .optional()
    .default(""),
  address: optionalText(300),
  /** WhatsApp number, tax registration (NTN / STRN) and uploaded documents (agreements, price lists, …). */
  whatsapp: optionalText(30),
  taxNumber: optionalText(40),
  documents: z.array(attachmentInput).max(10).default([]),
  notes: longText(1000).optional().default(""),
  /** What the store already owed this supplier when it was added (paisa). Fixed once saved; it is the first ledger entry. */
  openingBalance: paisa.default(0),
});

export const setSupplierActiveInput = z.object({ id: docId, isActive: z.boolean() });

/* ───────── Purchase orders ───────── */

export const PO_STATUSES = /** @type {const} */ (["draft", "ordered", "partially_received", "received", "closed", "cancelled"]);

export const purchaseLineInput = z.object({
  productId: docId,
  variantId: docId,
  qty: z.number().int("Whole pairs only").min(1, "At least 1").max(1000000, "Too many"),
  unitCost: pricePaisa,
  discount: paisa.default(0),
});

export const savePurchaseOrderInput = z
  .object({
    id: docId.optional(),
    supplierId: docId,
    warehouseId: docId,
    supplierReference: optionalText(60),
    expectedDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Use a date").optional().default(""),
    purchaseDate: z.string().refine((s) => s === "" || isDateKey(s), "Use a real date").optional().default(""),
    note: optionalText(300),
    discount: paisa.default(0),
    /** Tax as a percentage (up to two decimals) of the order after discount, and extra charges such as freight. Both are added to the cost of the goods. */
    taxPercent: z.number().min(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, "At most two decimals").default(0),
    charges: z.array(z.object({ label: text(2, 60), amount: pricePaisa })).max(5).default([]),
    attachments: z.array(attachmentInput).max(5).default([]),
    lines: z.array(purchaseLineInput).min(1, "Add at least one item").max(PURCHASE_MAX_LINES, `At most ${PURCHASE_MAX_LINES} items per order`),
  })
  .refine((o) => new Set(o.lines.map((l) => `${l.productId}/${l.variantId}`)).size === o.lines.length, { message: "Each size/colour can appear only once", path: ["lines"] });

export const purchaseOrderActionInput = z.object({ id: docId });

/* ───────── Goods received ───────── */

export const receiveGoodsInput = z
  .object({
    idempotencyKey,
    purchaseOrderId: docId,
    receivedDate: businessDate.optional(),
    supplierInvoiceNo: optionalText(60),
    note: optionalText(300),
    lines: z
      .array(
        z.object({
          lineIndex: z.number().int().min(0).max(PURCHASE_MAX_LINES),
          acceptedQty: z.number().int().min(0).max(1000000),
          rejectedQty: z.number().int().min(0).max(1000000).default(0),
          rejectReason: optionalText(200),
          /** What happened to the rejected pairs. */
          rejectKind: z.enum(["damaged", "missing", "wrong_item"]).default("damaged"),
        }),
      )
      .min(1)
      .max(PURCHASE_MAX_LINES),
  })
  .refine((g) => g.lines.some((l) => l.acceptedQty + l.rejectedQty > 0), { message: "Enter at least one received or rejected quantity", path: ["lines"] })
  .refine((g) => g.lines.every((l) => l.rejectedQty === 0 || l.rejectReason.length >= 3), { message: "Say why goods were rejected or damaged", path: ["lines"] })
  .refine((g) => new Set(g.lines.map((l) => l.lineIndex)).size === g.lines.length, { message: "A line appears twice", path: ["lines"] });

/* ───────── Supplier payments ───────── */

export const supplierPaymentInput = z
  .object({
    idempotencyKey,
    supplierId: docId,
    purchaseOrderId: docId.nullable().optional(),
    amount: pricePaisa,
    method: z.enum(SUPPLIER_PAY_METHODS),
    reference: optionalText(80),
    paidAt: businessDate,
    note: optionalText(300),
    /** Pay more than is owed (an advance to the supplier). Needs its own permission. */
    advance: z.boolean().default(false),
  })
  .refine((p) => p.method === "cash" || p.reference.length >= 3, { message: "Enter the transaction or reference number", path: ["reference"] });

/** Money the supplier gives back (they owed us after an advance or a return). */
export const supplierRefundInput = z
  .object({ idempotencyKey, supplierId: docId, amount: pricePaisa, method: z.enum(SUPPLIER_PAY_METHODS), reference: optionalText(80), receivedAt: businessDate, note: optionalText(300) })
  .refine((p) => p.method === "cash" || p.reference.length >= 3, { message: "Enter the transaction or reference number", path: ["reference"] });

/** A manual change to what is owed, posted against an account the person chooses (for example Purchase Returns & Allowances). */
export const supplierAdjustmentInput = z.object({
  idempotencyKey,
  supplierId: docId,
  direction: z.enum(["increase", "decrease"]),
  amount: pricePaisa,
  accountCode: z.string().regex(/^[0-9]{3,10}$/, "Choose an account"),
  reason: text(3, 200),
  date: businessDate,
});

const dateKey = z.string().refine(isDateKey, "Use a valid date");
export const purchaseDashboardInput = z.object({ from: dateKey, to: dateKey }).refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const purchaseReportTablesInput = z
  .object({ report: z.enum(["register", "supplier", "product", "returns", "outstanding", "grn", "ledger"]), from: dateKey, to: dateKey, supplierId: docId.optional() })
  .refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] })
  .refine((r) => r.report !== "ledger" || Boolean(r.supplierId), { message: "Choose a supplier", path: ["supplierId"] });

/* ───────── Purchase returns ───────── */

export const purchaseReturnInput = z
  .object({
    idempotencyKey,
    grnId: docId,
    reason: text(3, 200),
    supplierReference: optionalText(80),
    lines: z
      .array(z.object({ lineIndex: z.number().int().min(0).max(PURCHASE_MAX_LINES), qty: z.number().int().min(1).max(1000000) }))
      .min(1, "Choose what to return")
      .max(PURCHASE_MAX_LINES),
  })
  .refine((r) => new Set(r.lines.map((l) => l.lineIndex)).size === r.lines.length, { message: "A line appears twice", path: ["lines"] });
