/**
 * Sensitive files (expense receipts and supplier papers, employee CNIC scans and documents, employee photos)
 * live in a PRIVATE Vercel Blob store. Records keep only the file's path, e.g. "hr/<uid>/cnic-AbC123.png",
 * never a link. Nobody can open a path directly: the browser asks /api/privateFile, which checks the
 * signed-in person's live session and permission and then streams the file.
 */

/** Where each kind of file lives, and the permissions that may read it (any one of them). */
export const PRIVATE_FILE_KINDS = {
  receipts: ["finance.read", "finance.write", "accounting.read", "purchases.read", "purchases.manage", "suppliers.manage"],
  hr: ["hr.sensitive"],
  hrphoto: ["hr.read", "hr.write"],
};

export const PRIVATE_FILE_RE = /^(receipts|hr|hrphoto)\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,200}$/;

/** @param {unknown} path @returns {"receipts" | "hr" | "hrphoto" | null} */
export function privateFileKind(path) {
  if (typeof path !== "string" || !PRIVATE_FILE_RE.test(path) || path.includes("..")) return null;
  return /** @type {"receipts" | "hr" | "hrphoto"} */ (path.split("/")[0]);
}

/** True when `path` is a well-formed private file path of one of the given kinds. @param {unknown} path @param {...string} kinds */
export function isPrivateFileRef(path, ...kinds) {
  const kind = privateFileKind(path);
  return kind !== null && kinds.includes(kind);
}
