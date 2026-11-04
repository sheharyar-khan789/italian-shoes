/**
 * Money is always an integer number of paisa (1 rupee = 100 paisa).
 * Never use floating-point rupees in calculations or storage.
 */

export const PAISA_PER_RUPEE = 100;

/** @param {unknown} value @returns {value is number} */
export const isPaisa = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Parse a rupee amount typed by a person ("12,500", "12500.50", 12500) into paisa.
 * Done on the decimal string, so "0.1" + "0.2" style float errors cannot happen.
 * @param {string | number} input
 * @returns {number} paisa
 */
export function rupeesToPaisa(input) {
  const text = String(input).trim().replace(/,/g, "");
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new RangeError(`Not a valid rupee amount: "${input}"`);
  const [, whole, fraction = ""] = match;
  return Number(whole) * PAISA_PER_RUPEE + Number(fraction.padEnd(2, "0"));
}

/** @param {number} paisa */
export function assertPaisa(paisa) {
  if (!isPaisa(paisa)) throw new RangeError(`Amount must be a non-negative whole number of paisa, got ${paisa}`);
  return paisa;
}

/** @param {...number} amounts */
export const sumPaisa = (...amounts) => amounts.reduce((total, a) => total + assertPaisa(a), 0);

/** @param {number} unitPaisa @param {number} qty */
export function lineTotal(unitPaisa, qty) {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError(`Quantity must be a positive whole number, got ${qty}`);
  const total = assertPaisa(unitPaisa) * qty;
  return assertPaisa(total);
}

/**
 * Percentage of an amount, rounded down to whole paisa (never gives away more than the percentage).
 * @param {number} paisa
 * @param {number} percent 0–100, whole or with up to two decimals
 */
export function percentOf(paisa, percent) {
  if (!(percent >= 0 && percent <= 100)) throw new RangeError(`Percent must be between 0 and 100, got ${percent}`);
  const basisPoints = Math.round(percent * 100);
  return Math.floor((assertPaisa(paisa) * basisPoints) / 10000);
}

const pkr = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const pkrExact = new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * 1250000 → "Rs. 12,500". Shows paisa only when they are not zero (1250050 → "Rs. 12,500.50").
 * @param {number} paisa
 */
export function formatPKR(paisa) {
  assertPaisa(paisa);
  const rupees = paisa / PAISA_PER_RUPEE;
  return `Rs. ${paisa % PAISA_PER_RUPEE === 0 ? pkr.format(rupees) : pkrExact.format(rupees)}`;
}
