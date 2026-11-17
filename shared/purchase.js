/**
 * Purchasing arithmetic. Everything is whole paisa and whole units; nothing uses floating point.
 * Divisions use BigInt so large amounts can't lose precision, and always round half up.
 *
 * Pricing of an order:
 *   line gross     = unit cost × quantity
 *   line net       = gross − line discount
 *   subtotal       = Σ line net
 *   order discount = a whole-order discount (≤ subtotal), shared out over the lines in proportion to their
 *                    net (largest remainder, so the shares add up to the discount exactly)
 *   total          = subtotal − order discount = Σ line effective (net − its share of the order discount)
 *
 * Receiving: units are valued at their line's effective price per ordered unit, cumulatively
 * (cumulativeValue), so receiving a line in several parts adds up to exactly the line's effective amount.
 */
import { assertPaisa } from "./money.js";

export const PURCHASE_MAX_LINES = 60;

/** a / b rounded half up, exact for any safe integers. */
export function divRound(a, b) {
  if (b <= 0) throw new RangeError("Division by a non-positive number");
  const A = BigInt(a);
  const B = BigInt(b);
  return Number((2n * A + B) / (2n * B));
}

/** Share `amount` over `weights` in proportion (largest remainder), so the shares add up to `amount` exactly. @param {number} amount @param {number[]} weights */
export function allocateProportional(amount, weights) {
  const total = weights.reduce((n, w) => n + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const A = BigInt(amount);
  const T = BigInt(total);
  const parts = weights.map((w, i) => ({ i, floor: Number((A * BigInt(w)) / T), rem: (A * BigInt(w)) % T }));
  let left = amount - parts.reduce((n, p) => n + p.floor, 0);
  const out = parts.map((p) => p.floor);
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    if (left <= 0) break;
    out[p.i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * @param {{ qty: number, unitCost: number, discount?: number }[]} lines
 * @param {number} [orderDiscount]
 */
export function priceOrder(lines, orderDiscount = 0, { taxPercent = 0, charges = 0 } = {}) {
  if (!lines.length) throw new RangeError("An order needs at least one line");
  const priced = lines.map((l) => {
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw new RangeError("Quantity must be a whole number of 1 or more");
    const gross = assertPaisa(l.unitCost) * l.qty;
    assertPaisa(gross);
    const discount = assertPaisa(l.discount ?? 0);
    if (discount > gross) throw new RangeError("A line discount can't be more than the line amount");
    return { qty: l.qty, unitCost: l.unitCost, gross, discount, net: gross - discount, allocatedDiscount: 0, allocatedExtra: 0, effective: 0 };
  });
  const subtotal = priced.reduce((n, l) => n + l.net, 0);
  assertPaisa(subtotal);
  assertPaisa(orderDiscount);
  if (orderDiscount > subtotal) throw new RangeError("The order discount can't be more than the subtotal");

  // Share the order discount: floor of the exact share first, then the leftover paisa to the biggest remainders.
  if (orderDiscount > 0 && subtotal > 0) {
    const D = BigInt(orderDiscount);
    const S = BigInt(subtotal);
    const parts = priced.map((l, i) => {
      const exact = D * BigInt(l.net);
      return { i, floor: Number(exact / S), rem: exact % S };
    });
    let left = orderDiscount - parts.reduce((n, p) => n + p.floor, 0);
    for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
      const extra = left > 0 && p.floor < priced[p.i].net ? 1 : 0;
      priced[p.i].allocatedDiscount = p.floor + extra;
      left -= extra;
    }
  }
  // Tax and extra charges (freight, packing, …) are added to what the goods cost: shared over the lines in proportion to
  // what each line costs after the discount, so the lines still add up to the order total exactly.
  assertPaisa(charges);
  if (!(taxPercent >= 0 && taxPercent <= 100) || !Number.isInteger(Math.round(taxPercent * 100))) throw new RangeError("Tax must be between 0% and 100%");
  const afterDiscount = subtotal - orderDiscount;
  const taxTotal = taxPercent > 0 && afterDiscount > 0 ? divRound(BigInt(afterDiscount) * BigInt(Math.round(taxPercent * 100)), 10000) : 0;
  const extra = taxTotal + charges;
  const extras = allocateProportional(extra, priced.map((l) => l.net - l.allocatedDiscount));
  priced.forEach((l, i) => {
    l.allocatedExtra = extras[i];
    l.effective = l.net - l.allocatedDiscount + extras[i];
  });
  return { lines: priced, subtotal, orderDiscount, taxPercent, taxTotal, chargesTotal: charges, total: afterDiscount + extra };
}

/** Value of the first `k` of `qty` units of a line whose effective amount is `effective` (half-up, exact at k = qty). */
export const cumulativeValue = (effective, qty, k) => (k <= 0 ? 0 : k >= qty ? effective : divRound(BigInt(effective) * BigInt(k), qty));

/** Value of receiving `add` more units after `before` units were already accepted. */
export const receiptValue = (effective, qty, before, add) => cumulativeValue(effective, qty, before + add) - cumulativeValue(effective, qty, before);

/**
 * Moving-average cost per pair after adding stock.
 *   new average = (units on hand × current average + value added) ÷ (units on hand + units added)
 * With nothing on hand, or no cost on file, the new stock's own cost is the average.
 * @param {{ onHandQty: number, currentAvg: number | null | undefined, addQty: number, addValue: number }} p
 * @returns {number} whole paisa
 */
export function movingAverage({ onHandQty, currentAvg, addQty, addValue }) {
  if (!(addQty > 0)) return currentAvg ?? 0;
  if (onHandQty <= 0 || currentAvg == null) return divRound(addValue, addQty);
  return divRound(BigInt(onHandQty) * BigInt(currentAvg) + BigInt(addValue), onHandQty + addQty);
}

/** unpaid / partial / paid from what was received (net of returns) and what was paid. */
export function paymentStatusOf({ receivedValue = 0, returnedValue = 0, paidTotal = 0 }) {
  const owed = receivedValue - returnedValue;
  if (paidTotal <= 0) return "unpaid";
  return paidTotal >= owed ? "paid" : "partial";
}

export const SUPPLIER_PAY_METHODS = /** @type {const} */ (["cash", "bank_transfer", "jazzcash", "easypaisa"]);
export const SUPPLIER_PAY_LABEL = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
