/**
 * Staff access. The ONLY code that grants or removes admin access.
 *
 * A staff member's roles are stored in `staff/{uid}` and mirrored into their Firebase Auth custom
 * claims as { staff: true, roles: [...], perms: [...] }. Security rules and secureCallable read the
 * claims; nothing a browser sends can set them.
 */
import { db, auth, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { effectivePermissions } from "../shared/permissions.js";

const STAFF_CLAIMS = ["staff", "roles", "perms"];

/** Roles as stored in Firestore (seeded by migration 001, editable by the Owner). */
export async function loadRoles() {
  const snap = await db.collection("roles").get();
  if (snap.empty) throw new AppError("failed-precondition", "Staff roles are not set up yet. Run the database migrations first.");
  return Object.fromEntries(snap.docs.map((d) => [d.id, /** @type {{permissions: string[]}} */ (d.data())]));
}

/** @param {{ uid?: string, email?: string }} who */
export async function findUser({ uid, email }) {
  try {
    return uid ? await auth.getUser(uid) : await auth.getUserByEmail(/** @type {string} */ (email));
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === "auth/user-not-found") {
      throw new AppError("not-found", "No account exists for that person yet. Ask them to create an account on the website first.");
    }
    throw error;
  }
}

/**
 * Replace a person's staff roles. An empty list removes staff access entirely.
 * Removing any permission signs that person out everywhere, so it takes effect immediately.
 *
 * @param {{ uid?: string, email?: string, roles: string[], actorUid: string | null }} input
 * @returns {Promise<{ uid: string, roles: string[], perms: string[] }>}
 */
export async function setStaffRoles({ uid, email, roles, actorUid }) {
  const user = await findUser({ uid, email });
  const allRoles = await loadRoles();
  for (const r of roles) if (!(r in allRoles)) throw new AppError("invalid-argument", `Unknown role "${r}".`);

  const uniqueRoles = [...new Set(roles)].sort();
  const perms = effectivePermissions(uniqueRoles, allRoles);
  const staffRef = db.collection("staff").doc(user.uid);
  const ownerLock = db.collection("system").doc("owner");

  const previous = await db.runTransaction(async (tx) => {
    const current = await tx.get(staffRef);
    const before = current.exists ? /** @type {string[]} */ (current.data().roles ?? []) : [];

    // The store must always keep at least one Owner.
    if (before.includes("owner") && !uniqueRoles.includes("owner")) {
      const owners = await tx.get(db.collection("staff").where("roles", "array-contains", "owner").where("status", "==", "active"));
      if (owners.docs.filter((d) => d.id !== user.uid).length === 0) {
        throw new AppError("failed-precondition", "The store must keep at least one Owner. Make someone else an Owner first.");
      }
    }

    if (uniqueRoles.length === 0) {
      if (current.exists) tx.update(staffRef, { roles: [], status: "removed", updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    } else {
      tx.set(
        staffRef,
        {
          email: user.email ?? null,
          name: user.displayName ?? null,
          roles: uniqueRoles,
          status: "active",
          ...(current.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actorUid,
        },
        { merge: true },
      );
    }
    if (uniqueRoles.includes("owner")) tx.set(ownerLock, { claimed: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    writeAudit({ actorUid, action: "staff.roles_set", entityType: "staff", entityId: user.uid, changes: { before, after: uniqueRoles } }, tx);
    notify(
      {
        type: "staff.changed",
        audience: "staff.manage",
        title: uniqueRoles.length ? `${user.email ?? "A staff member"} now has: ${uniqueRoles.join(", ")}` : `${user.email ?? "A staff member"} no longer has staff access`,
        link: "/admin/activity",
        data: { uid: user.uid, before, after: uniqueRoles },
      },
      tx,
    );
    return before;
  });

  // Claims: keep any unrelated claims, replace the staff ones.
  const others = Object.fromEntries(Object.entries(user.customClaims ?? {}).filter(([k]) => !STAFF_CLAIMS.includes(k)));
  await auth.setCustomUserClaims(user.uid, uniqueRoles.length ? { ...others, staff: true, roles: uniqueRoles, perms } : others);

  const lostPermission = effectivePermissions(previous, allRoles).some((p) => !perms.includes(p));
  if (lostPermission) await auth.revokeRefreshTokens(user.uid);

  return { uid: user.uid, roles: uniqueRoles, perms };
}

/**
 * First-time setup: the person whose verified email matches OWNER_EMAIL (set in the Functions
 * environment by whoever deploys) may claim the Owner role — once, and only while the store has
 * no Owner. After that, Owners are added only by an existing Owner.
 *
 * @param {{ uid: string, email?: string, emailVerified?: boolean, ownerEmail?: string }} input
 */
export async function claimOwner({ uid, email, emailVerified, ownerEmail = process.env.OWNER_EMAIL }) {
  const expected = (ownerEmail ?? "").trim().toLowerCase();
  if (!expected) throw new AppError("failed-precondition", "Owner setup isn't configured on the server yet (OWNER_EMAIL is not set).");
  if (!email || email.toLowerCase() !== expected) throw new AppError("permission-denied", "This account isn't the one set up as the store owner.");
  if (!emailVerified) throw new AppError("failed-precondition", "Please verify your email address first — check your inbox for the verification link.");

  const lock = db.collection("system").doc("owner");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lock);
    if (snap.exists && snap.data().claimed) throw new AppError("already-exists", "This store already has an Owner. Ask them to give you access.");
    tx.set(lock, { claimed: true, claimedBy: uid, claimedAt: FieldValue.serverTimestamp() });
  });

  try {
    return await setStaffRoles({ uid, roles: ["owner"], actorUid: uid });
  } catch (error) {
    // Don't leave the store locked without an Owner if granting failed.
    await lock.delete();
    throw error;
  }
}
