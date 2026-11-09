/**
 * Coupon management for the admin. Applying a coupon happens inside quoteCheckout / placeOrder.
 */
import { secureCallable } from "../lib/callable.js";
import { saveCouponInput, deleteCouponInput } from "../shared/schemas/index.js";
import * as coupons from "../services/coupons.js";

const OPTS = { auth: /** @type {const} */ ("required"), permission: "coupons.manage", rateLimit: { limit: 120, windowSeconds: 600 } };

export const saveCoupon = secureCallable("saveCoupon", { ...OPTS, schema: saveCouponInput }, ({ data, uid }) => coupons.saveCoupon(data, uid));
export const deleteCoupon = secureCallable("deleteCoupon", { ...OPTS, schema: deleteCouponInput }, ({ data, uid }) => coupons.deleteCoupon(data.code, uid));
