import { z } from "zod";
import { docId, paisa, text, optionalText, longText, email as emailSchema } from "./common.js";
import { isDateKey } from "../accounting.js";
import { NOTE_TYPES } from "../crm.js";

const key = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/, "Invalid key");
const dateKey = z.string().refine(isDateKey, "Use a valid date");
const optDate = z.string().refine((s) => s === "" || isDateKey(s), "Use a valid date").default("");
const tag = z.string().trim().min(1).max(30);

/** Create (no id) or edit (id) a customer. Only a name is required: walk-in customers are allowed. */
export const saveCrmCustomerInput = z.object({
  id: docId.optional(),
  name: text(2, 100),
  phone: optionalText(30),
  whatsapp: optionalText(30),
  email: z.union([emailSchema, z.literal("")]).default(""),
  address: optionalText(300),
  city: optionalText(60),
  customerType: optionalText(40),
  tags: z.array(tag).max(10).default([]),
  notes: longText(1000).optional().default(""),
  /** Optional, volunteered by the customer. */
  dateOfBirth: optDate,
  /** What the customer agreed to. Messages are never sent without consent. */
  consent: z.object({ marketing: z.boolean().default(false), whatsapp: z.boolean().default(false), sms: z.boolean().default(false), email: z.boolean().default(false) }).default({ marketing: false, whatsapp: false, sms: false, email: false }),
});
export const crmCustomerActiveInput = z.object({ id: docId, isActive: z.boolean() });
export const crmListInput = z.object({
  q: optionalText(80),
  status: z.enum(["active", "archived", "all"]).default("active"),
  segment: optionalText(20),
  tier: optionalText(30),
  tag: optionalText(30),
  type: optionalText(40),
  sort: z.enum(["name", "newest", "spent", "orders", "last"]).default("name"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(5000).default(0),
});
export const crmIdInput = z.object({ id: docId });

export const crmNoteInput = z.object({
  customerId: docId,
  type: z.enum(Object.keys(NOTE_TYPES)),
  text: text(2, 1000),
  followUpDate: optDate,
  relatedSaleId: docId.nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  warranty: optionalText(200),
});
export const crmNoteUpdateInput = z.object({ id: docId, status: z.enum(["open", "in_progress", "resolved", "closed"]), resolution: optionalText(1000) });
export const crmNotesListInput = z.object({ customerId: docId.optional(), type: z.enum(Object.keys(NOTE_TYPES)).optional(), status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(), dueBy: dateKey.optional(), limit: z.number().int().min(1).max(200).default(50) });

const loyalty = z.object({
  enabled: z.boolean(),
  pointsPer100: z.number().min(0).max(1000),
  redeemValuePerPoint: paisa,
  minRedeemPoints: z.number().int().min(0).max(1000000),
  maxRedeemPercent: z.number().min(0).max(100),
  maxRedeemPointsPerSale: z.number().int().min(0).max(10000000),
  expiryDays: z.number().int().min(0).max(3650),
  excludedCategoryIds: z.array(docId).max(100),
  excludedProductIds: z.array(docId).max(500),
});
export const crmSettingsInput = z.object({
  customerTypes: z.array(text(2, 40)).min(1).max(20),
  segments: z.object({ newDays: z.number().int().min(1).max(3650), regularOrders: z.number().int().min(1).max(1000), regularDays: z.number().int().min(1).max(3650), vipSpend: paisa, highValueSpend: paisa, inactiveDays: z.number().int().min(0).max(3650), returningOrders: z.number().int().min(2).max(1000) }),
  tiers: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{2,20}$/, "Use lowercase letters, numbers or _"), name: text(2, 30), minAnnualSpend: paisa, discountPercent: z.number().min(0).max(100), pointsMultiplier: z.number().min(0).max(10) })).min(1).max(8),
  loyalty,
}).refine((s) => new Set(s.tiers.map((t) => t.key)).size === s.tiers.length, { message: "Tier keys must be different", path: ["tiers"] }).refine((s) => s.tiers.some((t) => t.minAnnualSpend === 0), { message: "One tier must start at Rs 0", path: ["tiers"] });

export const loyaltyAdjustInput = z.object({ idempotencyKey: key, customerId: docId, points: z.number().int().min(-10000000).max(10000000).refine((n) => n !== 0, "Enter a number other than zero"), reason: text(3, 200) });
export const loyaltyHistoryInput = z.object({ customerId: docId, limit: z.number().int().min(1).max(200).default(50) });

export const saveCrmDiscountInput = z.object({
  id: docId.optional(),
  name: text(2, 80),
  scope: z.enum(["all", "customer", "tier", "segment"]),
  customerId: docId.nullable().optional(),
  tier: optionalText(30),
  segment: optionalText(20),
  type: z.enum(["percent", "amount"]),
  value: z.number().int().min(1),
  minPurchase: paisa.default(0),
  validFrom: optDate,
  validTo: optDate,
  usageLimit: z.number().int().min(0).default(0),
  perCustomerLimit: z.number().int().min(0).default(0),
  productIds: z.array(docId).max(200).default([]),
  categoryIds: z.array(docId).max(50).default([]),
  isActive: z.boolean().default(true),
}).refine((d) => d.type === "amount" || d.value <= 100, { message: "A percentage can't be more than 100", path: ["value"] })
  .refine((d) => d.scope !== "customer" || Boolean(d.customerId), { message: "Choose the customer", path: ["customerId"] })
  .refine((d) => d.scope !== "tier" || Boolean(d.tier), { message: "Choose the tier", path: ["tier"] })
  .refine((d) => d.scope !== "segment" || Boolean(d.segment), { message: "Choose the group", path: ["segment"] })
  .refine((d) => !d.validFrom || !d.validTo || d.validTo >= d.validFrom, { message: "The end date is before the start", path: ["validTo"] });
export const crmDiscountActiveInput = z.object({ id: docId, isActive: z.boolean() });

export const crmReportInput = z.object({
  report: z.enum(["directory", "purchases", "top", "retention", "lifetime", "segments", "loyalty", "discounts", "inactive", "returns", "birthdays", "followups"]),
  from: dateKey,
  to: dateKey,
}).refine((r) => r.to >= r.from, { message: "End date must not be before the start date", path: ["to"] });
export const crmEmptyInput = z.object({});
export const crmLookupInput = z.object({ q: text(2, 80) });
export const crmQuickCreateInput = z.object({ name: text(2, 100), phone: text(7, 30), whatsapp: optionalText(30), consentMarketing: z.boolean().default(false) });
