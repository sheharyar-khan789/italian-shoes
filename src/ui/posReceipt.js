/**
 * POS receipt. Pure functions: sale data in, a complete printable HTML document out. It is laid out for browser
 * printing at 58 mm and 80 mm thermal widths and as a normal page; nothing here talks to a printer, so it works
 * with whatever printer the browser's print dialog offers (a thermal printer installed as a system printer, a
 * normal printer, or "save as PDF"). Only real, saved information is printed; everything dynamic is escaped.
 */
import { esc } from "../lib/format.js";
import { formatPKR } from "../../shared/money.js";

export const RECEIPT_WIDTH_LABEL = { "58mm": "Thermal 58 mm", "80mm": "Thermal 80 mm", standard: "Standard page" };
const METHOD = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa", cod: "Cash on delivery" };

/** Print layout for a width. */
export function receiptCss(width) {
  const w = { "58mm": "54mm", "80mm": "72mm" }[width];
  const page = width === "standard" ? "@page { margin: 14mm; }" : `@page { size: ${width} auto; margin: 2mm; }`;
  return `
    ${page}
    *{box-sizing:border-box}
    body{margin:0;font:${width === "58mm" ? "11px" : width === "80mm" ? "12px" : "14px"}/1.35 "Courier New",ui-monospace,monospace;color:#000;background:#fff}
    .rc{${w ? `width:${w};` : "max-width:640px;"}margin:0 auto;padding:${width === "standard" ? "0" : "2mm 0"}}
    .rc h1{font-size:1.25em;margin:0;text-align:center}
    .rc .c{text-align:center}.rc .muted{color:#333}.rc .big{font-size:1.25em;font-weight:700}
    .rc hr{border:0;border-top:1px dashed #000;margin:6px 0}
    .rc table{width:100%;border-collapse:collapse}.rc td{vertical-align:top;padding:1px 0}.rc td.r{text-align:right;white-space:nowrap;padding-left:6px}
    .rc img.logo{display:block;margin:0 auto 4px;max-width:60%;max-height:18mm}
    .rc .row{display:flex;justify-content:space-between;gap:6px}
    .rc .item{margin:3px 0}`;
}

const when = (iso) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" }).format(new Date(iso));
};

/**
 * @param {{ sale: Record<string, any>, payments?: { type: string, method: string, amount: number, reference?: string }[] }} data
 * @param {{ storeName?: string, phone?: string, email?: string, address?: string, openingHours?: string, logoUrl?: string }} store
 * @param {"58mm" | "80mm" | "standard"} width
 */
export function receiptBody(data, store = {}, width = "80mm") {
  const s = data.sale;
  const lines = (s.lines ?? [])
    .map(
      (l) => `<div class="item"><div>${esc(l.productName)}</div>
        <div class="muted">${esc(l.colorName)} / ${esc(l.sizeLabel)} · ${esc(l.sku)}</div>
        <div class="row"><span>${l.qty} × ${esc(formatPKR(l.unitPrice))}</span><span>${esc(formatPKR(l.lineTotal))}</span></div>
        ${l.unitPrice < l.regularPrice ? `<div class="muted">list ${esc(formatPKR(l.regularPrice))} each</div>` : ""}</div>`,
    )
    .join("");
  const pays = (data.payments ?? []).filter((p) => p.type === "collection");
  const tenders = s.pos?.tenders ?? [];
  const received = (i) => tenders[i]?.cashReceived;
  const row = (label, value, cls = "") => `<div class="row ${cls}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const change = tenders.reduce((n, t) => n + (t.cashReceived !== undefined ? t.cashReceived - t.amount : 0), 0);
  const contact = [store.address, store.phone, store.email, store.openingHours].filter(Boolean).map((x) => `<div class="c muted">${esc(x)}</div>`).join("");
  return `<div class="rc" data-width="${esc(width)}">
    ${store.logoUrl && /^https:\/\//.test(store.logoUrl) ? `<img class="logo" src="${esc(store.logoUrl)}" alt="" />` : ""}
    <h1>${esc(store.storeName || "Receipt")}</h1>${contact}
    <hr />
    ${row("Sale", s.number)}${row("Date", when(s.createdAt))}${row("Cashier", s.cashierName ?? "")}
    ${s.customer?.name ? row("Customer", s.customer.name) : ""}
    <hr />${lines}<hr />
    ${row("Subtotal", formatPKR(s.subtotal))}
    ${s.itemDiscountTotal ? row("Sale prices saved", formatPKR(s.itemDiscountTotal)) : ""}
    ${s.discountTotal ? row("Discount", `− ${formatPKR(s.discountTotal)}`) : ""}
    ${s.taxTotal ? row("Tax", formatPKR(s.taxTotal)) : ""}
    ${row("TOTAL", formatPKR(s.total), "big")}
    <hr />
    ${pays.length ? pays.map((p, i) => row(`${METHOD[p.method] ?? p.method}${p.reference ? ` ${p.reference}` : ""}`, formatPKR(p.amount)) + (received(i) !== undefined && p.method === "cash" ? row("  cash received", formatPKR(received(i))) : "")).join("") : tenders.map((t) => row(METHOD[t.method] ?? t.method, formatPKR(t.amount))).join("")}
    ${change > 0 ? row("Change", formatPKR(change)) : ""}
    ${row("Paid", formatPKR(s.paidTotal ?? 0))}
    ${s.amountDue > 0 ? row("BALANCE DUE", formatPKR(s.amountDue), "big") : ""}
    <hr /><div class="c muted">Thank you</div></div>`;
}

/** A complete HTML document (for preview in an iframe and for printing). */
/** @param {Parameters<typeof receiptBody>[0]} data @param {Parameters<typeof receiptBody>[1]} store @param {string} [width] */
export function receiptDocument(data, store, width = "80mm") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Receipt ${esc(data.sale.number)}</title><style>${receiptCss(/** @type {any} */ (width))}</style></head><body>${receiptBody(data, store, /** @type {any} */ (width))}</body></html>`;
}

/** Print a receipt document through the browser (a hidden frame, so the admin page isn't disturbed). Browser-only. @param {string} html */
export function printReceiptHtml(html) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60000);
  };
  document.body.append(frame);
}
