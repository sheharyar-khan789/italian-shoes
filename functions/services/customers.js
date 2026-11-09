/**
 * Customers. Profiles live in users/{uid} (readable by customers.read staff, no secrets: passwords
 * are held by Firebase Auth only). Staff can suspend an account; the customer is signed out
 * everywhere and cannot sign in until it is re-enabled. Staff accounts can't be suspended here.
 */
import { db, auth, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

/** @param {{ uid: string, disabled: boolean, reason: string }} input @param {string} actorUid */
export async function setCustomerDisabled({ uid, disabled, reason }, actorUid) {
  if (uid === actorUid) throw new AppError("failed-precondition", "You can't suspend your own account.");
  let user;
  try {
    user = await auth.getUser(uid);
  } catch {
    throw new AppError("not-found", "That customer no longer exists.");
  }
  if (user.customClaims?.staff) throw new AppError("failed-precondition", "That account is staff. Remove their staff access first.");

  await auth.updateUser(uid, { disabled });
  if (disabled) await auth.revokeRefreshTokens(uid);
  await db.doc(`users/${uid}`).set({ disabled, disabledReason: disabled ? reason : "", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await writeAudit({ actorUid, action: disabled ? "customer.suspended" : "customer.enabled", entityType: "customer", entityId: uid, changes: { reason } });
  return { uid, disabled };
}
