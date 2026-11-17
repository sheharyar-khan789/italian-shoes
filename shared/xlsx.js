/**
 * A minimal, dependency-free Excel (.xlsx) writer. An .xlsx file is a ZIP of XML parts; this builds the few parts a report needs
 * (workbook, one worksheet per table plus a summary sheet, styles) and stores them uncompressed. Pure functions: no DOM, no Node-only APIs.
 *
 * Money columns are written as numbers in rupees with a `#,##0.00` format; counts as numbers; everything else as text (inline strings, which
 * Excel never evaluates as formulas). Bold header and total rows.
 */
const enc = new TextEncoder();

/** Escape XML text and drop control characters XML can't hold. @param {unknown} v */
const xmlEsc = (v) =>
  String(v ?? "")
    .split("")
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 || c === 9 || c === 10 || c === 13;
    })
    .join("")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/* ───────── ZIP (store only) ───────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{ name: string, data: Uint8Array }[]} files @returns {Uint8Array} */
export function zipStore(files) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Uint8Array[]} */
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)]);
    chunks.push(local, name, f.data);
    central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += local.length + name.length + f.data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(offset), ...u16(0)]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/* ───────── Workbook ───────── */

const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Style ids in styles.xml: 0 plain, 1 bold, 2 money, 3 bold money, 4 bold number. */
function cell(ref, kind, value, bold) {
  if (kind === "money") return `<c r="${ref}" s="${bold ? 3 : 2}"><v>${(value / 100).toFixed(2)}</v></c>`;
  if (kind === "number") return `<c r="${ref}" s="${bold ? 4 : 0}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr" s="${bold ? 1 : 0}"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

/** { kind, value } for one report cell (same rules as the CSV and print outputs). */
function typed(column, raw) {
  if (raw === null || raw === undefined || raw === "") return { kind: "text", value: "" };
  if (typeof raw === "object" && "money" in raw) return { kind: "money", value: raw.money };
  if (column.type === "money" && typeof raw === "number") return { kind: "money", value: raw };
  if ((column.type === "number" || column.type === "mixed") && typeof raw === "number") return { kind: "number", value: raw };
  return { kind: "text", value: String(raw) };
}

function sheetXml(rows, widths) {
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => cell(`${colName(i)}${r + 1}`, c.kind, c.value, c.bold)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const sheetName = (title, used) => {
  let n = title.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Sheet";
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 25)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
};

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * @param {{ title: string, from?: string, to?: string, tables: any[], notes?: string[], estimates?: string[] }} report
 * @param {{ businessName?: string, generatedAt?: string }} [o]
 * @returns {Uint8Array} the .xlsx file
 */
export function toXlsx(report, { businessName = "", generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ") } = {}) {
  const used = new Set(["summary"]);
  const text = (v, bold = false) => ({ kind: "text", value: v, bold });
  /** @type {{ name: string, widths: number[], rows: any[][] }[]} */
  const sheets = [{ name: "Summary", widths: [90], rows: [[text(businessName || "Report", true)], [text(report.title, true)], [text(report.from ? `Period: ${report.from} to ${report.to}` : "")], [text(`Generated ${generatedAt} UTC`)], [text("")], ...(report.notes ?? []).map((n) => [text(n)])] }];
  for (const t of report.tables) {
    const est = report.estimates?.includes(t.title) ? " (ESTIMATE)" : "";
    /** @type {any[][]} */
    const rows = [[text(t.title + est, true)], t.columns.map((c) => text(c.label, true))];
    const row = (r, bold) => t.columns.map((c) => ({ ...typed(c, r[c.key]), bold }));
    t.rows.forEach((r) => rows.push(row(r, false)));
    if (t.totals) rows.push(row(t.totals, true));
    const widths = t.columns.map((c, i) => Math.min(48, Math.max(12, c.label.length + 4, i === 0 ? 18 : 0, ...t.rows.slice(0, 40).map((r) => (typeof r[c.key] === "object" ? 0 : String(r[c.key] ?? "").length + 2)))));
    sheets.push({ name: sheetName(t.title + (est ? " est" : ""), used), widths, rows });
  }
  const parts = [
    { name: "[Content_Types].xml", xml: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", xml: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", xml: `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", xml: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", xml: `${XML}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s.rows, s.widths) })),
  ];
  return zipStore(parts.map((p) => ({ name: p.name, data: enc.encode(p.xml) })));
}
