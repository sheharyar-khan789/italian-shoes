/**
 * Daily scheduled run (see vercel.json "crons"). Vercel calls it with `Authorization: Bearer <CRON_SECRET>`;
 * anyone else is refused. Without CRON_SECRET configured it does nothing at all.
 */
import process from "node:process";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { runCronJobs } from "../functions/services/cron.js";

export const config = { maxDuration: 60 };

/** @param {string} a @param {string} b */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** @param {any} req @param {any} res */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return res.status(503).json({ error: { code: "unavailable", message: "The scheduled run isn't set up: set CRON_SECRET (at least 16 characters) in Vercel." } });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).setHeader("Allow", "GET, POST").json({ error: { code: "invalid-argument", message: "Method not allowed." } });
  const given = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
  if (!same(given, secret)) return res.status(401).json({ error: { code: "unauthenticated", message: "Not allowed." } });
  const out = await runCronJobs();
  return res.status(out.ok ? 200 : 500).json(out);
}
