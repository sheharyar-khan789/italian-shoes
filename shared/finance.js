/**
 * Income, expenses and cash management: shared constants and pure helpers (server and browser).
 * Money is always integer paisa. Dates are Pakistan-time YYYY-MM-DD keys.
 */
import { isPrivateFileRef } from "./privateFiles.js";
export const FINANCE_METHODS = /** @type {const} */ (["cash", "bank_transfer", "jazzcash", "easypaisa"]);
export const METHOD_LABEL = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
/** Which kind of money account a payment method uses. */
export const METHOD_KIND = { cash: "cash", bank_transfer: "bank", jazzcash: "wallet", easypaisa: "wallet" };

export const ENTRY_TYPES = /** @type {const} */ (["income", "expense", "transfer", "adjustment"]);
export const ENTRY_STATUS_LABEL = { posted: "Posted", pending: "Waiting for approval", rejected: "Rejected", void: "Void" };

/** Categories the owner can add in one click. They post to the existing accounts through a role; no account is invented. */
export const SUGGESTED_EXPENSE_CATEGORIES = [
  { name: "Shop Rent", role: "operating_expenses" },
  { name: "Salaries", role: "salaries" },
  { name: "Electricity", role: "operating_expenses" },
  { name: "Internet", role: "operating_expenses" },
  { name: "Transportation", role: "operating_expenses" },
  { name: "Packaging", role: "operating_expenses" },
  { name: "Marketing", role: "operating_expenses" },
  { name: "Maintenance", role: "operating_expenses" },
  { name: "Other Expenses", role: "operating_expenses" },
];
export const SUGGESTED_INCOME_CATEGORIES = [{ name: "Other Income", role: "other_income" }];
/** The account role a category posts to when the owner hasn't chosen a specific account. */
export const DEFAULT_ROLE = { income: "other_income", expense: "operating_expenses" };

const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** @param {"today" | "yesterday" | "week" | "month" | "year"} preset @param {string} today YYYY-MM-DD */
export function rangeFor(preset, today) {
  const [y, m] = today.split("-");
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  switch (preset) {
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week": {
      const from = addDays(today, -((dow + 6) % 7)); // weeks start on Monday
      return { from, to: today };
    }
    case "month":
      return { from: `${y}-${m}-01`, to: today };
    case "year":
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: today, to: today };
  }
}

/** Every date key from `from` to `to` inclusive. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export { addDays };

/** The next date a recurring expense falls on. @param {"weekly" | "monthly"} frequency @param {string} dateKey @param {number} [dayOfMonth] */
export function nextOccurrence(frequency, dateKey, dayOfMonth = Number(dateKey.slice(8))) {
  if (frequency === "weekly") return addDays(dateKey, 7);
  const [y, m] = dateKey.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(dayOfMonth, last)).padStart(2, "0")}`;
}

/** Closing = opening + in − out. */
export const closingCash = (opening, cashIn, cashOut) => opening + cashIn - cashOut;

/** Receipt and invoice files live in the same Blob store as product photos, under receipts/. */
export const RECEIPT_UPLOAD = { types: ["image/jpeg", "image/png", "image/webp", "application/pdf"], maxBytes: 5 * 1024 * 1024 };
/** A receipt or supplier paper is a PRIVATE file path such as "receipts/<uid>/bill-x.pdf" (never a public link). @param {string} url */
export function isReceiptUrl(url) {
  return isPrivateFileRef(url, "receipts");
}
