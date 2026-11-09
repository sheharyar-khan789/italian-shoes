import { z } from "zod";
import { text, email, pkMobile, docId } from "./common.js";
import { addressSchema } from "./checkout.js";
import { DEFAULT_ROLES } from "../permissions.js";

/**
 * Password rules. Firebase hashes and stores passwords; these rules only decide what is accepted.
 * Also set a matching password policy in the Firebase console (SECURITY.md).
 */
export const PASSWORD_MIN = 10;
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(128, "Use at most 128 characters")
  .refine((p) => /\p{L}/u.test(p) && /\d/.test(p), "Use letters and at least one number")
  .refine((p) => new Set(p).size >= 4, "Choose a less predictable password");

const personName = text(3, 80).refine((s) => /\p{L}/u.test(s), "Please enter your full name");

export const signUpSchema = z.object({
  name: personName,
  email,
  phone: pkMobile.optional(),
  password: passwordSchema,
});

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password").max(128),
});

/** Fields a customer may change on their own profile document. */
export const profileSchema = z.object({
  name: personName,
  phone: pkMobile.or(z.literal("")).default(""),
});

export const savedAddressSchema = addressSchema;

export const ROLE_KEYS = /** @type {[string, ...string[]]} */ (Object.keys(DEFAULT_ROLES));

/** Owner-only: set the full list of roles for a staff member (empty list removes staff access). */
export const setStaffRolesSchema = z
  .object({
    uid: docId.optional(),
    email: email.optional(),
    roles: z.array(z.enum(ROLE_KEYS)).max(ROLE_KEYS.length),
  })
  .refine((v) => Boolean(v.uid) !== Boolean(v.email), { message: "Give either uid or email", path: ["uid"] });
