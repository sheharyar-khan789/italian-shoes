/**
 * Point-of-sale vocabulary and cash arithmetic shared by the server and the admin. Money is whole paisa.
 *
 * Expected cash in a register = opening float + cash received from sales + cash put in − cash taken out.
 * The server keeps those totals on the session document, updated inside the same transaction as each payment or
 * cash movement, so the figure never has to be rebuilt from scattered records.
 */

/** Ways a customer can pay at the counter. A bank or wallet entry RECORDS a payment the cashier saw; nothing verifies it. */
export const POS_TENDER_METHODS = /** @type {const} */ (["cash", "bank_transfer", "jazzcash", "easypaisa"]);

export const CASH_IN_REASONS = /** @type {const} */ (["owner_capital", "bank_withdrawal"]);
export const CASH_OUT_REASONS = /** @type {const} */ (["bank_deposit", "operating_expense"]);
export const CASH_REASON_LABEL = {
  owner_capital: "Owner put cash in (capital)",
  bank_withdrawal: "Cash taken out of the bank",
  bank_deposit: "Cash paid into the bank",
  operating_expense: "Paid out for a shop expense",
};

/** Hand-written lookup of which receipt widths are supported. */
export const RECEIPT_WIDTHS = /** @type {const} */ (["58mm", "80mm", "standard"]);

/**
 * Cash that should be in the drawer according to the records.
 * @param {{ openingFloat?: number, totals?: Record<string, number>, cashIn?: number, cashOut?: number }} session
 */
export const expectedCash = (session) => (session.openingFloat ?? 0) + (session.totals?.cash ?? 0) + (session.cashIn ?? 0) - (session.cashOut ?? 0);

/** counted − expected: negative = shortage, positive = excess. */
export const cashVariance = (counted, expected) => counted - expected;
