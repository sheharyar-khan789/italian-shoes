/**
 * Append-only activity log of sensitive staff actions. Changes are passed through redact(), so
 * passwords, tokens and keys can never end up here.
 */
import { db, FieldValue } from "./admin.js";
import { redact } from "./logger.js";

/**
 * @param {{ actorUid: string | null, action: string, entityType: string, entityId: string, changes?: Record<string, unknown> }} entry
 * @param {FirebaseFirestore.Transaction} [tx] write inside an existing transaction
 */
export function writeAudit({ actorUid, action, entityType, entityId, changes = {} }, tx) {
  const ref = db.collection("auditLogs").doc();
  const data = { actorUid: actorUid ?? "system", action, entityType, entityId, changes: redact(changes), at: FieldValue.serverTimestamp() };
  if (tx) tx.create(ref, data);
  else return ref.create(data);
}
