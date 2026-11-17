/**
 * Advanced inventory: shared constants and pure helpers (server and browser).
 * Costing method: weighted (moving) average, already kept per variant in variantCosts.costPrice by goods receipts.
 */

/** Reasons for a stock adjustment. dir: which way stock may move. loss/gain: the books treat it as a write-off / a gain. */
export const ADJUST_REASONS = {
  correction: { label: "Physical stock correction", dir: "either" },
  damaged: { label: "Damaged products", dir: "out" },
  lost: { label: "Lost products", dir: "out" },
  missing: { label: "Missing products", dir: "out" },
  found: { label: "Found stock", dir: "in" },
  internal_use: { label: "Internal usage", dir: "out" },
  other: { label: "Other authorised reason", dir: "either" },
};
export const ADJUST_REASON_KEYS = /** @type {[keyof typeof ADJUST_REASONS, ...(keyof typeof ADJUST_REASONS)[]]} */ (Object.keys(ADJUST_REASONS));

export const TRANSFER_STATUS_LABEL = { draft: "Draft", requested: "Requested", in_transit: "Dispatched", partially_received: "Partially received", received: "Received", cancelled: "Cancelled" };

export const ALERT_DEFAULTS = { lowStock: 3, slowDays: 60, deadDays: 180, adjustApprovalUnits: 0, adjustApprovalValue: 0 };

/** Alert kinds shown on the dashboard. */
export const ALERT_LABEL = { out: "Out of stock", low: "Low stock", reorder: "Reorder now", over: "Overstock", slow: "Slow moving", dead: "Dead stock" };

/* ───────── EAN-13 barcodes ───────── */

/** Check digit for the first 12 digits. @param {string} d12 */
export function ean13CheckDigit(d12) {
  const sum = [...d12].reduce((n, c, i) => n + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}
/** A valid EAN-13? @param {string} code */
export const isEan13 = (code) => /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
/** In-store barcodes use the 200–299 range reserved for internal use, so they never clash with manufacturer codes. @param {number} seq */
export function internalEan13(seq) {
  const body = `200${String(seq).padStart(9, "0")}`;
  return body + ean13CheckDigit(body);
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95 bars of an EAN-13 as a string of 0/1. @param {string} code */
export function ean13Bits(code) {
  if (!isEan13(code)) throw new RangeError("Not a valid EAN-13 code");
  const first = Number(code[0]);
  let bits = "101";
  for (let i = 0; i < 6; i += 1) bits += (PARITY[first][i] === "L" ? L : G)[Number(code[i + 1])];
  bits += "01010";
  for (let i = 0; i < 6; i += 1) bits += R[Number(code[i + 7])];
  return `${bits}101`;
}

/** Inline SVG of an EAN-13 barcode with its digits. @param {string} code @param {{ module?: number, height?: number }} [o] */
export function ean13Svg(code, { module = 2, height = 60 } = {}) {
  const bits = ean13Bits(code);
  const quiet = 9 * module;
  let bars = "";
  for (let i = 0; i < bits.length; ) {
    if (bits[i] === "1") {
      let j = i;
      while (bits[j] === "1") j += 1;
      bars += `<rect x="${quiet + i * module}" y="0" width="${(j - i) * module}" height="${height}"/>`;
      i = j;
    } else i += 1;
  }
  const w = bits.length * module + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height + 16}" width="${w}" height="${height + 16}" role="img" aria-label="Barcode ${code}"><g fill="#000">${bars}</g><text x="${w / 2}" y="${height + 13}" text-anchor="middle" font-family="monospace" font-size="12">${code}</text></svg>`;
}
