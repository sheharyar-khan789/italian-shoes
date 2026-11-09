/**
 * CSV for exports. Any cell that starts with = + - @ (or a tab/CR) would be run as a formula by
 * Excel or Google Sheets ("CSV injection"), so those cells get a leading apostrophe.
 * @param {unknown} value
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Excel needs a byte-order mark to read UTF-8 (for example Urdu names) correctly. */
const BOM = String.fromCharCode(0xfeff);
const EOL = String.fromCharCode(13, 10);

/** @param {unknown[][]} rows */
export const toCsv = (rows) => `${BOM}${rows.map((r) => r.map(csvCell).join(",")).join(EOL)}${EOL}`;
