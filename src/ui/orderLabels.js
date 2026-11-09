/** Words for order and payment status, for staff and for customers. */
export const STATUS_LABEL = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  dispatched: "Dispatched",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned",
  refunded: "Refunded",
};

/** What a customer should understand from each status. */
export const CUSTOMER_STATUS_TEXT = {
  pending: "We've received your order and will confirm it shortly.",
  confirmed: "Your order is confirmed.",
  processing: "We're preparing your order.",
  dispatched: "Your order is on its way.",
  delivered: "Delivered. Thank you!",
  cancelled: "This order was cancelled.",
  returned: "This order was returned.",
  refunded: "This order was refunded.",
};

export const PAYMENT_LABEL = {
  pending: "Payment due on delivery",
  collected: "Paid (cash collected)",
  paid: "Paid",
  failed: "Payment failed",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  void: "Cancelled — nothing to pay",
};

export const METHOD_LABEL = { cod: "Cash on Delivery" };
