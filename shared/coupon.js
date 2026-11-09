/**
 * Coupon rules, as pure code so the same logic is unit-tested and used by the server
 * (the browser never decides a discount; it only displays what the server returns).
 */
import { percentOf } from "./money.js";

/**
 * @typedef {{ productId: string, categoryId?: string | null, lineTotal: number }} CouponLine
 * @typedef {{
 *   code: string, type: "percent" | "fixed", value: number, minOrder: number, maxDiscount: number | null,
 *   startsAtMs: number | null, endsAtMs: number | null, usageLimit: number | null, perCustomerLimit: number | null,
 *   usedCount: number, productIds: string[], categoryIds: string[], isActive: boolean,
 * }} CouponRule
 */

/**
 * Work out the discount for a coupon, or say why it can't be used.
 * @param {CouponRule} coupon
 * @param {CouponLine[]} lines
 * @param {{ nowMs: number, customerUses: number }} ctx
 * @returns {{ ok: true, discount: number } | { ok: false, message: string }}
 */
export function evaluateCoupon(coupon, lines, { nowMs, customerUses }) {
  const no = (message) => ({ ok: /** @type {const} */ (false), message });
  if (!coupon.isActive) return no("This coupon isn't active.");
  if (coupon.startsAtMs != null && nowMs < coupon.startsAtMs) return no("This coupon isn't valid yet.");
  if (coupon.endsAtMs != null && nowMs > coupon.endsAtMs) return no("This coupon has expired.");
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) return no("This coupon has been fully used.");
  if (coupon.perCustomerLimit != null && customerUses >= coupon.perCustomerLimit) return no("You've already used this coupon the maximum number of times.");

  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  if (subtotal < coupon.minOrder) return no("Your order is below this coupon's minimum amount.");

  const restricted = coupon.productIds.length > 0 || coupon.categoryIds.length > 0;
  const eligible = restricted ? lines.filter((l) => coupon.productIds.includes(l.productId) || (l.categoryId != null && coupon.categoryIds.includes(l.categoryId))) : lines;
  const base = eligible.reduce((n, l) => n + l.lineTotal, 0);
  if (base <= 0) return no("This coupon doesn't apply to the items in your bag.");

  let discount = coupon.type === "percent" ? percentOf(base, coupon.value) : Math.min(coupon.value, base);
  if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, base);
  if (discount <= 0) return no("This coupon doesn't reduce this order.");
  return { ok: true, discount };
}
