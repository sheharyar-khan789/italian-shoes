/**
 * Hands out one-time photo-upload tokens (Vercel Blob client uploads), to signed-in staff only.
 * The browser then uploads the file straight to Blob; /api/addProductImage checks and processes it.
 */
import { handleUpload } from "@vercel/blob/client";
import { authorizeBlobUpload } from "../functions/services/images.js";
import { toApiError } from "../functions/lib/errors.js";

export const config = { maxDuration: 30 };

/** @param {any} req @param {any} res */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).setHeader("Allow", "POST").json({ error: { code: "invalid-argument", message: "Method not allowed." } });
  try {
    const out = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: (pathname) => authorizeBlobUpload({ pathname, authorization: req.headers.authorization }),
    });
    return res.status(200).json(out);
  } catch (error) {
    const { status, body } = toApiError(error, "blobUpload");
    return res.status(status).json(body);
  }
}
