import { z } from "zod";
import { docId, text, longText, optionalText, pkMobile, email } from "./common.js";

export const MAX_QTY_PER_LINE = 10;
export const MAX_LINES = 50;

export const addressSchema = z.object({
  label: optionalText(40),
  name: text(3, 80).refine((s) => /\p{L}/u.test(s), "Please enter a valid name"),
  phone: pkMobile,
  city: text(2, 60),
  area: text(2, 80),
  line1: longText(300).pipe(z.string().min(10, "Please enter your complete address — house, street and nearby landmark")),
  isDefault: z.boolean().default(false),
});

export const customerDetailsSchema = z.object({
  name: text(3, 80).refine((s) => /\p{L}/u.test(s), "Please enter a valid name"),
  phone: pkMobile,
  email: email.optional(),
});

export const PAYMENT_METHODS = /** @type {const} */ (["cod"]);

/**
 * What the browser may send when placing an order. Note what is NOT here: prices, totals,
 * discounts, shipping charges or payment status. The server calculates all of those.
 */
export const placeOrderSchema = z.object({
  idempotencyKey: z.string().uuid(),
  items: z
    .array(z.object({ variantId: docId, qty: z.number().int().min(1).max(MAX_QTY_PER_LINE) }))
    .min(1, "Your bag is empty")
    .max(MAX_LINES)
    .refine((items) => new Set(items.map((i) => i.variantId)).size === items.length, "Duplicate items"),
  customer: customerDetailsSchema,
  address: addressSchema.omit({ label: true, isDefault: true }),
  shippingMethodId: docId,
  couponCode: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().max(40))
    .optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  deliveryInstructions: optionalText(300),
  notes: optionalText(500),
  termsAccepted: z.literal(true, { error: "Please accept the terms to place your order" }),
});
