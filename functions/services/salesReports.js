/**
 * Unified sales report, computed from the saved sales (and their saved cost snapshots) in a date range.
 * Two queries (sales, and saleCosts only for staff who may see costs), never one read per sale.
 *
 *   Counted sales   every sale except cancelled, returned and refunded ones
 *   Gross sales     list prices × quantity                 Discounts = sale-price markdowns + coupon discounts
 *   Net sales       gross sales − discounts (excludes delivery charges and tax)
 *   Cost of goods   from the cost saved WITH each sale (later cost changes never alter it)
 *   Gross profit    net sales − cost of goods, only for sales whose cost was recorded
 *
 * Gross profit is NOT net profit: expenses, salaries, rent and the rest of the accounts are not included.
 */
import { db, Timestamp } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { SALE_CHANNELS, UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";

const MAX_SALES = 5000;

const blank = () => ({ sales: 0, grossSales: 0, itemDiscounts: 0, couponDiscounts: 0, netSales: 0, deliveryCharges: 0, tax: 0, total: 0, units: 0 });

/**
 * @param {{ from: Date, to: Date }} range
 * @param {{ canSeeCost: boolean }} opts
 */
export async function salesSummary({ from, to }, { canSeeCost }) {
  const start = Timestamp.fromMillis(from.getTime());
  const end = Timestamp.fromMillis(to.getTime());
  const inRange = (name) => db.collection(name).where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt").limit(MAX_SALES + 1).get();
  const [salesSnap, costSnap] = await Promise.all([inRange("sales"), canSeeCost ? inRange("saleCosts") : null]);
  if (salesSnap.size > MAX_SALES || (costSnap && costSnap.size > MAX_SALES)) throw new AppError("failed-precondition", `That range has more than ${MAX_SALES} sales. Please choose a shorter range.`);

  const byChannel = Object.fromEntries(SALE_CHANNELS.map((c) => [c, blank()]));
  const combined = blank();
  /** @type {Record<string, { sales: number, total: number }>} */
  const byMethod = {};
  const byStatus = {};
  let paid = 0;
  let due = 0;
  const counted = new Set();
  for (const d of salesSnap.docs) {
    const s = d.data();
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (UNCOUNTED_SALE_STATUSES.includes(s.status)) continue;
    counted.add(d.id);
    for (const t of [byChannel[s.channel] ?? (byChannel[s.channel] = blank()), combined]) {
      t.sales += 1;
      t.grossSales += s.grossSales;
      t.itemDiscounts += s.itemDiscountTotal;
      t.couponDiscounts += s.discountTotal;
      t.netSales += s.netSales;
      t.deliveryCharges += s.shippingTotal;
      t.tax += s.taxTotal;
      t.total += s.total;
      t.units += s.itemCount;
    }
    const m = (byMethod[s.paymentMethod] ??= { sales: 0, total: 0 });
    m.sales += 1;
    m.total += s.total;
    paid += Math.max(0, s.paidTotal - s.refundedTotal);
    due += s.amountDue;
  }

  /** @type {null | { costOfGoods: number, grossProfit: number, netSalesWithCost: number, salesWithCost: number, salesWithoutCost: number, netSalesWithoutCost: number, marginPercent: number | null }} */
  let profit = null;
  if (costSnap) {
    profit = { costOfGoods: 0, grossProfit: 0, netSalesWithCost: 0, salesWithCost: 0, salesWithoutCost: 0, netSalesWithoutCost: 0, marginPercent: null };
    for (const d of costSnap.docs) {
      if (!counted.has(d.id)) continue;
      const c = d.data();
      if (c.costComplete) {
        profit.costOfGoods += c.costTotal;
        profit.grossProfit += c.grossProfit;
        profit.netSalesWithCost += c.netSales;
        profit.salesWithCost += 1;
      } else {
        profit.salesWithoutCost += 1;
        profit.netSalesWithoutCost += c.netSales;
      }
    }
    profit.marginPercent = profit.netSalesWithCost ? Math.round((profit.grossProfit / profit.netSalesWithCost) * 1000) / 10 : null;
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    online: byChannel.online,
    pos: { ...byChannel.pos, note: byChannel.pos.sales ? "" : "No walk-in (POS) sales yet — the POS is not built." },
    combined,
    byMethod,
    byStatus,
    collected: paid,
    stillDue: due,
    profit,
  };
}
