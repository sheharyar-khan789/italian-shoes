/**
 * Vercel serverless entry for every server endpoint: POST /api/<name> with a Firebase ID token
 * (vercel.json rewrites /api/<name> to /api/call?fn=<name>).
 * One file on purpose (free Vercel plans limit how many separate functions a project may have).
 * All the logic lives in functions/ (handler.js → lib/callable.js → services/).
 */
import { handleApi } from "../functions/handler.js";

export const config = { maxDuration: 30 };

/** @param {any} req @param {any} res */
export default async function handler(req, res) {
  const name = String(req.query?.fn ?? "");
  const { status, body, headers } = await handleApi({ method: req.method ?? "GET", name, headers: req.headers ?? {}, body: req.body });
  for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
  res.status(status).json(body);
}
