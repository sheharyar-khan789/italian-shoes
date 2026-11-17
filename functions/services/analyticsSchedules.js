/**
 * Saved report configurations, scheduled report summaries and the report inbox.
 *
 * There is no timed background job in this project, and no messaging service is used. Scheduled summaries are therefore generated when
 * they are DUE and an authorised person opens the report inbox (or presses "Run due reports now"); each period is generated at most once
 * (the document id is schedule + period), and recipients read the result in their inbox inside the admin. Nothing is emailed or messaged.
 *
 *   reportConfigs/{id}   a saved report setup, private to its creator (relative period, filters)
 *   reportSchedules/{id} which summary, how often, who receives it
 *   reportRuns/{id}      one generated summary (id = scheduleId__periodKey), visible only to its recipients who still hold the report's permissions
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey } from "../shared/accounting.js";
import { addDays, rangeFor } from "../shared/finance.js";
import { SCHEDULE_REPORTS, canRunReport } from "../shared/analytics.js";
import { runInternal } from "./analytics.js";
import { inventoryAlerts } from "./inventoryInsights.js";
import { col, table } from "./analyticsData.js";

/** @typedef {{ uid: string, name: string }} Actor */
/** A document as a plain object with its id. @param {FirebaseFirestore.QueryDocumentSnapshot} d @returns {Record<string, any>} */
const row = (d) => ({ id: d.id, ...d.data() });
/** The same, without the server timestamps (they are not JSON). @param {FirebaseFirestore.QueryDocumentSnapshot} d @returns {Record<string, any>} */
const clean = (d) => {
  const r = row(d);
  delete r.createdAt;
  delete r.updatedAt;
  return r;
};

/* ───────── Saved configurations ───────── */

const PERIODS = { today: (t) => rangeFor("today", t), yesterday: (t) => rangeFor("yesterday", t), week: (t) => rangeFor("week", t), month: (t) => rangeFor("month", t), year: (t) => rangeFor("year", t), last30: (t) => ({ from: addDays(t, -29), to: t }), last90: (t) => ({ from: addDays(t, -89), to: t }) };

/** Turn a saved relative period into dates (and the matching comparison period). @param {string} period @param {boolean} compare @param {string} [today] */
export function resolvePeriod(period, compare, today = pktDateKey(new Date())) {
  const r = (PERIODS[period] ?? PERIODS.month)(today);
  if (!compare) return { ...r, compareFrom: "", compareTo: "" };
  const n = Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86400000) + 1;
  return { ...r, compareFrom: addDays(r.from, -n), compareTo: addDays(r.from, -1) };
}

/** @param {Record<string, any>} input validated saveReportConfigInput @param {Actor} actor @param {string[]} perms */
export async function saveConfig(input, actor, perms) {
  if (!canRunReport(input.report, perms)) throw new AppError("permission-denied", "You can't save a report you aren't allowed to run.");
  const { id, ...body } = input;
  const ref = id ? db.collection("reportConfigs").doc(id) : db.collection("reportConfigs").doc();
  if (id) {
    const snap = await ref.get();
    if (!snap.exists || snap.data().createdBy !== actor.uid) throw new AppError("not-found", "That saved report doesn't exist.");
    await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
  } else {
    const mine = await db.collection("reportConfigs").where("createdBy", "==", actor.uid).count().get();
    if (mine.data().count >= 50) throw new AppError("failed-precondition", "You can keep at most 50 saved reports. Delete one first.");
    await ref.create({ ...body, createdBy: actor.uid, createdByName: actor.name, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }
  return { id: ref.id };
}

/** @param {Actor} actor @param {string[]} perms */
export async function listConfigs(actor, perms) {
  const snap = await db.collection("reportConfigs").where("createdBy", "==", actor.uid).limit(50).get();
  return { configs: snap.docs.map((d) => clean(d)).filter((c) => canRunReport(c.report, perms)).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
}

/** @param {{ id: string }} input @param {Actor} actor */
export async function deleteConfig({ id }, actor) {
  const ref = db.collection("reportConfigs").doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().createdBy !== actor.uid) throw new AppError("not-found", "That saved report doesn't exist.");
  await ref.delete();
  return { id };
}

/* ───────── Schedules ───────── */

/** @param {Record<string, any>} input validated saveScheduleInput @param {Actor} actor @param {string[]} perms */
export async function saveSchedule(input, actor, perms) {
  const def = SCHEDULE_REPORTS[input.report];
  if (!def) throw new AppError("invalid-argument", "Unknown report.");
  if (!def.perms.every((p) => perms.includes(p))) throw new AppError("permission-denied", "You can't schedule a report you aren't allowed to run.");
  if (input.frequency !== def.frequency) throw new AppError("invalid-argument", `${def.label} runs ${def.frequency}.`, { fields: { frequency: `This report runs ${def.frequency}` } });
  const { id, ...body } = input;
  const ref = id ? db.collection("reportSchedules").doc(id) : db.collection("reportSchedules").doc();
  if (id) {
    if (!(await ref.get()).exists) throw new AppError("not-found", "That schedule doesn't exist.");
    await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
  } else {
    const n = await db.collection("reportSchedules").count().get();
    if (n.data().count >= 30) throw new AppError("failed-precondition", "At most 30 schedules.");
    await ref.create({ ...body, lastPeriodKey: "", createdBy: actor.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }
  await writeAudit({ actorUid: actor.uid, action: id ? "analytics.schedule_updated" : "analytics.schedule_created", entityType: "reportSchedule", entityId: ref.id, changes: { report: input.report, frequency: input.frequency, recipients: input.recipientUids.length } });
  return { id: ref.id };
}

/** @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setScheduleActive({ id, isActive }, actor) {
  const ref = db.collection("reportSchedules").doc(id);
  if (!(await ref.get()).exists) throw new AppError("not-found", "That schedule doesn't exist.");
  await ref.update({ isActive, updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "analytics.schedule_toggled", entityType: "reportSchedule", entityId: id, changes: { isActive } });
  return { id, isActive };
}

export async function listSchedules() {
  const snap = await db.collection("reportSchedules").limit(30).get();
  return { schedules: snap.docs.map((d) => clean(d)).sort((a, b) => String(a.name).localeCompare(String(b.name))), reports: Object.entries(SCHEDULE_REPORTS).map(([key, v]) => ({ key, label: v.label, frequency: v.frequency })) };
}

/** The latest COMPLETED period for a frequency: yesterday, last Monday–Sunday week, or last calendar month. @param {"daily" | "weekly" | "monthly"} frequency @param {string} today */
export function lastCompletePeriod(frequency, today) {
  if (frequency === "daily") {
    const d = addDays(today, -1);
    return { from: d, to: d, key: d };
  }
  if (frequency === "weekly") {
    const thisMonday = rangeFor("week", today).from;
    const from = addDays(thisMonday, -7);
    return { from, to: addDays(thisMonday, -1), key: from };
  }
  const first = `${today.slice(0, 7)}-01`;
  const lastDay = addDays(first, -1);
  return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay, key: lastDay.slice(0, 7) };
}

/** The tables a schedule's summary contains. @param {string} report @param {{ from: string, to: string }} p */
async function buildSummary(report, p) {
  if (report === "daily_sales") {
    const [a, b] = await Promise.all([runInternal("sales_trend", { ...p, granularity: "day" }), runInternal("sales_payment", p)]);
    return { tables: [...a.tables, ...b.tables], notes: a.notes };
  }
  if (report === "weekly_performance") {
    const [a, b, c] = await Promise.all([runInternal("sales_trend", { ...p, granularity: "day" }), runInternal("sales_product", { ...p, report: "sales_product", limit: 5 }), runInternal("sales_category", { ...p, report: "sales_category", limit: 5 })]);
    return { tables: [...a.tables, ...b.tables, ...c.tables], notes: a.notes };
  }
  if (report === "monthly_financial") {
    const [a, b, c] = await Promise.all([runInternal("fin_pnl", p), runInternal("fin_cash_flow", p), runInternal("profit_monthly", p)]);
    return { tables: [...a.tables, ...b.tables, ...c.tables], notes: [...a.notes, ...b.notes] };
  }
  if (report === "low_stock") {
    const a = await inventoryAlerts();
    const rows = a.alerts.filter((x) => ["out", "low", "reorder"].includes(x.kind)).map((x) => ({ product: x.product, variant: x.variant, sku: x.sku, kind: x.kind === "out" ? "Out of stock" : x.kind === "low" ? "Low stock" : "Below reorder level", available: x.available, detail: x.detail }));
    return { tables: [table("Low and out-of-stock items today", [col("product", "Product"), col("variant", "Variant"), col("sku", "SKU"), col("kind", "Status"), col("available", "Available", "number"), col("detail", "Detail")], rows)], notes: [a.note].filter(Boolean) };
  }
  const [ar, ap] = await Promise.all([runInternal("fin_ar_aging", { ...p, from: p.to }), runInternal("fin_ap_aging", { ...p, from: p.to })]);
  return { tables: [...ar.tables, ...ap.tables], notes: [...ar.notes, ...ap.notes] };
}

/**
 * Generate every due summary once. Safe to call any number of times and from several screens at once: a period that already has a run is skipped.
 * @param {string} [today]
 */
export async function runDueSchedules(today = pktDateKey(new Date())) {
  const snap = await db.collection("reportSchedules").where("isActive", "==", true).limit(30).get();
  let created = 0;
  const failed = [];
  for (const d of snap.docs) {
    const s = d.data();
    const p = lastCompletePeriod(s.frequency, today);
    const ref = db.collection("reportRuns").doc(`${d.id}__${p.key}`);
    if ((await ref.get()).exists) continue;
    try {
      const summary = await buildSummary(s.report, p);
      await ref.create({ scheduleId: d.id, scheduleName: s.name, report: s.report, reportLabel: SCHEDULE_REPORTS[s.report]?.label ?? s.report, frequency: s.frequency, from: p.from, to: p.to, recipientUids: s.recipientUids, tables: summary.tables, notes: summary.notes ?? [], createdAt: FieldValue.serverTimestamp() });
      await d.ref.update({ lastPeriodKey: p.key });
      created += 1;
    } catch (e) {
      // A report that can't be built (for example accounting isn't set up) is reported, never half-saved.
      if (e?.code !== "6" && !/already exists/i.test(String(e?.message))) failed.push({ schedule: s.name, reason: e?.message ?? "failed" });
    }
  }
  if (created || failed.length) await writeAudit({ actorUid: null, action: "analytics.scheduled_reports_run", entityType: "reportSchedule", entityId: "run", changes: { created, failed: failed.length } });
  return { created, failed };
}

/** The runs addressed to this person that they may still see (they must hold the report's permissions today). @param {{ limit?: number }} input @param {Actor} actor @param {string[]} perms */
export async function reportInbox({ limit = 20 }, actor, perms) {
  const snap = await db.collection("reportRuns").where("recipientUids", "array-contains", actor.uid).orderBy("createdAt", "desc").limit(limit).get();
  const runs = snap.docs.map((d) => Object.assign(row(d), { createdAt: d.data().createdAt?.toDate?.().toISOString() ?? null })).filter((r) => SCHEDULE_REPORTS[r.report]?.perms.every((p) => perms.includes(p)));
  return { runs: runs.map(({ tables: _t, ...r }) => r) };
}

/** @param {{ id: string }} input @param {Actor} actor @param {string[]} perms */
export async function reportRun({ id }, actor, perms) {
  const snap = await db.collection("reportRuns").doc(id).get();
  const r = snap.data();
  if (!snap.exists || !r || !r.recipientUids.includes(actor.uid) || !SCHEDULE_REPORTS[r.report]?.perms.every((p) => perms.includes(p))) throw new AppError("not-found", "That report isn't available to you.");
  return { id, ...r, createdAt: r.createdAt?.toDate?.().toISOString() ?? null };
}
