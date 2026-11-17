import { z } from "zod";
import { docId, paisa, pricePaisa, text, optionalText } from "./common.js";
import { POS_TENDER_METHODS, CASH_IN_REASONS, CASH_OUT_REASONS } from "../pos.js";

const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");

/** One payment at the counter. Bank and wallet entries need the reference the cashier saw. */
export const tenderInput = z
  .object({
    method: z.enum(POS_TENDER_METHODS),
    amount: pricePaisa,
    reference: optionalText(80),
    /** Cash handed over, so the receipt can show change. Never more than needed is recorded as a payment. */
    cashReceived: paisa.optional(),
  })
  .refine((t) => t.method === "cash" || t.reference.length >= 3, { message: "Enter the transaction or reference number", path: ["reference"] })
  .refine((t) => t.cashReceived === undefined || (t.method === "cash" && t.cashReceived >= t.amount), { message: "Cash received can't be less than the amount", path: ["cashReceived"] });

export const posLineInput = z.object({
  productId: docId,
  variantId: docId,
  qty: z.number().int("Whole pairs only").min(1).max(1000),
  /** Needs the override permission and a reason; never higher than the list price. */
  unitPrice: pricePaisa.optional(),
  overrideReason: optionalText(200),
});

export const posDiscountInput = z
  .object({ type: z.enum(["amount", "percent"]), value: z.number().int().min(1), reason: text(3, 200) })
  .refine((d) => d.type === "amount" || d.value <= 100, { message: "A percentage can't be more than 100", path: ["value"] });

export const posCheckoutInput = z
  .object({
    idempotencyKey: key,
    sessionId: docId,
    items: z.array(posLineInput).min(1, "The cart is empty").max(60, "At most 60 items per sale"),
    customerId: docId.nullable().optional(),
    customerName: optionalText(80),
    customerPhone: optionalText(30),
    discount: posDiscountInput.optional(),
    /** Apply the best eligible customer discount (decided by the server). Can't be combined with a manual discount. */
    applyCustomerDiscount: z.boolean().default(false),
    /** Loyalty points to redeem on this sale (checked by the server against the balance and the rules). */
    redeemPoints: z.number().int().min(0).max(10000000).default(0),
    tenders: z.array(tenderInput).max(6),
    note: optionalText(200),
  })
  .refine((c) => new Set(c.items.map((l) => `${l.productId}/${l.variantId}`)).size === c.items.length, { message: "Each size/colour can appear only once", path: ["items"] });

export const posPaymentInput = z.object({ idempotencyKey: key, saleId: docId, sessionId: docId, tender: tenderInput });

export const openRegisterInput = z.object({ idempotencyKey: key, warehouseId: docId, openingFloat: paisa, note: optionalText(200) });
export const closeRegisterInput = z.object({ sessionId: docId, countedCash: paisa, note: optionalText(300) });
export const registerCashInput = z
  .object({ idempotencyKey: key, sessionId: docId, type: z.enum(["cash_in", "cash_out"]), reason: z.enum([...CASH_IN_REASONS, ...CASH_OUT_REASONS]), amount: pricePaisa, note: text(3, 200) })
  .refine((c) => /** @type {readonly string[]} */ (c.type === "cash_in" ? CASH_IN_REASONS : CASH_OUT_REASONS).includes(c.reason), { message: "That reason doesn't fit this movement", path: ["reason"] });

export const posSearchInput = z.object({ q: text(1, 60), warehouseId: docId, exact: z.boolean().default(false) });
export const posCustomerInput = z.object({ q: text(3, 80) });
export const posReceiptInput = z.object({ saleId: docId });
export const posContextInput = z.object({});

/* ───────── Offline sales ───────── */

/** A sale made while the till was offline, sent when the connection returns. Cash only; the server re-prices everything. */
export const posSyncSaleInput = z.object({
  sale: posCheckoutInput,
  /** Same value as sale.idempotencyKey: one offline sale = one key, forever. */
  offlineId: key,
  recordedAt: z.string().datetime(),
  /** What the till showed and the customer paid. The server compares it with its own total; it never uses it as a price. */
  expectedTotal: pricePaisa,
  /** A manager accepting the server's price for a sale held because prices changed. */
  resolution: z.enum(["accept_server_price"]).optional(),
});
export const posSyncDiscardInput = z.object({ offlineId: key, reason: text(3, 200) });
export const posSyncListInput = z.object({ status: z.enum(["synced", "conflict", "failed", "discarded"]).optional(), limit: z.number().int().min(1).max(100).default(50) });
export const posCatalogInput = z.object({ warehouseId: docId, after: docId.nullable().optional() });

/** A preview of the customer discount and loyalty points for the cart on the till (writes nothing). */
export const posQuoteInput = z.object({
  customerId: docId.nullable().optional(),
  items: z.array(posLineInput).min(1).max(60),
  discount: posDiscountInput.nullable().optional(),
  applyCustomerDiscount: z.boolean().default(false),
  redeemPoints: z.number().int().min(0).max(10000000).default(0),
});

/** Goods taken back from a walk-in sale. The server works out every amount; the browser only says what came back. */
export const posReturnInput = z
  .object({
    idempotencyKey: key,
    saleId: docId,
    /** The open register the refund is paid from (needed for a cash refund). */
    sessionId: docId.nullable().optional(),
    lines: z
      .array(
        z.object({
          lineIndex: z.number().int().min(0).max(200),
          qty: z.number().int("Whole pairs only").min(1).max(1000),
          /** Resellable pairs go back on the shelf; damaged ones are written off. */
          condition: z.enum(["resellable", "damaged"]).default("resellable"),
        }),
      )
      .min(1, "Choose what is coming back")
      .max(60),
    reason: text(3, 200),
    refundMethod: z.enum(POS_TENDER_METHODS).default("cash"),
    /** True when the customer is taking other goods instead: the new sale is rung up separately. */
    exchange: z.boolean().default(false),
    /** Bank / wallet refunds need the reference. */
    reference: optionalText(80),
  })
  .refine((r) => new Set(r.lines.map((l) => l.lineIndex)).size === r.lines.length, { message: "Each line can appear only once", path: ["lines"] })
  .refine((r) => r.refundMethod === "cash" || r.reference.length >= 3, { message: "Enter the transaction or reference number", path: ["reference"] });

export const posReturnListInput = z.object({ saleId: docId.optional(), limit: z.number().int().min(1).max(100).default(30) });
