/**
 * CRM, loyalty, membership and customer discounts: configuration defaults and the PURE rules (server and browser).
 * Nothing here is a fixed classification: every threshold comes from the owner's saved settings (settings in
 * `crmSettings/main`); CRM_DEFAULTS are only the starting values shown before the owner changes them. Loyalty is OFF until enabled.
 * Money is integer paisa. Dates are ISO strings or milliseconds.
 */

export const CRM_DEFAULTS = {
  customerTypes: ["Retail", "Wholesale", "Corporate"],
  /** Customer groups are worked out from purchase activity with these thresholds (all editable). */
  segments: { newDays: 30, regularOrders: 3, regularDays: 365, vipSpend: 10000000, highValueSpend: 5000000, inactiveDays: 180, returningOrders: 2 },
  /** Membership tiers by spend in the last 12 months. The first tier is the entry level. */
  tiers: [
    { key: "standard", name: "Standard", minAnnualSpend: 0, discountPercent: 0, pointsMultiplier: 1 },
    { key: "silver", name: "Silver", minAnnualSpend: 5000000, discountPercent: 0, pointsMultiplier: 1.25 },
    { key: "gold", name: "Gold", minAnnualSpend: 15000000, discountPercent: 0, pointsMultiplier: 1.5 },
    { key: "platinum", name: "Platinum", minAnnualSpend: 30000000, discountPercent: 0, pointsMultiplier: 2 },
  ],
  loyalty: { enabled: false, pointsPer100: 1, redeemValuePerPoint: 100, minRedeemPoints: 100, maxRedeemPercent: 50, maxRedeemPointsPerSale: 0, expiryDays: 365, excludedCategoryIds: [], excludedProductIds: [] },
};

export const SEGMENT_LABEL = { new: "New customers", returning: "Returning customers", regular: "Regular customers", vip: "VIP customers", highValue: "High-value customers", inactive: "Inactive customers" };
export const NOTE_TYPES = { note: "Note", call: "Phone call", whatsapp: "WhatsApp chat", feedback: "Feedback", complaint: "Complaint", followup: "Follow-up" };
export const COMPLAINT_STATUS = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

const DAY = 86400000;
const ms = (t) => (typeof t === "number" ? t : Date.parse(t));

/**
 * Which customer groups a customer is in, from their real purchase activity. A customer can be in several groups.
 * @param {{ orders: number, spent: number, firstAt: number | string | null, lastAt: number | string | null, ordersInWindow?: number, spentYear?: number }} s
 * @param {typeof CRM_DEFAULTS.segments} cfg @param {number} now
 * @returns {string[]}
 */
export function computeSegments(s, cfg, now) {
  const out = [];
  if (!s.orders) return out;
  const last = s.lastAt === null ? null : ms(s.lastAt);
  const first = s.firstAt === null ? null : ms(s.firstAt);
  if (cfg.inactiveDays > 0 && last !== null && now - last > cfg.inactiveDays * DAY) out.push("inactive");
  if (first !== null && now - first <= cfg.newDays * DAY && s.orders < cfg.returningOrders) out.push("new");
  if (s.orders >= cfg.returningOrders) out.push("returning");
  if ((s.ordersInWindow ?? 0) >= cfg.regularOrders) out.push("regular");
  if (cfg.vipSpend > 0 && s.spent >= cfg.vipSpend) out.push("vip");
  if (cfg.highValueSpend > 0 && s.spent >= cfg.highValueSpend) out.push("highValue");
  return out;
}

/** The highest tier whose minimum annual spend is met. @param {number} annualSpend @param {{ key: string, minAnnualSpend: number }[]} tiers */
export function tierFor(annualSpend, tiers) {
  const sorted = [...tiers].sort((a, b) => a.minAnnualSpend - b.minAnnualSpend);
  let best = sorted[0] ?? null;
  for (const t of sorted) if (annualSpend >= t.minAnnualSpend) best = t;
  return best;
}

/** Points earned: whole points per Rs 100 of eligible spend, times the member's multiplier, rounded down. @param {{ eligibleAmount: number, pointsPer100: number, multiplier?: number }} p */
export function pointsForSale({ eligibleAmount, pointsPer100, multiplier = 1 }) {
  if (!(eligibleAmount > 0) || !(pointsPer100 > 0)) return 0;
  return Math.floor((eligibleAmount * pointsPer100 * multiplier) / 10000);
}

/**
 * How many points can be redeemed on a sale and what they are worth.
 * @param {{ requested: number, balance: number, payable: number }} s @param {typeof CRM_DEFAULTS.loyalty} cfg
 * @returns {{ points: number, value: number } | { error: string }}
 */
export function redeemCheck({ requested, balance, payable }, cfg) {
  if (!cfg.enabled) return { error: "The loyalty programme isn't switched on." };
  if (!Number.isInteger(requested) || requested <= 0) return { points: 0, value: 0 };
  if (requested > balance) return { error: `Only ${balance} points are available.` };
  if (requested < cfg.minRedeemPoints) return { error: `At least ${cfg.minRedeemPoints} points must be redeemed at once.` };
  if (cfg.maxRedeemPointsPerSale > 0 && requested > cfg.maxRedeemPointsPerSale) return { error: `At most ${cfg.maxRedeemPointsPerSale} points can be redeemed on one purchase.` };
  const value = requested * cfg.redeemValuePerPoint;
  const cap = Math.floor((payable * cfg.maxRedeemPercent) / 100);
  if (value > cap) return { error: `Points can pay for at most ${cfg.maxRedeemPercent}% of a purchase (${Math.floor(cap / cfg.redeemValuePerPoint)} points here).` };
  return { points: requested, value };
}

/** The most points a customer could redeem on this payable amount (for the "use points" box). */
export function maxRedeemable({ balance, payable }, cfg) {
  if (!cfg.enabled || balance < cfg.minRedeemPoints) return 0;
  let max = Math.min(balance, Math.floor((payable * cfg.maxRedeemPercent) / 100 / cfg.redeemValuePerPoint));
  if (cfg.maxRedeemPointsPerSale > 0) max = Math.min(max, cfg.maxRedeemPointsPerSale);
  return max < cfg.minRedeemPoints ? 0 : max;
}

/**
 * Does a customer discount apply to this sale, and for how much?
 * @param {{ scope: "all" | "customer" | "tier" | "segment", customerId?: string, tier?: string, segment?: string, type: "percent" | "amount", value: number, minPurchase?: number, validFrom?: string, validTo?: string, usageLimit?: number, perCustomerLimit?: number, productIds?: string[], categoryIds?: string[], isActive?: boolean }} d
 * @param {{ customerId: string | null, tier: string | null, segments: string[], now: number, lines: { productId: string, categoryId?: string | null, amount: number }[], used: number, usedByCustomer: number }} ctx
 * @returns {{ amount: number } | { reason: string }}
 */
export function evaluateDiscount(d, ctx) {
  if (d.isActive === false) return { reason: "Switched off" };
  if (d.validFrom && ctx.now < Date.parse(`${d.validFrom}T00:00:00+05:00`)) return { reason: "Not valid yet" };
  if (d.validTo && ctx.now > Date.parse(`${d.validTo}T23:59:59+05:00`)) return { reason: "Expired" };
  if (d.scope === "customer" && d.customerId !== ctx.customerId) return { reason: "Not for this customer" };
  if (d.scope === "tier" && d.tier !== ctx.tier) return { reason: "Not for this membership tier" };
  if (d.scope === "segment" && !ctx.segments.includes(d.segment ?? "")) return { reason: "Not for this customer group" };
  if (d.scope !== "all" && !ctx.customerId) return { reason: "Needs a registered customer" };
  if (d.usageLimit && ctx.used >= d.usageLimit) return { reason: "Usage limit reached" };
  if (d.perCustomerLimit && ctx.usedByCustomer >= d.perCustomerLimit) return { reason: "This customer has used it the allowed number of times" };
  const restricted = (d.productIds?.length ?? 0) + (d.categoryIds?.length ?? 0) > 0;
  const base = ctx.lines.filter((l) => !restricted || d.productIds?.includes(l.productId) || (l.categoryId && d.categoryIds?.includes(l.categoryId))).reduce((n, l) => n + l.amount, 0);
  if (base <= 0) return { reason: "None of the items qualify" };
  if (d.minPurchase && ctx.lines.reduce((n, l) => n + l.amount, 0) < d.minPurchase) return { reason: "Below the minimum purchase" };
  const amount = d.type === "percent" ? Math.floor((base * d.value) / 100) : Math.min(d.value, base);
  return amount > 0 ? { amount } : { reason: "No saving" };
}

/** The single best eligible discount (customer discounts never stack with each other). @param {any[]} list @param {(d: any) => { amount: number } | { reason: string }} evaluate @returns {{ discount: any, amount: number } | null} */
export function bestDiscount(list, evaluate) {
  let best = null;
  for (const d of list) {
    const r = evaluate(d);
    if ("amount" in r && (!best || r.amount > best.amount)) best = { discount: d, amount: r.amount };
  }
  return best;
}
