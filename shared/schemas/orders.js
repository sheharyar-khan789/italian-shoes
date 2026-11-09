import { z } from "zod";
import { docId, optionalText } from "./common.js";
import { ORDER_STATUSES } from "../orderStatus.js";
import { httpsUrl, shippingMethodSchema, shippingRateSchema, couponSchema, couponCode } from "./commerce.js";
import { pricePaisa } from "./common.js";

/** Same checkout input without the final submit fields: used to preview totals before ordering. */
export const quoteInput = z.object({
  items: z
    .array(z.object({ productId: docId, variantId: docId, qty: z.number().int().min(1).max(10) }))
    .min(1)
    .max(50),
  city: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(2).max(60)),
  shippingMethodId: docId.optional(),
  couponCode: z.string().max(40).optional(),
});

export const updateOrderStatusInput = z.object({
  orderId: docId,
  status: z.enum(ORDER_STATUSES),
  note: optionalText(300),
});

export const cancelMyOrderInput = z.object({ orderId: docId, reason: optionalText(300) });

export const addOrderNoteInput = z.object({
  orderId: docId,
  text: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Write a note").max(1000)),
});

export const addShipmentInput = z.object({
  orderId: docId,
  courier: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(2, "Enter the courier").max(60)),
  trackingNumber: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(3, "Enter the tracking number").max(60)),
  trackingUrl: httpsUrl.default(""),
});

export const exportOrdersInput = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(ORDER_STATUSES).optional(),
});

/* ───────── Payments (Phase 7) ───────── */

/** Cash on Delivery: the courier or store received the full amount. */
export const recordCollectionInput = z.object({ orderId: docId, note: optionalText(300) });

export const recordRefundInput = z.object({
  orderId: docId,
  amount: pricePaisa,
  reason: z
    .string()
    .transform((s) => s.replace(/s+/g, " ").trim())
    .pipe(z.string().min(3, "Give a reason for the refund").max(300)),
});

/** Switch a payment method on or off. Only methods that actually exist can be listed. */
export const setPaymentMethodInput = z.object({ key: z.enum(["cod"]), isEnabled: z.boolean() });

/* ───────── Shipping (Phase 7) ───────── */

export const saveShippingMethodInput = shippingMethodSchema.extend({ id: docId.optional() });
export const saveShippingRateInput = shippingRateSchema;
export const deleteShippingInput = z.object({ kind: z.enum(["method", "rate"]), id: docId });

/* ───────── Coupons (admin) ───────── */

export const saveCouponInput = couponSchema;
export const deleteCouponInput = z.object({ code: couponCode });
