import { z } from "zod";
import { normalizePkMobile } from "../phone.js";

/** Firestore document id: 1–128 chars, no "/", not "." or "..". */
export const docId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !s.includes("/") && s !== "." && s !== "..", "Invalid id");

export const slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, numbers and single hyphens");

/** Whole paisa, non-negative, within JavaScript's safe integer range. */
export const paisa = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Positive paisa (a selling price cannot be zero). */
export const pricePaisa = paisa.refine((n) => n > 0, "Price must be greater than zero");

/** Trimmed single-line text with collapsed whitespace. */
export const text = (min, max) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(min, min <= 1 ? "Required" : `At least ${min} characters`).max(max, `At most ${max} characters`));

/** Multi-line text: trimmed, inner line breaks kept. */
export const longText = (max) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n/g, "\n").trim())
    .pipe(z.string().max(max, `At most ${max} characters`));

export const optionalText = (max) => text(0, max).optional().default("");

/** Pakistani mobile, normalised to "+92 3XX XXXXXXX". */
export const pkMobile = z
  .string()
  .transform((v, ctx) => {
    const n = normalizePkMobile(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a Pakistani mobile number, e.g. 0300 1234567" });
      return z.NEVER;
    }
    return n;
  });

export const email = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"));

/** Hex colour like #1a2b3c. */
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1a2b3c");
