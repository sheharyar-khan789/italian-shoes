/**
 * What each business event posts. Pure functions: a source record in, a journal spec out (accounts are named by
 * ROLE; the engine turns roles into the owner's accounts). The same functions serve live postings and the
 * historical backfill, so both follow identical rules.
 *
 *   Sale (online, at placement)     Dr COD / Accounts receivable   total                (customer)
 *                                   Dr Sales discounts             sale-price markdown + coupon
 *                                      Cr Sales revenue            gross sales (list prices)
 *                                      Cr Delivery income          delivery charge
 *                                      Cr Sales tax payable        tax
 *                                   Dr Cost of goods sold          cost snapshot        ┐ only when the cost of EVERY
 *                                      Cr Inventory                cost snapshot        ┘ line was recorded
 *   Customer payment                Dr Cash / Bank / Wallet clearing   Cr receivable (customer)
 *   Customer refund                 Dr receivable (customer)           Cr Cash
 *   Goods received (accepted)       Dr Inventory    Cr Accounts payable (supplier)       at the receipt's value
 *   Supplier payment                Dr Accounts payable (supplier)     Cr Cash / Bank / Wallet clearing
 *   Purchase return                 Dr Accounts payable (supplier)     Cr Inventory      at the receipt's value
 *   Cancelled / returned sale       the sale's journal reversed (same accounts, debits and credits swapped)
 *
 * A COD sale is a RECEIVABLE until cash is actually recorded as collected; a mobile-wallet payment goes to a
 * clearing account, not the bank, because a recorded wallet payment is not bank settlement.
 */
import { paymentRoleOf, pktDateKey } from "../shared/accounting.js";

/** Date | Firestore Timestamp | undefined → YYYY-MM-DD (Pakistan time); now when missing. */
export function toDateKey(value) {
  const d = value?.toDate ? value.toDate() : value instanceof Date ? value : new Date();
  return pktDateKey(d);
}

const customerOf = (sale) => (sale?.customerId ? { partyType: "customer", partyId: sale.customerId, partyName: sale.customer?.name ?? null } : {});
const receivableRole = (sale) => (sale?.paymentMethod === "cod" || !sale ? "cod_receivable" : "accounts_receivable");

/** @param {string} saleId @param {Record<string, any>} sale @param {Record<string, any> | null | undefined} saleCost @param {any} when */
export function saleSpec(saleId, sale, saleCost, when) {
  const lines = [
    { role: receivableRole(sale), debit: sale.total, ...customerOf(sale) },
    { role: "sales_discounts", debit: sale.itemDiscountTotal + sale.discountTotal },
    { role: "sales_revenue", credit: sale.grossSales },
    { role: "delivery_income", credit: sale.shippingTotal },
    { role: "sales_tax", credit: sale.taxTotal },
  ];
  const costKnown = Boolean(saleCost?.costComplete) && saleCost.costTotal > 0;
  if (costKnown) lines.push({ role: "cogs", debit: saleCost.costTotal }, { role: "inventory", credit: saleCost.costTotal });
  return { sourceType: "sale", sourceId: saleId, dateKey: toDateKey(when), memo: `Sale ${sale.number}${sale.orderNumber ? ` (order ${sale.orderNumber})` : ""}`, lines, meta: { costMissing: !saleCost?.costComplete, saleNumber: sale.number } };
}

/** @param {{ sale: Record<string, any>, txnId: string, amount: number, method: string, reference?: string, when?: any }} p */
export function customerPaymentSpec({ sale, txnId, amount, method, reference = "", when }) {
  return {
    sourceType: "payment",
    sourceId: txnId,
    dateKey: toDateKey(when),
    memo: `Payment for ${sale.number} (${method})${reference ? ` ${reference}` : ""}`,
    lines: [{ role: paymentRoleOf(method), debit: amount }, { role: receivableRole(sale), credit: amount, ...customerOf(sale) }],
  };
}

/** Money given back to a customer. The receivable is cleared (the sale itself is reversed when the order is cancelled or returned). */
/** @param {{ sale: Record<string, any>, txnId: string, amount: number, reason?: string, when?: any }} p */
export function refundSpec({ sale, txnId, amount, reason = "", when }) {
  return {
    sourceType: "refund",
    sourceId: txnId,
    dateKey: toDateKey(when),
    memo: `Refund for ${sale.number}${reason ? `: ${reason}` : ""}`,
    lines: [{ role: receivableRole(sale), debit: amount, ...customerOf(sale) }, { role: "cash", credit: amount }],
  };
}

/**
 * Goods taken back from a walk-in sale: the sale's entry, scaled to what came back. Revenue and tax are given back, the
 * discounts that applied are given back, and what the customer is owed is settled as refunded money and/or a smaller
 * receivable. Resellable pairs return to inventory at their original cost (cost of goods sold is reversed); damaged pairs
 * are written off instead.
 * @param {{ returnId: string, number: string, sale: Record<string, any>, gross: number, discounts: number, tax: number, receivableCredit: number, refund: number, refundMethod: string, restockCost: number, writeOffCost: number, reason?: string, when?: any }} p
 */
export function saleReturnSpec(p) {
  const { sale } = p;
  const lines = [
    { role: "sales_returns", debit: p.gross },
    { role: "sales_discounts", credit: p.discounts },
    { role: "sales_tax", debit: p.tax },
    { role: receivableRole(sale), credit: p.receivableCredit, ...customerOf(sale) },
    { role: paymentRoleOf(p.refundMethod), credit: p.refund },
  ];
  const cost = p.restockCost + p.writeOffCost;
  if (cost > 0) lines.push({ role: "inventory", debit: p.restockCost }, { role: "inventory_adjustments", debit: p.writeOffCost }, { role: "cogs", credit: cost });
  return { sourceType: "salereturn", sourceId: p.returnId, dateKey: toDateKey(p.when), memo: `Return ${p.number} on sale ${sale.number}${p.reason ? `: ${p.reason}` : ""}`, lines, meta: { saleNumber: sale.number } };
}

/**
 * Cash put into or taken out of a register. Each reason names the other account (existing roles only):
 * owner capital / bank on the way in; bank / shop expenses on the way out.
 * @param {{ movementId: string, type: "cash_in" | "cash_out", reason: string, amount: number, session: string, when?: any }} p
 */
export function registerMoveSpec({ movementId, type, reason, amount, session, when }) {
  const other = { owner_capital: "owner_capital", bank_withdrawal: "bank", bank_deposit: "bank", operating_expense: "operating_expenses" }[reason];
  const label = { owner_capital: "owner capital", bank_withdrawal: "bank withdrawal", bank_deposit: "bank deposit", operating_expense: "shop expense" }[reason];
  return {
    sourceType: "registermove",
    sourceId: movementId,
    dateKey: toDateKey(when),
    memo: `Register ${session}: cash ${type === "cash_in" ? "in" : "out"} (${label})`,
    lines: type === "cash_in" ? [{ role: "cash", debit: amount }, { role: other, credit: amount }] : [{ role: other, debit: amount }, { role: "cash", credit: amount }],
  };
}

/** The difference between counted and expected cash when a register is closed. A shortage is an expense, an excess is a credit to the same account (reclassify with a manual journal if you prefer another account). */
/** @param {{ sessionId: string, session: string, variance: number, when?: any }} p */
export function registerVarianceSpec({ sessionId, session, variance, when }) {
  const amount = Math.abs(variance);
  return {
    sourceType: "registervariance",
    sourceId: sessionId,
    dateKey: toDateKey(when),
    memo: `Register ${session}: cash ${variance < 0 ? "shortage" : "excess"} at closing`,
    lines: variance < 0 ? [{ role: "operating_expenses", debit: amount }, { role: "cash", credit: amount }] : [{ role: "cash", debit: amount }, { role: "operating_expenses", credit: amount }],
  };
}

/** @param {string} id @param {Record<string, any>} grn */
export function grnSpec(id, grn) {
  return {
    sourceType: "grn",
    sourceId: id,
    dateKey: toDateKey(grn.receivedDate),
    memo: `Goods received ${grn.number} from ${grn.supplierName} (${grn.purchaseOrderNumber})`,
    lines: [{ role: "inventory", debit: grn.value }, { role: "accounts_payable", credit: grn.value, partyType: "supplier", partyId: grn.supplierId, partyName: grn.supplierName }],
  };
}

/** @param {string} id @param {Record<string, any>} p */
export function supplierPaymentSpec(id, p) {
  return {
    sourceType: "supplierpayment",
    sourceId: id,
    dateKey: toDateKey(p.paidAt),
    memo: `Payment ${p.number} to ${p.supplierName} (${p.methodLabel ?? p.method})${p.reference ? ` ${p.reference}` : ""}`,
    lines: [{ role: "accounts_payable", debit: p.amount, partyType: "supplier", partyId: p.supplierId, partyName: p.supplierName }, { role: paymentRoleOf(p.method), credit: p.amount }],
  };
}

/** @param {string} id @param {Record<string, any>} r */
export function purchaseReturnSpec(id, r) {
  return {
    sourceType: "purchasereturn",
    sourceId: id,
    dateKey: toDateKey(r.createdAt),
    memo: `Return ${r.number} to ${r.supplierName} (${r.grnNumber})`,
    lines: [{ role: "accounts_payable", debit: r.value, partyType: "supplier", partyId: r.supplierId, partyName: r.supplierName }, { role: "inventory", credit: r.value }],
  };
}

/** A supplier gives money back (after an advance or a return): Dr cash / bank / wallet clearing, Cr accounts payable. @param {string} id @param {Record<string, any>} r */
export function supplierRefundSpec(id, r) {
  return {
    sourceType: "supplierrefund",
    sourceId: id,
    dateKey: toDateKey(r.receivedAt),
    memo: `Refund ${r.number} from ${r.supplierName} (${r.methodLabel ?? r.method})${r.reference ? ` ${r.reference}` : ""}`,
    lines: [{ role: paymentRoleOf(r.method), debit: r.amount }, { role: "accounts_payable", credit: r.amount, partyType: "supplier", partyId: r.supplierId, partyName: r.supplierName }],
  };
}

/** A manual change to what is owed. Decrease: Dr accounts payable, Cr the chosen account. Increase: Dr the chosen account, Cr accounts payable. @param {string} id @param {Record<string, any>} a */
export function supplierAdjustmentSpec(id, a) {
  const ap = { role: "accounts_payable", partyType: "supplier", partyId: a.supplierId, partyName: a.supplierName };
  return {
    sourceType: "supplieradjustment",
    sourceId: id,
    dateKey: toDateKey(a.date),
    memo: `Adjustment ${a.number} for ${a.supplierName}: ${a.reason}`,
    lines: a.direction === "decrease" ? [{ ...ap, debit: a.amount }, { accountCode: a.accountCode, credit: a.amount }] : [{ accountCode: a.accountCode, debit: a.amount }, { ...ap, credit: a.amount }],
  };
}

/** Stock lost / damaged / counted short (loss) or found / counted over (gain), at the average cost. Loss: Dr inventory adjustments, Cr inventory. Gain: the opposite. @param {string} id @param {Record<string, any>} a */
export function stockAdjustmentSpec(id, a) {
  return {
    sourceType: "stockadjustment",
    sourceId: id,
    dateKey: toDateKey(a.when),
    memo: `${a.label}: ${a.qty} × ${a.productName} (${a.variantLabel})${a.note ? ` — ${a.note}` : ""}`,
    lines: a.change < 0 ? [{ role: "inventory_adjustments", debit: a.value }, { role: "inventory", credit: a.value }] : [{ role: "inventory", debit: a.value }, { role: "inventory_adjustments", credit: a.value }],
  };
}

/** A change in a variant's average cost applied to the pairs on hand. Increase: Dr inventory, Cr inventory adjustments. Decrease: the opposite. @param {string} id @param {Record<string, any>} r */
export function costRevaluationSpec(id, r) {
  return {
    sourceType: "costrevaluation",
    sourceId: id,
    dateKey: toDateKey(r.when),
    memo: `Cost revaluation ${r.productName} (${r.variantLabel}): ${r.oldCost / 100} → ${r.newCost / 100} on ${r.onHand} pairs — ${r.reason}`,
    lines: r.value > 0 ? [{ role: "inventory", debit: r.value }, { role: "inventory_adjustments", credit: r.value }] : [{ role: "inventory_adjustments", debit: -r.value }, { role: "inventory", credit: -r.value }],
  };
}
