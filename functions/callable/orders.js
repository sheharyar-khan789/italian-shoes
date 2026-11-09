/**
 * Order functions. Customers: quoteCheckout, placeOrder, cancelMyOrder (signed in).
 * Staff: updateOrderStatus, addOrderNote, addShipment, exportOrders (permission-checked).
 */
import { secureCallable } from "../lib/callable.js";
import { placeOrderSchema, quoteInput, updateOrderStatusInput, cancelMyOrderInput, addOrderNoteInput, addShipmentInput, exportOrdersInput } from "../shared/schemas/index.js";
import * as orders from "../services/orders.js";

export const quoteCheckout = secureCallable("quoteCheckout", { auth: "required", schema: quoteInput, rateLimit: { limit: 60, windowSeconds: 600 } }, ({ data, uid }) => orders.quote(data, uid));

export const placeOrder = secureCallable(
  "placeOrder",
  { auth: "required", schema: placeOrderSchema, rateLimit: { limit: 10, windowSeconds: 600 } },
  ({ data, uid, token }) => orders.placeOrder(data, { uid, email: token.email }),
);

export const cancelMyOrder = secureCallable(
  "cancelMyOrder",
  { auth: "required", schema: cancelMyOrderInput, rateLimit: { limit: 10, windowSeconds: 600 } },
  ({ data, uid }) => orders.updateOrderStatus({ orderId: data.orderId, status: "cancelled", note: data.reason ? `Cancelled by customer: ${data.reason}` : "Cancelled by customer" }, { actorUid: uid, ownerUid: uid }),
);

const STAFF = { auth: /** @type {const} */ ("required"), rateLimit: { limit: 240, windowSeconds: 600 } };

export const updateOrderStatus = secureCallable("updateOrderStatus", { ...STAFF, permission: "orders.update", schema: updateOrderStatusInput }, ({ data, uid }) =>
  orders.updateOrderStatus(data, { actorUid: uid }),
);
export const addOrderNote = secureCallable("addOrderNote", { ...STAFF, permission: "orders.update", schema: addOrderNoteInput }, ({ data, uid }) => orders.addOrderNote(data, uid));
export const addShipment = secureCallable("addShipment", { ...STAFF, permission: "orders.update", schema: addShipmentInput }, ({ data, uid }) => orders.addShipment(data, uid));
export const exportOrders = secureCallable("exportOrders", { auth: "required", permission: "orders.export", schema: exportOrdersInput, rateLimit: { limit: 20, windowSeconds: 600 } }, ({ data, uid }) =>
  orders.exportOrders(data, uid),
);
