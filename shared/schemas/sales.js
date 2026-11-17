import { z } from "zod";
import { docId, paisa, pricePaisa, text, optionalText } from "./common.js";
import { SALE_CHANNELS, SALE_STATUSES, SALE_PAYMENT_METHODS } from "../sales.js";

const qty = z.number().int().min(1).max(1000000);
const allocation = z.object({ warehouseId: docId, qty });

export const saleLineSchema = z.object({
  productId: docId,
  variantId: docId,
  sku: z.string().max(64),
  productName: z.string().min(1).max(200),
  variantLabel: z.string().max(120),
  colorName: z.string().max(60),
  sizeLabel: z.string().max(60),
  qty,
  regularPrice: paisa,
  unitPrice: paisa,
  itemDiscount: paisa,
  lineTotal: paisa,
  couponShare: paisa,
  lineNet: paisa,
  allocations: z.array(allocation).min(1),
  imagePath: z.string().nullable(),
});

/**
 * A sale as the server writes it (everything except the server timestamps). The service parses every sale with
 * this before saving, so a sale whose lines and totals don't add up can never be stored.
 */
export const saleSchema = z
  .object({
    number: z.string().regex(/^SL-\d{6,}$/),
    channel: z.enum(SALE_CHANNELS),
    orderId: docId.nullable(),
    orderNumber: z.string().nullable(),
    customerId: docId.nullable(),
    customer: z.object({ name: z.string(), phone: z.string(), email: z.string().nullable() }).nullable(),
    customerPhone: z.string().nullable(),
    address: z.record(z.string(), z.any()).nullable(),
    shippingMethod: z.record(z.string(), z.any()).nullable(),
    warehouseId: docId,
    warehouseIds: z.array(docId).min(1),
    lines: z.array(saleLineSchema).min(1),
    itemCount: qty,
    grossSales: paisa,
    itemDiscountTotal: paisa,
    subtotal: paisa,
    discountTotal: paisa,
    couponCode: z.string().nullable(),
    netSales: paisa,
    taxTotal: paisa,
    shippingTotal: paisa,
    total: paisa,
    paymentMethod: z.enum(SALE_PAYMENT_METHODS),
    paymentStatus: z.string(),
    paidTotal: paisa,
    refundedTotal: paisa,
    amountDue: paisa,
    status: z.enum(SALE_STATUSES),
    stockApplied: z.boolean(),
    idempotencyKey: z.string().nullable(),
    createdBy: z.string(),
    /** Walk-in (POS) sales: the register session, the cashier, and the tenders as taken (for the receipt). */
    sessionId: docId.nullable().optional(),
    cashierUid: z.string().nullable().optional(),
    cashierName: z.string().nullable().optional(),
    pos: z.record(z.string(), z.any()).nullable().optional(),
    /** Loyalty points redeemed and the customer discount applied (both are part of discountTotal). */
    loyalty: z.record(z.string(), z.any()).nullable().optional(),
    crmDiscount: z.record(z.string(), z.any()).nullable().optional(),
  })
  .superRefine((s, ctx) => {
    const fail = (message, path) => ctx.addIssue({ code: "custom", message, path: [path] });
    const sum = (f) => s.lines.reduce((n, l) => n + l[f], 0);
    if (sum("lineTotal") !== s.subtotal) fail("Lines don't add up to the subtotal", "subtotal");
    if (sum("couponShare") !== s.discountTotal) fail("Line discounts don't add up to the discount", "discountTotal");
    if (sum("itemDiscount") !== s.itemDiscountTotal) fail("Item discounts don't add up", "itemDiscountTotal");
    if (s.lines.reduce((n, l) => n + l.regularPrice * l.qty, 0) !== s.grossSales) fail("Gross sales don't add up", "grossSales");
    if (s.subtotal - s.discountTotal !== s.netSales) fail("Net sales are wrong", "netSales");
    if (s.netSales + s.taxTotal + s.shippingTotal !== s.total) fail("Total is wrong", "total");
    if (s.lines.reduce((n, l) => n + l.qty, 0) !== s.itemCount) fail("Item count is wrong", "itemCount");
    if (s.lines.some((l) => l.allocations.reduce((n, a) => n + a.qty, 0) !== l.qty)) fail("A line's warehouses don't add up to its quantity", "lines");
    if (s.channel === "online" && !s.orderId) fail("An online sale needs its order", "orderId");
  });

/** Record money received against a sale (partial payments and several payments are allowed). */
export const recordSalePaymentInput = z
  .object({
    idempotencyKey: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key"),
    saleId: docId,
    amount: pricePaisa,
    method: z.enum(SALE_PAYMENT_METHODS),
    reference: optionalText(80),
    note: optionalText(300),
  })
  .refine((p) => ["cash", "cod"].includes(p.method) || p.reference.length >= 3, { message: "Enter the transaction or reference number", path: ["reference"] });

/** Undo a recorded payment by adding an opposite entry. The original entry is never edited or deleted. */
export const reverseSalePaymentInput = z.object({
  idempotencyKey: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key"),
  saleId: docId,
  transactionId: docId,
  reason: text(3, 200),
});
