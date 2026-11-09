import { z } from "zod";
import { docId, paisa, text, longText, optionalText } from "./common.js";

/* ───────── Coupons ───────── */

export const couponCode = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().min(3).max(40).regex(/^[A-Z0-9_-]+$/, "Letters, numbers, dash or underscore"));

export const couponSchema = z
  .object({
    code: couponCode,
    type: z.enum(["percent", "fixed"]),
    /** percent: 1–100 · fixed: paisa */
    value: z.number().positive(),
    minOrder: paisa.default(0),
    maxDiscount: paisa.nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    usageLimit: z.number().int().positive().nullable().default(null),
    perCustomerLimit: z.number().int().positive().nullable().default(null),
    productIds: z.array(docId).max(200).default([]),
    categoryIds: z.array(docId).max(50).default([]),
    isActive: z.boolean().default(true),
  })
  .refine((c) => (c.type === "percent" ? c.value <= 100 : Number.isSafeInteger(c.value)), {
    message: "Percent must be 1–100; a fixed amount must be whole paisa",
    path: ["value"],
  })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt > c.startsAt, {
    message: "End date must be after the start date",
    path: ["endsAt"],
  });

/* ───────── Shipping ───────── */

export const shippingMethodSchema = z.object({
  name: text(2, 60),
  description: longText(300).default(""),
  /** Written by the owner, e.g. "2–4 working days". Never generated. */
  estimateText: optionalText(80),
  isActive: z.boolean().default(true),
});

export const shippingRateSchema = z.object({
  methodId: docId,
  /** Exact city name, or "*" for every city without its own rate. */
  city: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(60)),
  charge: paisa,
  freeOver: paisa.nullable().default(null),
});

/* ───────── Store settings (public part) ───────── */

/** Empty, or an https:// link (blocks javascript: and other unsafe links in owner-entered URLs). */
export const httpsUrl = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .max(300)
      .refine((s) => {
        if (s === "") return true;
        try {
          return new URL(s).protocol === "https:";
        } catch {
          return false;
        }
      }, "Use a full link starting with https://"),
  );

/** Store phone: mobile or landline, digits with optional + - spaces. */
const storePhone = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().max(30).regex(/^$|^\+?[0-9][0-9 -]{6,28}$/, "Use digits, spaces, + or -"));

const optionalEmail = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().max(254).regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"));

/** Readable by everyone (storefront header, footer, contact page, SEO). Edited by the Owner. */
export const publicSettingsSchema = z.object({
  storeName: text(1, 80),
  storeNameUrdu: optionalText(80),
  phone: storePhone.default(""),
  email: optionalEmail.default(""),
  address: optionalText(200),
  hours: optionalText(120),
  instagram: httpsUrl.default(""),
  facebook: httpsUrl.default(""),
  announcement: optionalText(140),
  currency: z.literal("PKR").default("PKR"),
  isOpen: z.boolean().default(true),
  registrationOpen: z.boolean().default(true),
  seoTitle: optionalText(70),
  seoDescription: optionalText(160),
});

/** Staff-only operational settings. */
export const privateSettingsSchema = z.object({
  orderPrefix: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2,6}$/, "2–6 letters, e.g. IS")),
  lowStockThreshold: z.number({ error: "Enter a whole number" }).int("Enter a whole number").min(0).max(1000),
  taxEnabled: z.boolean().default(false),
  /** Only used when taxEnabled; set by the owner from their tax advice, never assumed. */
  taxRatePercent: z.number({ error: "Enter a number" }).min(0).max(30, "At most 30%").default(0),
  notifyNewOrders: z.boolean().default(true),
  notifyLowStock: z.boolean().default(true),
});

export const saveSettingsSchema = z.object({ public: publicSettingsSchema, private: privateSettingsSchema });
