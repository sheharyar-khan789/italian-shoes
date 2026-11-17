/**
 * Analytics and reporting endpoints. The executive dashboard needs `analytics.executive` (Owner only). A report needs ALL of the permissions
 * listed for it in shared/analytics.js (checked here on the server, from the verified token), so a person can never read figures their role
 * doesn't allow. Financial, profit, customer and executive reports and every export are written to the audit log.
 *
 *   analytics.read / .financial / .executive   what you may view          analytics.export   download / print          analytics.manage   saved reports and schedules
 */
import { secureCallable, hasPermission } from "../lib/callable.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { analyticsReportInput, analyticsExecutiveInput, analyticsExportInput, saveReportConfigInput, reportConfigIdInput, analyticsEmptyInput, saveScheduleInput, scheduleActiveInput, reportInboxInput, reportRunIdInput } from "../shared/schemas/index.js";
import { ANALYTICS_REPORTS, canRunReport } from "../shared/analytics.js";
import * as analytics from "../services/analytics.js";
import * as schedules from "../services/analyticsSchedules.js";

/** @param {{ uid: string | null, token: Record<string, any> | null }} ctx */
const actorOf = ({ uid, token }) => ({ uid: /** @type {string} */ (uid), name: String(token?.name ?? token?.email ?? uid) });
const permsOf = (ctx) => (Array.isArray(ctx.token?.perms) ? /** @type {string[]} */ (ctx.token.perms) : []);
const A = (permission, limit = 120) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });
const SENSITIVE = /^(fin_|profit_|customer_)/;

export const analyticsExecutive = secureCallable("analyticsExecutive", { ...A("analytics.executive", 60), schema: analyticsExecutiveInput }, async (ctx) => {
  const r = await analytics.analyticsExecutive(ctx.data);
  await writeAudit({ actorUid: ctx.uid, action: "analytics.executive_viewed", entityType: "analytics", entityId: "executive", changes: { from: ctx.data.from, to: ctx.data.to } });
  return r;
});

export const analyticsReport = secureCallable("analyticsReport", { auth: "required", rateLimit: { limit: 90, windowSeconds: 600 }, schema: analyticsReportInput }, async (ctx) => {
  const r = await analytics.analyticsReport(ctx.data, permsOf(ctx));
  if (SENSITIVE.test(ctx.data.report)) await writeAudit({ actorUid: ctx.uid, action: "analytics.report_run", entityType: "analytics", entityId: ctx.data.report, changes: { from: ctx.data.from, to: ctx.data.to } });
  return r;
});

/** Called just before a file is produced in the browser: re-checks permissions and records who exported what. */
export const analyticsExport = secureCallable("analyticsExport", { auth: "required", rateLimit: { limit: 60, windowSeconds: 600 }, schema: analyticsExportInput }, async (ctx) => {
  const perms = permsOf(ctx);
  if (!perms.includes("analytics.export") && !hasPermission(ctx.token, "analytics.export")) throw new AppError("permission-denied", "You don't have permission to export reports.");
  const ok = ctx.data.report === "executive" ? perms.includes("analytics.executive") : canRunReport(ctx.data.report, perms);
  if (!ok) throw new AppError("permission-denied", "You don't have permission to export this report.");
  await writeAudit({ actorUid: ctx.uid, action: "analytics.exported", entityType: "analytics", entityId: ctx.data.report, changes: { format: ctx.data.format, from: ctx.data.from, to: ctx.data.to } });
  return { ok: true, title: ANALYTICS_REPORTS[ctx.data.report]?.label ?? "Executive dashboard" };
});

export const saveReportConfig = secureCallable("saveReportConfig", { ...A("analytics.manage", 60), schema: saveReportConfigInput }, (ctx) => schedules.saveConfig(ctx.data, actorOf(ctx), permsOf(ctx)));
export const listReportConfigs = secureCallable("listReportConfigs", { auth: "required", rateLimit: { limit: 120, windowSeconds: 600 }, schema: analyticsEmptyInput }, (ctx) => schedules.listConfigs(actorOf(ctx), permsOf(ctx)));
export const deleteReportConfig = secureCallable("deleteReportConfig", { ...A("analytics.manage", 60), schema: reportConfigIdInput }, (ctx) => schedules.deleteConfig(ctx.data, actorOf(ctx)));

export const saveReportSchedule = secureCallable("saveReportSchedule", { ...A("analytics.manage", 30), schema: saveScheduleInput }, (ctx) => schedules.saveSchedule(ctx.data, actorOf(ctx), permsOf(ctx)));
export const setReportScheduleActive = secureCallable("setReportScheduleActive", { ...A("analytics.manage", 30), schema: scheduleActiveInput }, (ctx) => schedules.setScheduleActive(ctx.data, actorOf(ctx)));
export const listReportSchedules = secureCallable("listReportSchedules", { ...A("analytics.manage", 60), schema: analyticsEmptyInput }, () => schedules.listSchedules());
export const runScheduledReports = secureCallable("runScheduledReports", { ...A("analytics.manage", 12), schema: analyticsEmptyInput }, () => schedules.runDueSchedules());
/** Opening the inbox also generates any summary that has become due (each period at most once). */
export const reportInbox = secureCallable("reportInbox", { auth: "required", rateLimit: { limit: 120, windowSeconds: 600 }, schema: reportInboxInput }, async (ctx) => {
  await schedules.runDueSchedules().catch(() => null);
  return schedules.reportInbox(ctx.data, actorOf(ctx), permsOf(ctx));
});
export const reportRun = secureCallable("reportRun", { auth: "required", rateLimit: { limit: 120, windowSeconds: 600 }, schema: reportRunIdInput }, (ctx) => schedules.reportRun(ctx.data, actorOf(ctx), permsOf(ctx)));
