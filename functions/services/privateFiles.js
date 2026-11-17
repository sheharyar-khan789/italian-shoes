/**
 * Private files (receipts, supplier papers, employee CNIC/documents and photos): who may read them.
 * The files sit in a PRIVATE Vercel Blob store; this module decides, for one request, whether the
 * signed-in person may open one path, and fetches it. Used by api/privateFile.js.
 */
import { get } from "@vercel/blob";
import { auth as adminAuth, db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { hasPermission, assertSessionStillValid } from "../lib/callable.js";
import { consumeRateLimit } from "../lib/rateLimit.js";
import { PRIVATE_FILE_KINDS, privateFileKind } from "../shared/privateFiles.js";

/** Network access, replaceable in tests. @param {string} path */
export const privateBlobIO = {
  get: (path) => get(path, { access: "private", token: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN }),
};

/**
 * Throws unless this request may read `path`. Returns the kind of file.
 * @param {{ path: unknown, authorization?: string }} input
 * @param {{ verifyToken?: (t: string) => Promise<Record<string, any>> }} [deps]
 */
export async function authorizePrivateRead({ path, authorization }, { verifyToken = (t) => adminAuth.verifyIdToken(t) } = {}) {
  const bearer = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
  if (!bearer) throw new AppError("unauthenticated", "Please sign in to continue.");
  /** @type {Record<string, any>} */
  let token;
  try {
    token = await verifyToken(bearer);
  } catch {
    throw new AppError("unauthenticated", "Your session has expired. Please sign in again.");
  }
  const kind = privateFileKind(path);
  if (!kind) throw new AppError("not-found", "That file doesn't exist.");
  if (token.staff !== true) throw new AppError("permission-denied", "You don't have permission to do this.");
  await assertSessionStillValid(token.uid, token);
  await consumeRateLimit("privateFile", token.uid, { limit: 300, windowSeconds: 600 });

  let allowed = PRIVATE_FILE_KINDS[kind].some((p) => hasPermission(token, p));
  if (!allowed && kind === "hrphoto") {
    // Everyone may see their OWN photo (the employee record linked to their sign-in).
    const mine = await db.collection("employees").where("photoUrl", "==", path).limit(1).get();
    allowed = !mine.empty && mine.docs[0].data().staffUid === token.uid;
  }
  if (!allowed) throw new AppError("permission-denied", "You don't have permission to do this.");
  // Opening someone's CNIC or contract leaves a trace.
  if (kind === "hr") await writeAudit({ actorUid: token.uid, action: "file.viewed", entityType: "privateFile", entityId: String(path), changes: { kind } });
  return kind;
}

/** @param {string} path */
export async function readPrivateFile(path) {
  if (!process.env.BLOB_PRIVATE_READ_WRITE_TOKEN) throw new AppError("unavailable", "Private file storage isn't connected yet. The owner must connect the private Blob store (docs/OPERATIONS.md).");
  const result = await privateBlobIO.get(path);
  if (!result || result.statusCode !== 200) throw new AppError("not-found", "That file doesn't exist.");
  return result;
}
