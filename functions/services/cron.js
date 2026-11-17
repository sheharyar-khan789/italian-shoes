/**
 * The daily background run (Vercel Cron → api/cron.js). Three jobs, each already safe to run any number of times
 * because every record it creates has a deterministic id:
 *   recurringExpenses   creates the expense entries that have fallen due (large ones wait for an approver, as always)
 *   loyaltyExpiry       expires loyalty points whose time is up
 *   reportSchedules     generates the scheduled report summaries that are due
 * One failing job never stops the others, and the outcome is kept in system/cron for the admin to see.
 */
import { db, FieldValue } from "../lib/admin.js";
import { log } from "../lib/logger.js";
import { runRecurring } from "./finance.js";
import { expirePoints } from "./loyalty.js";
import { runDueSchedules } from "./analyticsSchedules.js";

/** The identity recorded on anything the schedule creates. */
export const CRON_ACTOR = { uid: "system:cron", name: "Scheduled job" };

export const DEFAULT_JOBS = {
  recurringExpenses: () => runRecurring(CRON_ACTOR, { canApprove: false }),
  loyaltyExpiry: () => expirePoints(),
  reportSchedules: () => runDueSchedules(),
};

/**
 * @param {{ jobs?: Record<string, () => Promise<any>> }} [opts]
 * @returns {Promise<{ ok: boolean, results: Record<string, { ok: boolean, summary?: any, error?: string }> }>}
 */
export async function runCronJobs({ jobs = DEFAULT_JOBS } = {}) {
  /** @type {Record<string, { ok: boolean, summary?: any, error?: string }>} */
  const results = {};
  for (const [name, job] of Object.entries(jobs)) {
    try {
      const summary = await job();
      results[name] = { ok: true, summary: JSON.parse(JSON.stringify(summary ?? null)) };
    } catch (error) {
      log.error("Scheduled job failed", { job: name, error });
      results[name] = { ok: false, error: String(/** @type {Error} */ (error)?.message ?? error).slice(0, 300) };
    }
  }
  const ok = Object.values(results).every((r) => r.ok);
  await db.doc("system/cron").set({ lastRunAt: FieldValue.serverTimestamp(), ok, results }).catch((error) => log.warn("Couldn't save the scheduled-run result", { error }));
  return { ok, results };
}
