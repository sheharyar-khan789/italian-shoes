/** Shared helpers for the income / expense / cash screens: dates, money, receipt upload, report tables and CSV. */
import { esc } from "../lib/format.js";
import { uploadPrivate } from "./privateFileUi.js";
import { pktDateKey } from "../../shared/accounting.js";
import { rupeesToPaisa } from "../../shared/money.js";
import { money } from "./ui/purchasing.js";

export const todayKey = () => pktDateKey(new Date());
export { money };

/** Rupees typed by a person → paisa, or null when it isn't a valid amount. @param {unknown} v */
export const toPaisa = (v) => {
  try {
    return rupeesToPaisa(String(v).trim());
  } catch {
    return null;
  }
};
export const messageOf = (e) => (e?.code && e.code !== "functions/internal" ? e.message : "Something went wrong. Please try again.");

/** Upload a receipt or invoice (PDF / image, up to 5 MB) to the PRIVATE store. Returns the attachment record; `url` is a private path. @param {File} file */
export const uploadReceipt = (file) => uploadPrivate("receipts", file);

const cell = (c, v) => (v === null || v === undefined || v === "" ? "—" : c.type === "money" ? money(v) : c.type === "number" ? String(v) : esc(v));

/** One report table as HTML. @param {{ title: string, columns: any[], rows: any[], totals?: any }} t */
export function tableHtml(t) {
  return `<h2 class="adm-h2">${esc(t.title)}</h2>${
    t.rows.length || t.totals
      ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${t.columns.map((c) => `<th scope="col" class="${c.type === "money" || c.type === "number" ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td class="${c.type === "money" || c.type === "number" ? "r" : ""}">${cell(c, r[c.key])}</td>`).join("")}</tr>`).join("")}${t.totals ? `<tr class="adm-total">${t.columns.map((c) => `<td class="${c.type === "money" || c.type === "number" ? "r" : ""}"><strong>${cell(c, t.totals[c.key])}</strong></td>`).join("")}</tr>` : ""}</tbody></table></div>`
      : `<p class="muted">Nothing in this period.</p>`
  }`;
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV for a report (rupees with two decimals; text that could be read as a formula is neutralised). @param {{ title: string, from: string, to: string, tables: any[] }} report */
export function reportCsv(report) {
  const lines = [csvCell(report.title), csvCell(`${report.from} to ${report.to}`)];
  for (const t of report.tables) {
    lines.push("", csvCell(t.title), t.columns.map((c) => csvCell(c.label)).join(","));
    const row = (r) => t.columns.map((c) => (c.type === "money" || c.type === "number") && typeof r[c.key] === "number" ? (c.type === "money" ? (r[c.key] / 100).toFixed(2) : String(r[c.key])) : csvCell(r[c.key])).join(",");
    t.rows.forEach((r) => lines.push(row(r)));
    if (t.totals) lines.push(row(t.totals));
  }
  return lines.join("\r\n");
}

/** Save text as a file download. */
export function downloadText(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Give every table cell its column name (the phone layout shows it beside the value). @param {ParentNode} root */
export function labelTables(root) {
  root.querySelectorAll("table").forEach((t) => {
    const heads = [...t.querySelectorAll("thead th")].map((h) => h.textContent ?? "");
    t.querySelectorAll("tbody tr").forEach((tr) => [...tr.children].forEach((td, i) => heads[i] && !td.hasAttribute("data-label") && td.setAttribute("data-label", heads[i])));
  });
}
