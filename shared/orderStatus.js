/**
 * Order and payment lifecycles. The order service in Cloud Functions refuses any change
 * that is not listed here; the admin UI uses the same map to show only valid actions.
 */

export const ORDER_STATUSES = /** @type {const} */ ([
  "pending",
  "confirmed",
  "processing",
  "dispatched",
  "delivered",
  "cancelled",
  "returned",
  "refunded",
]);

/** @typedef {typeof ORDER_STATUSES[number]} OrderStatus */

/** @type {Record<OrderStatus, OrderStatus[]>} */
export const ORDER_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["dispatched", "cancelled"],
  // A dispatched parcel can come back undelivered (refused / not found) → returned.
  dispatched: ["delivered", "returned"],
  delivered: ["returned"],
  returned: ["refunded"],
  // Only reachable when something was actually paid; the payment service checks that.
  cancelled: ["refunded"],
  refunded: [],
};

/** Statuses in which the order's stock should be put back on the shelf when entered. */
export const RESTOCK_ON_ENTER = /** @type {OrderStatus[]} */ (["cancelled", "returned"]);

/** @param {string} from @param {string} to */
export const canTransition = (from, to) => Boolean(ORDER_TRANSITIONS[from]?.includes(to));

/** Customers may cancel their own order only before the store has started working on it. */
export const customerCanCancel = (status) => status === "pending";

export const PAYMENT_STATUSES = /** @type {const} */ ([
  "pending", // COD: not yet collected. Online: awaiting gateway confirmation.
  "collected", // COD cash received by the store
  "paid", // online payment verified server-side with the gateway
  "failed",
  "partially_refunded",
  "refunded",
]);

/** @type {Record<string, string[]>} */
export const PAYMENT_TRANSITIONS = {
  pending: ["collected", "paid", "failed"],
  collected: ["partially_refunded", "refunded"],
  paid: ["partially_refunded", "refunded"],
  failed: ["pending"],
  partially_refunded: ["partially_refunded", "refunded"],
  refunded: [],
};

/** @param {string} from @param {string} to */
export const canTransitionPayment = (from, to) => Boolean(PAYMENT_TRANSITIONS[from]?.includes(to));
