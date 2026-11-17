/** Shared helpers for the analytics screens: date presets, report rendering (charts + tables), and exports (CSV, Excel, print / PDF). */
import { esc } from "../lib/format.js";
import { rangeFor, addDays } from "../../shared/finance.js";
import { previousPeriod } from "../../shared/analytics.js";
import { toCsv, toPrintHtml, fileName, cellOf, signedPKR } from "../../shared/reportFormat.js";
import { toXlsx } from "../../shared/xlsx.js";
import { renderChart, wireCharts } from "./ui/charts.js";
import { call, getRow } from "./purchData.js";
import { todayKey, downloadText, messageOf } from "./financeUi.js";

export { messageOf, todayKey };

export const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["last30", "Last 30 days"], ["last90", "Last 90 days"], ["year", "This year"], ["custom", "Custom dates"]];

/** { from, to } for a preset (custom returns null). @param {string} p */
export function presetDates(p) {
  const t = todayKey();
  if (p === "last30") return { from: addDays(t, -29), to: t };
  if (p === "last90") return { from: addDays(t, -89), to: t };
  if (p === "custom") return null;
  return rangeFor(/** @type {any} */ (p), t);
}

/** The comparison period of the same length straight before. @param {string} from @param {string} to */
export const comparisonFor = (from, to) => {
  const p = previousPeriod(from, to);
  return { compareFrom: p.from, compareTo: p.to };
};

/** One table for the screen (money, counts, text, and the { money } cells some tables use). @param {{ title: string, columns: any[], rows: any[], totals?: any }} t @param {boolean} [estimate] */
export function adminTable(t, estimate = false) {
  const right = (c) => c.type === "money" || c.type === "number";
  const show = (c, raw) => {
    const x = cellOf(c, raw);
    return x.kind === "money" ? esc(signedPKR(x.value)) : x.kind === "number" ? esc(x.value.toLocaleString("en-PK")) : esc(x.value) || "—";
  };
  const head = `<h2 class="adm-h2">${esc(t.title)}${estimate ? `<span class="an-badge">Estimate</span>` : ""}</h2>`;
  if (!t.rows.length && !t.totals) return `${head}<p class="muted">Nothing in this period.</p>`;
  return `${head}<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${t.columns.map((c) => `<th scope="col" class="${right(c) ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td data-label="${esc(c.label)}" class="${right(c) ? "r" : ""}">${show(c, r[c.key])}</td>`).join("")}</tr>`).join("")}${t.totals ? `<tr class="adm-total">${t.columns.map((c) => `<td data-label="${esc(c.label)}" class="${right(c) ? "r" : ""}"><strong>${show(c, t.totals[c.key])}</strong></td>`).join("")}</tr>` : ""}</tbody></table></div>`;
}

/** Charts, then tables, then notes. @param {any} report */
export function reportBody(report) {
  const charts = (report.charts ?? []).map(renderChart).join("");
  return `${charts ? `<div class="an-charts">${charts}</div>` : ""}${report.tables.map((t) => adminTable(t, Boolean(report.estimates?.includes(t.title)))).join("")}${report.estimates?.length ? `<p class="muted"><span class="an-badge">Estimate</span> marks forecasts and rules of thumb built from past sales; they are not accounting figures.</p>` : ""}${(report.notes ?? []).map((n) => `<p class="muted">${esc(n)}</p>`).join("")}`;
}

/** Insert a finished report and wire its charts. @param {HTMLElement} el @param {any} report */
export function showReport(el, report) {
  el.innerHTML = `${report.cached ? `<p class="muted">Served from a short-lived cache: nothing it depends on has changed since it was calculated.</p>` : ""}${reportBody(report)}`;
  wireCharts(el);
}

let business = null;
async function businessInfo() {
  if (business) return business;
  const s = await getRow("settings", "public").catch(() => null);
  business = { businessName: s?.storeName ?? "", logoUrl: s?.logoUrl ?? "" };
  return business;
}

const downloadBytes = (name, bytes, type) => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

/**
 * Check permission and record the export on the server, then produce the file in the browser.
 * @param {any} report a report in the shared shape @param {"csv" | "excel" | "print"} format
 * @returns {Promise<string>} "" or a message to show
 */
export async function exportReport(report, format, endpoint = "analyticsExport") {
  const key = report.report ?? "executive";
  try {
    await call(endpoint, { report: key, format: format === "excel" ? "excel" : format, from: report.from, to: report.to });
  } catch (e) {
    return messageOf(e);
  }
  const info = await businessInfo();
  if (format === "csv") downloadText(fileName(report.title, report.from, report.to, "csv"), toCsv(report));
  else if (format === "excel") downloadBytes(fileName(report.title, report.from, report.to, "xlsx"), toXlsx(report, info), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  else {
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return "Your browser blocked the print window. Allow pop-ups for this site and try again.";
    w.document.write(toPrintHtml(report, info));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }
  return "";
}

/** Export buttons (only for people who may export). @param {string[]} perms @param {string} [perm] */
export const exportButtons = (perms, perm = "analytics.export") => (perms.includes(perm) ? `<p data-exports hidden><button type="button" class="btn btn--ghost" data-export="csv">Download CSV</button> <button type="button" class="btn btn--ghost" data-export="excel">Download Excel</button> <button type="button" class="btn btn--ghost" data-export="print">Print / save as PDF</button></p>` : "");

/** Wire the export buttons inside `root` to whatever `get()` returns. @param {HTMLElement} root @param {() => any} get @param {string} [endpoint] the server endpoint that checks permission and records the export */
export function wireExports(root, get, endpoint = "analyticsExport") {
  root.querySelectorAll("[data-export]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = get();
      if (!r) return;
      const btn = /** @type {HTMLButtonElement} */ (b);
      btn.disabled = true;
      const msg = await exportReport(r, /** @type {any} */ (btn.dataset.export), endpoint);
      btn.disabled = false;
      root.querySelector("[data-export-msg]")?.remove();
      if (msg) root.querySelector("[data-exports]")?.insertAdjacentHTML("afterend", `<p class="form-alert" role="alert" data-export-msg>${esc(msg)}</p>`);
    }),
  );
}
