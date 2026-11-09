import { z } from "zod";
import { docId, slug, text, longText, optionalText } from "./common.js";

/* ───────── Reviews ───────── */

export const REVIEW_STATUSES = /** @type {const} */ (["pending", "approved", "rejected"]);

/** A customer's review of a product they received. */
export const submitReviewInput = z.object({
  productId: docId,
  rating: z.number().int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  title: text(0, 80).default(""),
  body: longText(1000).pipe(z.string().min(10, "Please write at least 10 characters")),
});

export const moderateReviewInput = z.object({
  reviewId: docId,
  status: z.enum(REVIEW_STATUSES),
  /** Optional public reply from the store. */
  reply: longText(500).default(""),
});

export const deleteReviewInput = z.object({ reviewId: docId });

/* ───────── Customers ───────── */

export const setCustomerDisabledInput = z.object({ uid: docId, disabled: z.boolean(), reason: optionalText(300) });

/* ───────── Website content ───────── */

/** Internal path ("/shop") or a full https:// link; never javascript: or data:. */
export const safeLink = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .max(300)
      .refine((s) => {
        if (s === "") return true;
        if (/^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]*$/.test(s)) return true;
        try {
          return new URL(s).protocol === "https:";
        } catch {
          return false;
        }
      }, "Use a page like /shop or a full https:// link"),
  );

export const saveBannerInput = z.object({
  id: docId.optional(),
  title: text(1, 80),
  subtitle: optionalText(160),
  linkUrl: safeLink.default(""),
  linkLabel: optionalText(30),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

export const saveFaqInput = z.object({
  id: docId.optional(),
  question: text(5, 200),
  answer: longText(1500).pipe(z.string().min(2, "Required")),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

/** Pages are written by the owner: About, Contact, Shipping, Returns, Privacy, Terms … */
export const savePageInput = z.object({
  slug,
  title: text(1, 80),
  body: longText(8000).pipe(z.string().min(1, "Required")),
  seoTitle: optionalText(70),
  seoDescription: optionalText(160),
  isPublished: z.boolean().default(false),
});

export const deletePageInput = z.object({ slug });

/** Which sections the home page shows. Featured products must be published ones. */
export const saveHomeInput = z.object({
  showBanners: z.boolean().default(true),
  showCategories: z.boolean().default(true),
  showFeatured: z.boolean().default(true),
  showNewArrivals: z.boolean().default(true),
  featuredProductIds: z.array(docId).max(12).default([]),
  introTitle: optionalText(80),
  introText: longText(400).default(""),
});

export const deleteContentInput = z.object({ kind: z.enum(["banner", "faq"]), id: docId });

/* ───────── Reports ───────── */

export const reportRangeInput = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.to >= r.from, { message: "End date must be after the start date", path: ["to"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 366 * 86400000, { message: "Choose at most one year", path: ["to"] });
