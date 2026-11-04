import { AppError } from "./errors.js";
import { fieldErrors } from "../shared/schemas/index.js";

/**
 * Validate request data with a shared Zod schema. Throws a customer-safe AppError listing
 * the fields that need fixing; returns the cleaned, typed data otherwise.
 * @template {import("zod").ZodType} S
 * @param {S} schema
 * @param {unknown} data
 * @returns {import("zod").infer<S>}
 */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError("invalid-argument", "Please check the highlighted fields.", { fields: fieldErrors(result.error) });
  }
  return result.data;
}
