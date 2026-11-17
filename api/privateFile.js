/**
 * Streams ONE private file (receipt, supplier paper, employee document or photo) to a signed-in person who
 * may see it. GET /api/privateFile?path=hr/<uid>/<file>, with the Firebase ID token in the Authorization header.
 * The browser fetches it and shows it from a temporary local link; the file itself has no public address.
 */
import { Readable } from "node:stream";
import { authorizePrivateRead, readPrivateFile } from "../functions/services/privateFiles.js";
import { toApiError } from "../functions/lib/errors.js";

export const config = { maxDuration: 30 };

const SAFE_TYPES = /^(image\/(jpeg|png|webp)|application\/pdf)$/;

/** @param {any} req @param {any} res */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).setHeader("Allow", "GET").json({ error: { code: "invalid-argument", message: "Method not allowed." } });
  try {
    const path = typeof req.query?.path === "string" ? req.query.path : "";
    await authorizePrivateRead({ path, authorization: req.headers.authorization });
    const file = await readPrivateFile(path);
    const type = String(file.blob.contentType ?? "").toLowerCase();
    // Only the types the uploader accepts are served as themselves; anything else is a download, never rendered.
    res.setHeader("Content-Type", SAFE_TYPES.test(type) ? type : "application/octet-stream");
    res.setHeader("Content-Disposition", SAFE_TYPES.test(type) ? "inline" : "attachment");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.status(200);
    Readable.fromWeb(/** @type {any} */ (file.stream)).pipe(res);
  } catch (error) {
    const { status, body } = toApiError(error, "privateFile");
    return res.status(status).json(body);
  }
}
