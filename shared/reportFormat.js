/**
 * Turns a report ({ title, from, to, tables: [{ title, columns, rows, totals }], notes, estimates }) into a file: CSV (an Excel .xlsx
 * workbook is built by xlsx.js), or a print-ready HTML page (for "Save as PDF").
 * Pure string functions with no DOM, so the same output is used by the screen and by the tests.
 *
 * Money columns are integer paisa in the report and are written as rupees with two decimals. Text that could be read as a spreadsheet
 * formula (starting with an equals, plus, minus or at sign) is neutralised in CSV; in the Excel file every text cell is a String cell, never a formula.
 */
import { formatPKR } from "./money.js";

/** Rupees for display; a negative amount (a refund, a discount, a book difference) is shown with a minus sign. @param {number} paisa */
export const signedPKR = (paisa) => (paisa < 0 ? `−${formatPKR(-paisa)}` : formatPKR(paisa));

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rupees = (paisa) => (paisa / 100).toFixed(2);

/** A cell as { kind: "money" | "number" | "text", value } whatever the column type says. */
export function cellOf(column, raw) {
  if (raw === null || raw === undefined || raw === "") return { kind: "text", value: "" };
  if (typeof raw === "object" && "money" in raw) return { kind: "money", value: raw.money };
  if (column.type === "money" && typeof raw === "number") return { kind: "money", value: raw };
  if ((column.type === "number" || column.type === "mixed") && typeof raw === "number") return { kind: "number", value: raw };
  return { kind: "text", value: String(raw) };
}

const csvText = (v) => {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvCell = (c) => (c.kind === "money" ? rupees(c.value) : c.kind === "number" ? String(c.value) : csvText(c.value));

/** @param {{ title: string, from?: string, to?: string, tables: any[], notes?: string[], estimates?: string[] }} report */
export function toCsv(report) {
  const lines = [csvText(report.title), csvText(report.from ? `${report.from} to ${report.to}` : "")];
  for (const t of report.tables) {
    lines.push("", csvText(t.title + (report.estimates?.includes(t.title) ? " (ESTIMATE)" : "")), t.columns.map((c) => csvText(c.label)).join(","));
    const row = (r) => t.columns.map((c) => csvCell(cellOf(c, r[c.key]))).join(",");
    t.rows.forEach((r) => lines.push(row(r)));
    if (t.totals) lines.push(row(t.totals));
  }
  for (const n of report.notes ?? []) lines.push("", csvText(n));
  return lines.join("\r\n");
}

const htmlCell = (c) => (c.kind === "money" ? esc(signedPKR(c.value)) : c.kind === "number" ? esc(c.value.toLocaleString("en-PK")) : esc(c.value) || "—");

/** One table as print HTML. */
export function tableHtml(t, estimate = false) {
  const right = (c) => c.type === "money" || c.type === "number";
  return `<h2>${esc(t.title)}${estimate ? ` <span class="est">ESTIMATE</span>` : ""}</h2>${t.rows.length || t.totals ? `<table><thead><tr>${t.columns.map((c) => `<th class="${right(c) ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td class="${right(c) ? "r" : ""}">${htmlCell(cellOf(c, r[c.key]))}</td>`).join("")}</tr>`).join("")}${t.totals ? `<tr class="tot">${t.columns.map((c) => `<td class="${right(c) ? "r" : ""}">${htmlCell(cellOf(c, t.totals[c.key]))}</td>`).join("")}</tr>` : ""}</tbody></table>` : `<p class="muted">Nothing in this period.</p>`}`;
}

/**
 * A complete print-ready page: business name and logo, title, date range, generation date, every table, notes, page numbers.
 * @param {{ title: string, from?: string, to?: string, tables: any[], notes?: string[], estimates?: string[] }} report
 * @param {{ businessName?: string, logoUrl?: string, generatedAt?: string }} [o]
 */
export function toPrintHtml(report, { businessName = "", logoUrl = "", generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ") } = {}) {
  const logo = /^https:\/\//.test(logoUrl) ? `<img src="${esc(logoUrl)}" alt="" class="logo" />` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(report.title)}</title><style>
    @page{size:A4;margin:14mm 12mm 16mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font:10px system-ui}}
    body{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#111}
    header{display:flex;align-items:center;gap:12px;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:10px}
    .logo{height:42px;width:auto} h1{font-size:18px;margin:0} h2{font-size:13px;margin:16px 0 4px;break-after:avoid}
    .muted{color:#555;font-size:11px} .est{background:#fde68a;color:#78350f;border-radius:3px;padding:0 4px;font-size:10px}
    table{width:100%;border-collapse:collapse;margin-bottom:6px} thead{display:table-header-group} tr{break-inside:avoid}
    th,td{border-bottom:1px solid #ccc;padding:4px 5px;text-align:left;vertical-align:top} th{background:#f3f3f3} .r{text-align:right;font-variant-numeric:tabular-nums}
    .tot td{font-weight:700;border-top:2px solid #111} footer{margin-top:14px;font-size:10px;color:#555}
  </style></head><body><header>${logo}<div><h1>${esc(businessName || "Report")}</h1><div>${esc(report.title)}</div><div class="muted">${report.from ? `Period: ${esc(report.from)} to ${esc(report.to)} · ` : ""}Generated ${esc(generatedAt)}</div></div></header>${report.tables.map((t) => tableHtml(t, Boolean(report.estimates?.includes(t.title)))).join("")}${(report.notes ?? []).map((n) => `<p class="muted">${esc(n)}</p>`).join("")}<footer>${report.estimates?.length ? "Tables marked ESTIMATE are forecasts or rules of thumb, not accounting figures. " : ""}Amounts are in Pakistani rupees.</footer></body></html>`;
}

/** A safe file name for a download. @param {string} title @param {string} from @param {string} to @param {string} ext */
export const fileName = (title, from, to, ext) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report"}_${from}_${to}.${ext}`;
