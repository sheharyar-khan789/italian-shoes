import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYTICS_REPORTS, canRunReport, previousPeriod, yearBefore, growth, marginPercent, bucketOf, bucketsBetween, classifyMovement, daysOfCover, turnover, reorderQty, isOverstock, agingBucket, ageInDays } from "../../shared/analytics.js";
import { toCsv, toPrintHtml, fileName, cellOf } from "../../shared/reportFormat.js";
import { toXlsx, crc32 } from "../../shared/xlsx.js";
import { analyticsReportInput, analyticsExecutiveInput, saveScheduleInput, saveReportConfigInput } from "../../shared/schemas/index.js";
import { ALL_PERMISSIONS } from "../../shared/permissions.js";

test("periods: the previous period has the same length; year-on-year handles 29 February", () => {
  assert.deepEqual(previousPeriod("2026-11-10", "2026-11-16"), { from: "2026-11-03", to: "2026-11-09" });
  assert.deepEqual(previousPeriod("2026-11-16", "2026-11-16"), { from: "2026-11-15", to: "2026-11-15" });
  assert.equal(yearBefore("2026-11-16"), "2025-11-16");
  assert.equal(yearBefore("2028-02-29"), "2027-02-28");
});

test("growth and margin: one decimal, and never a made-up number when there is nothing to compare", () => {
  assert.equal(growth(150, 100), 50);
  assert.equal(growth(80, 100), -20);
  assert.equal(growth(10, 0), null);
  assert.equal(growth(0, 0), null);
  assert.equal(marginPercent(1550000, 3950000), 39.2);
  assert.equal(marginPercent(-100, 1000), -10);
  assert.equal(marginPercent(10, 0), null);
});

test("buckets: weeks start on Monday, months and years, and every empty bucket is listed", () => {
  assert.equal(bucketOf("2026-11-18", "week"), "2026-11-16");
  assert.equal(bucketOf("2026-11-22", "week"), "2026-11-16");
  assert.equal(bucketOf("2026-11-23", "week"), "2026-11-23");
  assert.equal(bucketOf("2026-11-18", "month"), "2026-11");
  assert.equal(bucketOf("2026-11-18", "year"), "2026");
  assert.deepEqual(bucketsBetween("2026-11-01", "2026-11-03", "day"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(bucketsBetween("2026-10-30", "2026-12-02", "month"), ["2026-10", "2026-11", "2026-12"]);
  assert.deepEqual(bucketsBetween("2026-11-18", "2026-12-01", "week"), ["2026-11-16", "2026-11-23", "2026-11-30"]);
});

test("stock movement (estimates): fast, normal, slow and dead depend on days of stock left at the recent rate", () => {
  assert.equal(daysOfCover({ onHand: 30, sold: 30, days: 30 }), 30);
  assert.equal(daysOfCover({ onHand: 30, sold: 0, days: 30 }), null);
  assert.equal(classifyMovement({ sold: 30, onHand: 10, days: 30 }), "fast");
  assert.equal(classifyMovement({ sold: 30, onHand: 60, days: 30 }), "normal");
  assert.equal(classifyMovement({ sold: 3, onHand: 100, days: 30 }), "slow");
  assert.equal(classifyMovement({ sold: 0, onHand: 5, days: 30 }), "dead");
  assert.equal(classifyMovement({ sold: 0, onHand: 0, days: 30 }), "none");
  assert.equal(classifyMovement({ sold: 4, onHand: 0, days: 30 }), "fast", "sold out");
});

test("turnover, reorder quantity and overstock", () => {
  assert.equal(turnover({ cogs: 600, openingValue: 100, closingValue: 300 }), 3);
  assert.equal(turnover({ cogs: 600, openingValue: 0, closingValue: 0 }), null);
  assert.equal(reorderQty({ onHand: 5, sold: 30, days: 30, leadDays: 14, safetyDays: 7 }), 16);
  assert.equal(reorderQty({ onHand: 5, onOrder: 20, sold: 30, days: 30, leadDays: 14, safetyDays: 7 }), 0, "what is already on order counts");
  assert.equal(reorderQty({ onHand: 5, sold: 30, days: 30, leadDays: 14, safetyDays: 7, maxStock: 10 }), 5, "never above the maximum");
  assert.equal(reorderQty({ onHand: 5, sold: 0, days: 30, leadDays: 14, safetyDays: 7 }), 0, "no sales, no suggestion");
  assert.equal(isOverstock({ onHand: 400, sold: 30, days: 30 }), true);
  assert.equal(isOverstock({ onHand: 20, sold: 30, days: 30 }), false);
  assert.equal(isOverstock({ onHand: 20, sold: 30, days: 30, maxStock: 10 }), true);
});

test("ageing bands", () => {
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 400].map(agingBucket), ["current", "current", "d31", "d31", "d61", "d61", "d90", "d90"]);
  assert.equal(ageInDays("2026-11-01", "2026-11-16"), 15);
  assert.equal(ageInDays("2026-11-16", "2026-11-01"), 0);
});

test("the report catalogue: every report needs permissions that exist; financial reports need financial permissions", () => {
  for (const [k, r] of Object.entries(ANALYTICS_REPORTS)) for (const p of r.perms) assert.ok(ALL_PERMISSIONS.includes(p), `${k} needs ${p}`);
  for (const [k, r] of Object.entries(ANALYTICS_REPORTS)) if (k.startsWith("fin_") || k.startsWith("profit_")) assert.ok(r.perms.includes("analytics.financial"), k);
  assert.equal(canRunReport("sales_trend", ["analytics.read", "sales.read"]), true);
  assert.equal(canRunReport("sales_trend", ["analytics.read"]), false);
  assert.equal(canRunReport("profit_product", ["analytics.financial", "accounting.read"]), false, "costs.read is needed too");
  assert.equal(canRunReport("nope", ALL_PERMISSIONS), false);
});

test("input schemas: valid dates, bounded ranges, comparison pairs, schedules and saved reports", () => {
  const ok = { report: "sales_trend", from: "2026-11-01", to: "2026-11-16" };
  assert.equal(analyticsReportInput.safeParse(ok).success, true);
  assert.equal(analyticsReportInput.safeParse({ ...ok, to: "2026-10-31" }).success, false);
  assert.equal(analyticsReportInput.safeParse({ ...ok, from: "2020-01-01" }).success, false, "ranges over about three years are refused");
  assert.equal(analyticsReportInput.safeParse({ ...ok, compareFrom: "2026-10-01" }).success, false);
  assert.equal(analyticsReportInput.safeParse({ ...ok, compareFrom: "2026-10-01", compareTo: "2026-10-16" }).success, true);
  assert.equal(analyticsReportInput.safeParse({ ...ok, report: "x" }).success, false);
  assert.equal(analyticsReportInput.parse(ok).filters.channel, "");
  assert.equal(analyticsExecutiveInput.safeParse({ from: "bad", to: "2026-11-01" }).success, false);
  assert.equal(saveScheduleInput.safeParse({ report: "daily_sales", name: "Daily", frequency: "daily", recipientUids: [] }).success, false);
  assert.equal(saveScheduleInput.safeParse({ report: "daily_sales", name: "Daily", frequency: "daily", recipientUids: ["uid-12345678"] }).success, true);
  assert.equal(saveScheduleInput.safeParse({ report: "mail_everyone", name: "Daily", frequency: "daily", recipientUids: ["uid-12345678"] }).success, false);
  assert.equal(saveReportConfigInput.safeParse({ name: "Mine", report: "sales_product", period: "month", filters: {} }).success, true);
});

const sample = {
  title: "Sales by product",
  from: "2026-11-01",
  to: "2026-11-16",
  tables: [
    { title: "By product", columns: [{ key: "name", label: "Product", type: "text" }, { key: "net", label: "Net sales", type: "money" }, { key: "units", label: "Pairs", type: "number" }], rows: [{ name: 'Oxford, "Classic"', net: 150050, units: 3 }, { name: '=HYPERLINK("http://evil")', net: 0, units: 0 }, { name: "Loafer & Co <b>", net: null, units: 2 }], totals: { name: "Total", net: 150050, units: 5 } },
    { title: "Stock", columns: [{ key: "v", label: "Value", type: "mixed" }], rows: [{ v: { money: 99900 } }, { v: 7 }, { v: "n/a" }] },
  ],
  notes: ["Counted sales only."],
  estimates: ["Stock"],
};

test("CSV export: rupees with two decimals, quoting, formula injection neutralised, totals, estimates and notes labelled", () => {
  const lines = toCsv(sample).split("\r\n");
  assert.equal(lines[0], "Sales by product");
  assert.equal(lines[1], "2026-11-01 to 2026-11-16");
  assert.ok(lines.includes('"Oxford, ""Classic""",1500.50,3'));
  assert.ok(lines.some((l) => l.startsWith("\"'=HYPERLINK")), "a formula in a text cell can't run when the CSV is opened");
  assert.ok(lines.includes("Total,1500.50,5"));
  assert.ok(lines.includes("Stock (ESTIMATE)"));
  assert.ok(lines.includes("999.00") && lines.includes("7") && lines.includes("n/a"));
  assert.ok(lines.includes("Counted sales only."));
  assert.equal(cellOf({ type: "money" }, null).value, "");
});

/** Read a ZIP written with the store method: { name → text }, verifying every CRC and the central directory. */
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50, "end of central directory");
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, "central entry");
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(local, true), 0x04034b50, "local header");
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    out[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return out;
}

test("Excel (.xlsx) export: a valid workbook (ZIP with correct checksums), a summary sheet and one sheet per table; numbers are numbers; text is escaped", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the standard CRC-32 check value");
  const files = unzip(toXlsx(sample, { businessName: "Italian Shoes", generatedAt: "2026-11-16 10:00" }));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]);
  const wb = files["xl/workbook.xml"];
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Summary", "By product", "Stock est"]);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
  const s1 = files["xl/worksheets/sheet1.xml"];
  assert.ok(s1.includes("Italian Shoes") && s1.includes("Period: 2026-11-01 to 2026-11-16") && s1.includes("Counted sales only."));
  const s2 = files["xl/worksheets/sheet2.xml"];
  assert.ok(s2.includes("<v>1500.50</v>"), "money is a number in rupees");
  assert.ok(s2.includes('s="2"') && s2.includes('s="3"'), "money cells carry the money format; the total row is bold");
  assert.ok(s2.includes("Loafer &amp; Co &lt;b&gt;"), "text is escaped");
  assert.ok(!s2.includes("<b>"));
  assert.ok(s2.includes('t="inlineStr"') && s2.includes("=HYPERLINK") && !s2.includes("<f>"), "a formula-looking text stays text: there are no formula cells");
  const s3 = files["xl/worksheets/sheet3.xml"];
  assert.ok(s3.includes("Stock (ESTIMATE)") && s3.includes("<v>999.00</v>") && s3.includes("<v>7</v>") && s3.includes("n/a"));
  for (const [name, xml] of Object.entries(files)) assert.ok(xml.startsWith("<?xml"), name);
  assert.ok(files["xl/styles.xml"].includes('numFmtId="4"'), "#,##0.00");
});

test("print / PDF layout: business name, logo only from https, range, generation date, totals, estimate badge, page numbers, everything escaped", () => {
  const html = toPrintHtml(sample, { businessName: "Italian <Shoes>", logoUrl: "https://example.com/logo.png", generatedAt: "2026-11-16 10:00" });
  assert.ok(html.includes("Italian &lt;Shoes&gt;"));
  assert.ok(html.includes('<img src="https://example.com/logo.png"'));
  assert.ok(html.includes("Period: 2026-11-01 to 2026-11-16"));
  assert.ok(html.includes("Generated 2026-11-16 10:00"));
  assert.ok(html.includes("1,500.50"));
  assert.ok(html.includes("ESTIMATE"));
  assert.ok(html.includes("counter(page)") && html.includes("counter(pages)"));
  assert.ok(!html.includes("<b>") && !html.includes("<script"));
  assert.ok(!toPrintHtml(sample, { logoUrl: "javascript:alert(1)" }).includes("javascript:"));
  assert.ok(!toPrintHtml(sample, { logoUrl: "http://insecure/logo.png" }).includes("<img"), "only https logos");
  assert.equal(fileName("Sales by product!", "2026-11-01", "2026-11-16", "csv"), "sales-by-product_2026-11-01_2026-11-16.csv");
});

test("negative amounts (discounts, refunds, book differences) are shown with a minus sign and never crash the output", () => {
  const neg = { title: "Neg", from: "2026-11-01", to: "2026-11-02", tables: [{ title: "T", columns: [{ key: "a", label: "A", type: "money" }], rows: [{ a: -200000 }, { a: { money: -5 } }], totals: { a: -200005 } }] };
  const html = toPrintHtml(neg);
  assert.ok(html.includes("−Rs. 2,000") && html.includes("−Rs. 0.05"));
  assert.ok(toCsv(neg).includes("-2000.00"));
  assert.doesNotThrow(() => toXlsx(neg));
});
