/**
 * Hands out one-time photo-upload tokens (Vercel Blob client uploads), to signed-in staff only.
 * The browser then uploads the file straight to Blob; /api/addProductImage checks and processes it.
 */
import process from "node:process";
import { handleUpload } from "@vercel/blob/client";
import { authorizeBlobUpload } from "../functions/services/images.js";
import { toApiError } from "../functions/lib/errors.js";

export const config = { maxDuration: 30 };

/** @param {any} req @param {any} res */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).setHeader("Allow", "POST").json({ error: { code: "invalid-argument", message: "Method not allowed." } });
  // Receipts, employee documents and employee photos go to the PRIVATE store; product photos to the public one.
  const wanted = String(req.body?.payload?.pathname ?? "");
  const isPrivate = /^(receipts|hr|hrphoto)\//.test(wanted);
  const storeToken = isPrivate ? process.env.BLOB_PRIVATE_READ_WRITE_TOKEN : process.env.BLOB_READ_WRITE_TOKEN;
  // Without the Blob store connected there is no token; say so plainly instead of a vague server error.
  if (!storeToken) {
    if (isPrivate) return res.status(503).json({ error: { code: "unavailable", message: "Private file storage isn't connected yet. The owner must connect a private Vercel Blob store (docs/OPERATIONS.md)." } });
    return res.status(503).json({ error: { code: "unavailable", message: "Photo storage isn't connected yet. The owner must connect a Vercel Blob store to the project (docs/VERCEL-SETUP.md, step 3)." } });
  }
  try {
    const out = await handleUpload({
      body: req.body,
      request: req,
      token: storeToken,
      onBeforeGenerateToken: (pathname) => authorizeBlobUpload({ pathname, authorization: req.headers.authorization }),
    });
    return res.status(200).json(out);
  } catch (error) {
    const { status, body } = toApiError(error, "blobUpload");
    return res.status(status).json(body);
  }
}
