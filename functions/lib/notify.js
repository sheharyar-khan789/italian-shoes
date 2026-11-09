/**
 * Admin notifications. Each notification targets the staff who hold one permission ("audience"),
 * so for example low-stock alerts reach inventory staff and staff changes reach the Owner.
 * Security rules let staff read only notifications for permissions they hold.
 */
import { db, FieldValue } from "./admin.js";

export const NOTIFICATION_TYPES = /** @type {const} */ ([
  "order.new",
  "order.status",
  "order.cancelled",
  "payment.status",
  "refund",
  "stock.low",
  "stock.out",
  "staff.changed",
  "settings.changed",
  "review.new",
]);

/**
 * @param {{ type: typeof NOTIFICATION_TYPES[number], audience: string, title: string, body?: string, link?: string, data?: Record<string, unknown> }} n
 * @param {FirebaseFirestore.Transaction} [tx]
 */
export function notify({ type, audience, title, body = "", link = "", data = {} }, tx) {
  if (!NOTIFICATION_TYPES.includes(type)) throw new TypeError(`Unknown notification type ${type}`);
  const ref = db.collection("notifications").doc();
  const doc = { type, audience, title, body, link, data, readBy: [], createdAt: FieldValue.serverTimestamp() };
  if (tx) tx.create(ref, doc);
  else return ref.create(doc);
}
