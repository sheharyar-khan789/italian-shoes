/**
 * Payment and delivery functions for the admin. Each checks a permission on the server.
 */
import { secureCallable } from "../lib/callable.js";
import { recordCollectionInput, recordRefundInput, setPaymentMethodInput, saveShippingMethodInput, saveShippingRateInput, deleteShippingInput } from "../shared/schemas/index.js";
import * as payments from "../services/payments.js";
import * as shipping from "../services/shipping.js";

const PAY = { auth: /** @type {const} */ ("required"), permission: "payments.update", rateLimit: { limit: 120, windowSeconds: 600 } };

export const recordCollection = secureCallable("recordCollection", { ...PAY, schema: recordCollectionInput }, ({ data, uid }) => payments.recordCollection(data, uid));
export const recordRefund = secureCallable("recordRefund", { ...PAY, rateLimit: { limit: 30, windowSeconds: 600 }, schema: recordRefundInput }, ({ data, uid }) => payments.recordRefund(data, uid));
export const setPaymentMethod = secureCallable(
  "setPaymentMethod",
  { auth: "required", permission: "settings.manage", schema: setPaymentMethodInput, rateLimit: { limit: 30, windowSeconds: 600 } },
  ({ data, uid }) => payments.setPaymentMethod(data, uid),
);

const SHIP = { auth: /** @type {const} */ ("required"), permission: "shipping.manage", rateLimit: { limit: 240, windowSeconds: 600 } };

export const saveShippingMethod = secureCallable("saveShippingMethod", { ...SHIP, schema: saveShippingMethodInput }, ({ data, uid }) => shipping.saveMethod(data, uid));
export const saveShippingRate = secureCallable("saveShippingRate", { ...SHIP, schema: saveShippingRateInput }, ({ data, uid }) => shipping.saveRate(data, uid));
export const deleteShippingItem = secureCallable("deleteShippingItem", { ...SHIP, schema: deleteShippingInput }, ({ data, uid }) => shipping.deleteShipping(data.kind, data.id, uid));
