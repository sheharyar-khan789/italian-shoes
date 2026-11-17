/**
 * Sales: vocabulary and arithmetic shared by the server and the admin. All money is integer paisa.
 *
 * A sale line is a permanent snapshot (names, SKU, colour, size, prices, discounts and the cost at the time):
 *   regularPrice   list price per pair when sold
 *   unitPrice      price per pair actually charged (the sale price when one applied)
 *   itemDiscount   (regularPrice − unitPrice) × qty         markdown from a sale price
 *   lineTotal      unitPrice × qty
 *   couponShare    this line's share of the order's coupon discount (largest remainder, adds up exactly)
 *   lineNet        lineTotal − couponShare                  what the shop keeps for these pairs (before delivery and tax)
 * Sale totals: subtotal = Σ lineTotal; discountTotal = coupon discount; netSales = subtotal − discountTotal;
 * total = netSales + tax + delivery. Delivery and tax are not part of net sales or of gross profit.
 *
 * Gross profit = net sales − cost of the goods sold (from the cost snapshot). It is NOT net profit: expenses,
 * salaries, rent and the rest of the accounts come in a later phase.
 */
import { assertPaisa } from "./money.js";

export const SALE_CHANNELS = /** @type {const} */ (["online", "pos"]);
/** Online sales use the order statuses one for one; "completed" is for walk-in sales that finish at the counter. */
export const SALE_STATUSES = /** @type {const} */ (["pending", "confirmed", "processing", "dispatched", "delivered", "completed", "cancelled", "returned", "refunded"]);
export const SALE_PAYMENT_METHODS = /** @type {const} */ (["cod", "cash", "bank_transfer", "jazzcash", "easypaisa"]);
export const SALE_PAYMENT_LABEL = { cod: "Cash on Delivery", cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
/** Sale statuses that do not count towards sales figures. */
export const UNCOUNTED_SALE_STATUSES = ["cancelled", "returned", "refunded"];
export const SALE_STATUS_LABEL = { pending: "Pending", confirmed: "Confirmed", processing: "Processing", dispatched: "Dispatched", delivered: "Delivered", completed: "Completed", cancelled: "Cancelled", returned: "Returned", refunded: "Refunded" };

/**
 * Share `amount` over `weights` in proportion, exactly (largest remainder, ties to the earlier line, never more than the weight).
 * @param {number} amount @param {number[]} weights
 */
export function allocateByWeight(amount, weights) {
  assertPaisa(amount);
  const total = weights.reduce((n, w) => n + w, 0);
  const out = weights.map(() => 0);
  if (!amount || !total) return out;
  const A = BigInt(amount);
  const T = BigInt(total);
  const parts = weights.map((w, i) => {
    const exact = A * BigInt(w);
    return { i, floor: Number(exact / T), rem: exact % T };
  });
  let left = amount - parts.reduce((n, p) => n + p.floor, 0);
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))) {
    const extra = left > 0 && p.floor < weights[p.i] ? 1 : 0;
    out[p.i] = p.floor + extra;
    left -= extra;
  }
  return out;
}

/**
 * Sale lines, and their cost snapshot, from priced order lines.
 * @param {{ productId: string, variantId: string, sku: string, productName: string, variantLabel: string, colorName?: string, sizeLabel?: string, qty: number, unitPrice: number, regularPrice?: number, lineTotal: number, imagePath?: string | null }[]} items
 * @param {number} couponDiscount
 * @param {(number | null | undefined)[]} unitCosts cost per pair at the time of the sale (null/undefined = not recorded)
 * @param {({ warehouseId: string, qty: number }[] | null | undefined)[]} allocations where each line's pairs came from
 * @param {string} defaultWarehouseId used when a line has no allocation record (orders from before warehouses)
 */
export function computeSaleLines(items, couponDiscount, unitCosts, allocations, defaultWarehouseId) {
  const shares = allocateByWeight(couponDiscount, items.map((l) => l.lineTotal));
  const lines = items.map((l, i) => {
    const regularPrice = l.regularPrice ?? l.unitPrice;
    const itemDiscount = Math.max(0, regularPrice - l.unitPrice) * l.qty;
    const lineNet = l.lineTotal - shares[i];
    const cost = unitCosts[i];
    const costKnown = Number.isSafeInteger(cost) && /** @type {number} */ (cost) >= 0;
    const alloc = allocations[i]?.length ? allocations[i].map((a) => ({ warehouseId: a.warehouseId, qty: a.qty })) : [{ warehouseId: defaultWarehouseId, qty: l.qty }];
    return {
      line: {
        productId: l.productId,
        variantId: l.variantId,
        sku: l.sku,
        productName: l.productName,
        variantLabel: l.variantLabel,
        colorName: l.colorName ?? l.variantLabel.split(" / ")[0] ?? "",
        sizeLabel: l.sizeLabel ?? l.variantLabel.split(" / ").slice(1).join(" / "),
        qty: l.qty,
        regularPrice,
        unitPrice: l.unitPrice,
        itemDiscount,
        lineTotal: l.lineTotal,
        couponShare: shares[i],
        lineNet,
        allocations: alloc,
        imagePath: l.imagePath ?? null,
      },
      cost: { productId: l.productId, variantId: l.variantId, costKnown, unitCost: costKnown ? /** @type {number} */ (cost) : null, lineCost: costKnown ? /** @type {number} */ (cost) * l.qty : null, lineNet, lineProfit: costKnown ? lineNet - /** @type {number} */ (cost) * l.qty : null },
    };
  });
  return { lines: lines.map((x) => x.line), costLines: lines.map((x) => x.cost) };
}

/** Totals of the cost snapshot. Profit is only stated when the cost of EVERY line is known. @param {{ costKnown: boolean, lineCost: number | null, lineNet: number }[]} costLines @param {number} netSales */
export function costTotals(costLines, netSales) {
  const costComplete = costLines.length > 0 && costLines.every((c) => c.costKnown);
  const costTotal = costComplete ? costLines.reduce((n, c) => n + /** @type {number} */ (c.lineCost), 0) : null;
  return { costComplete, costTotal, grossProfit: costComplete ? netSales - /** @type {number} */ (costTotal) : null };
}

/** What the sale document shows about payment, from the payment record (amount, status, paidTotal?, refundedTotal?). @param {Record<string, any>} pay */
export function salePaymentFields(pay) {
  const paidTotal = pay.paidTotal ?? (["collected", "paid", "partially_refunded", "refunded"].includes(pay.status) ? pay.amount : 0);
  const refundedTotal = pay.refundedTotal ?? 0;
  const closed = ["void", "failed"].includes(pay.status);
  return { paymentStatus: pay.status, paidTotal, refundedTotal, amountDue: closed ? 0 : Math.max(0, pay.amount - paidTotal) };
}
