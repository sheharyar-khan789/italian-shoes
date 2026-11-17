/**
 * CRM: POS customer lookup, quick create, hooks after a sale or a refund, the dashboard and the report tables. Every figure is read
 * from real records (customers, sales, loyalty, discount usage, notes); nothing is typed in or estimated. Customer statistics are
 * stored on each profile when it is refreshed (after a sale, when a profile is opened, or by "Recalculate"), so lists stay cheap.
 */
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { normalizePkMobile } from "../shared/phone.js";
import { pktDateKey } from "../shared/accounting.js";
import { percentOf } from "../shared/money.js";
import { SEGMENT_LABEL, NOTE_TYPES, CRM_DEFAULTS, redeemCheck } from "../shared/crm.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { getCrmSettings, saveCustomer, ensureProfileForUser, refreshCustomerStats, statsOf } from "./crm.js";
import { availablePoints, awardPointsForSale, reversePointsForRefund, readLots } from "./loyalty.js";
import { readDiscounts, pickDiscount } from "./crmDiscounts.js";
import { effectivePrice } from "./products.js";

const MAX_DOCS = 5000;
/** A document as a plain object with its id. @param {FirebaseFirestore.QueryDocumentSnapshot} d @returns {Record<string, any>} */
const row = (d) => ({ id: d.id, ...d.data() });
const col = (key, label, type = "text") => ({ key, label, type });
const table = (title, columns, rows, totals = null) => ({ title, columns, rows, totals });
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
const startOf = (k) => Timestamp.fromDate(new Date(`${k}T00:00:00+05:00`));
const endOf = (k) => Timestamp.fromDate(new Date(`${k}T23:59:59.999+05:00`));
const dayOf = (t) => (t?.toDate ? pktDateKey(t.toDate()) : t ? pktDateKey(new Date(t)) : "");
const iso = (t) => t?.toDate?.().toISOString() ?? null;

/** @typedef {{ uid: string, name: string }} Actor */

/* ───────── After a sale / a refund (called by the endpoints that cause them) ───────── */

/** Make sure an account holder has a profile, give loyalty points for a fully paid sale, and refresh the statistics. Never throws. @param {string} saleId */
export async function afterSale(saleId) {
  try {
    const sale = (await db.collection("sales").doc(saleId).get()).data();
    if (!sale?.customerId) return { status: "walk-in" };
    const profile = await db.collection("crmCustomers").doc(sale.customerId).get();
    if (!profile.exists) await ensureProfileForUser(sale.customerId, { uid: "system", name: "System" }).catch(() => null);
    const points = await awardPointsForSale({ saleId });
    const stats = await refreshCustomerStats(sale.customerId).catch(() => null);
    return { status: "ok", points, tier: stats?.tier ?? null };
  } catch (error) {
    return { status: "error", message: /** @type {Error} */ (error).message };
  }
}

/** Take back points after a refund, cancellation or return, and refresh the statistics. Never throws. @param {string} saleId */
export async function afterRefund(saleId) {
  try {
    const sale = (await db.collection("sales").doc(saleId).get()).data();
    if (!sale?.customerId) return { status: "walk-in" };
    const rev = await reversePointsForRefund({ saleId });
    await refreshCustomerStats(sale.customerId).catch(() => null);
    return { status: "ok", reversal: rev };
  } catch (error) {
    return { status: "error", message: /** @type {Error} */ (error).message };
  }
}

/* ───────── POS ───────── */

/** Find customers for the POS by phone, name, reference or email, with their loyalty balance. Account holders without a profile are given one. @param {{ q: string }} input @param {Actor} actor */
export async function crmLookup({ q }, actor) {
  const text = q.trim().toLowerCase();
  const phone = normalizePkMobile(q);
  const snap = await db.collection("crmCustomers").limit(2000).get();
  const rows = snap.docs.filter((d) => d.data().isActive !== false && (d.data().nameLower?.includes(text) || (d.data().reference ?? "").toLowerCase() === text || (d.data().email ?? "") === text || (phone && d.data().phone === phone))).slice(0, 8).map((d) => (row(d)));
  if (!rows.length) {
    const users = phone ? await db.collection("users").where("phone", "==", phone).limit(3).get() : text.includes("@") ? await db.collection("users").where("email", "==", text).limit(3).get() : null;
    for (const u of users?.docs ?? []) {
      const r = await ensureProfileForUser(u.id, actor);
      const p = await db.collection("crmCustomers").doc(r.id).get();
      if (p.exists && !rows.some((x) => x.id === r.id)) rows.push({ id: r.id, ...p.data() });
    }
  }
  const cfg = await getCrmSettings();
  const out = [];
  for (const c of rows) {
    const [lots, recent] = await Promise.all([db.collection("loyaltyLots").where("customerId", "==", c.id).limit(500).get(), db.collection("sales").where("customerId", "==", c.id).orderBy("createdAt", "desc").limit(5).get()]);
    const tier = cfg.tiers.find((t) => t.key === c.tier);
    out.push({ id: c.id, reference: c.reference, name: c.name, phone: c.phone, email: c.email ?? null, tier: c.tier ?? null, tierName: tier?.name ?? null, segments: c.segments ?? [], consent: c.consent ?? {}, stats: c.stats ? { orders: c.stats.orders, spent: c.stats.spent, lastAt: c.stats.lastAt } : null, loyaltyBalance: cfg.loyalty.enabled ? availablePoints(lots.docs.map((d) => (row(d)))) : null, recent: recent.docs.map((s) => ({ number: s.data().number, channel: s.data().channel, total: s.data().total, itemCount: s.data().itemCount, status: s.data().status, at: iso(s.data().createdAt) })) });
  }
  return { customers: out, loyalty: { enabled: cfg.loyalty.enabled, redeemValuePerPoint: cfg.loyalty.redeemValuePerPoint, minRedeemPoints: cfg.loyalty.minRedeemPoints, maxRedeemPercent: cfg.loyalty.maxRedeemPercent, maxRedeemPointsPerSale: cfg.loyalty.maxRedeemPointsPerSale } };
}

/** Create a customer from the POS (name and phone; marketing consent only if the customer agreed). @param {{ name: string, phone: string, whatsapp?: string, consentMarketing?: boolean }} input @param {Actor} actor */
export async function quickCreate({ name, phone, whatsapp = "", consentMarketing = false }, actor) {
  const r = await saveCustomer({ name, phone, whatsapp, email: "", address: "", city: "", customerType: "", tags: [], notes: "", dateOfBirth: "", consent: { marketing: consentMarketing, whatsapp: consentMarketing, sms: false, email: false } }, actor);
  return r;
}

/* ───────── Statistics for everyone ───────── */

/** Recalculate every customer's statistics from the sales records (one pass over the sales). @param {Actor} actor */
export async function refreshAllStats(actor) {
  const [cfg, profiles, salesSnap] = await Promise.all([getCrmSettings(), db.collection("crmCustomers").limit(2001).get(), db.collection("sales").limit(MAX_DOCS + 1).get()]);
  if (profiles.size > 2000) throw new AppError("failed-precondition", "There are more than 2,000 customers.");
  if (salesSnap.size > MAX_DOCS) throw new AppError("failed-precondition", `There are more than ${MAX_DOCS} sales; recalculate customers one at a time.`);
  const byCustomer = new Map();
  const byPhone = new Map();
  for (const d of salesSnap.docs) {
    const s = row(d);
    if (s.customerId) (byCustomer.get(s.customerId) ?? byCustomer.set(s.customerId, []).get(s.customerId)).push(s);
    if (s.customerPhone) (byPhone.get(s.customerPhone) ?? byPhone.set(s.customerPhone, []).get(s.customerPhone)).push(s);
  }
  let updated = 0;
  for (const p of profiles.docs) {
    const d = p.data();
    const mine = new Map();
    for (const s of byCustomer.get(p.id) ?? []) mine.set(s.id, s);
    if (d.userId) for (const s of byCustomer.get(d.userId) ?? []) mine.set(s.id, s);
    if (d.phone) for (const s of byPhone.get(d.phone) ?? []) mine.set(s.id, s);
    const st = statsOf([...mine.values()], cfg);
    await p.ref.update({ stats: { orders: st.orders, spent: st.spent, averageOrder: st.averageOrder, firstAt: st.firstAt, lastAt: st.lastAt, spentYear: st.spentYear, outstanding: st.outstanding, returns: st.returns, refunded: st.refunded }, segments: st.segments, tier: st.tier, statsAt: Timestamp.now() });
    updated += 1;
  }
  await writeAudit({ actorUid: actor.uid, action: "crm.stats_recalculated", entityType: "crm", entityId: "all", changes: { customers: updated } });
  return { customers: updated };
}

/* ───────── Dashboard ───────── */

export async function crmDashboard() {
  const [cfg, snap, lotSnap, notes, loyalty] = await Promise.all([getCrmSettings(), db.collection("crmCustomers").limit(2001).get(), db.collection("loyaltyLots").limit(MAX_DOCS + 1).get(), db.collection("crmNotes").orderBy("createdAt", "desc").limit(10).get(), db.collection("loyaltyTransactions").orderBy("at", "desc").limit(10).get()]);
  if (snap.size > 2000) throw new AppError("failed-precondition", "There are more than 2,000 customers.");
  /** @type {Record<string, any>[]} */
  const rows = snap.docs.map((d) => (row(d))).filter((c) => c.isActive !== false);
  const now = Date.now();
  const newCut = now - cfg.segments.newDays * 86400000;
  const seg = (k) => rows.filter((c) => (c.segments ?? []).includes(k)).length;
  const names = new Map(snap.docs.map((d) => [d.id, d.data().name]));
  const totalSpent = rows.reduce((n, c) => n + (c.stats?.spent ?? 0), 0);
  const totalOrders = rows.reduce((n, c) => n + (c.stats?.orders ?? 0), 0);
  const outstanding = lotSnap.size > MAX_DOCS ? null : lotSnap.docs.filter((d) => d.data().remaining > 0 && (!d.data().expiresAt || d.data().expiresAt.toMillis() > now)).reduce((n, d) => n + d.data().remaining, 0);
  return {
    total: rows.length,
    archived: snap.size - rows.length,
    newCustomers: rows.filter((c) => c.createdAt?.toMillis?.() >= newCut).length,
    returning: seg("returning"),
    vip: seg("vip"),
    highValue: seg("highValue"),
    inactive: seg("inactive"),
    regular: seg("regular"),
    totalSales: totalSpent,
    averageOrder: totalOrders ? Math.round(totalSpent / totalOrders) : 0,
    orders: totalOrders,
    loyaltyEnabled: cfg.loyalty.enabled,
    loyaltyOutstanding: outstanding,
    loyaltyValue: outstanding === null ? null : outstanding * cfg.loyalty.redeemValuePerPoint,
    topCustomers: [...rows].sort((a, b) => (b.stats?.spent ?? 0) - (a.stats?.spent ?? 0)).filter((c) => (c.stats?.spent ?? 0) > 0).slice(0, 10).map((c) => ({ id: c.id, name: c.name, reference: c.reference, spent: c.stats.spent, orders: c.stats.orders, tier: c.tier })),
    openComplaints: (await db.collection("crmNotes").where("type", "==", "complaint").where("status", "in", ["open", "in_progress"]).limit(500).get()).size,
    followUpsDue: (await db.collection("crmNotes").where("status", "==", "open").limit(500).get()).docs.filter((d) => d.data().followUpDate && d.data().followUpDate <= pktDateKey(new Date())).length,
    recentActivity: [...notes.docs.map((d) => ({ kind: NOTE_TYPES[d.data().type] ?? d.data().type, customer: d.data().customerName, text: d.data().text, at: iso(d.data().createdAt) })), ...loyalty.docs.map((d) => ({ kind: `Points ${d.data().type}`, customer: names.get(d.data().customerId) ?? "—", text: d.data().note, at: iso(d.data().at), points: d.data().points }))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12),
    statsNote: "Customer figures are as of each customer's last refresh (after a sale, when opened, or 'Recalculate').",
  };
}

/* ───────── Reports ───────── */

/** @returns {Promise<Record<string, any>[]>} */
async function inRange(collection, from, to, field = "createdAt") {
  const snap = await db.collection(collection).where(field, ">=", startOf(from)).where(field, "<=", endOf(to)).orderBy(field).limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", `That range has more than ${MAX_DOCS} records. Please choose a shorter range.`);
  return snap.docs.map((d) => (row(d)));
}

/** @param {{ report: string, from: string, to: string }} input */
export async function crmReport({ report, from, to }) {
  const money = "money";
  const num = "number";
  const cfg = await getCrmSettings();
  const profilesSnap = await db.collection("crmCustomers").limit(2001).get();
  /** @type {Record<string, any>[]} */
  const profiles = profilesSnap.docs.map((d) => (row(d)));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const byPhone = new Map(profiles.filter((p) => p.phone).map((p) => [p.phone, p]));
  const owner = (s) => byId.get(s.customerId) ?? (s.customerPhone ? byPhone.get(s.customerPhone) : null) ?? null;
  const tierName = (k) => cfg.tiers.find((t) => t.key === k)?.name ?? "";
  const segs = (c) => (c.segments ?? []).map((k) => SEGMENT_LABEL[k] ?? k).join(", ");
  const spentIn = (s) => Math.max(0, (s.total ?? 0) - (s.refundedTotal ?? 0));

  if (report === "directory") {
    const rows = profiles.sort((a, b) => a.nameLower.localeCompare(b.nameLower)).map((c) => ({ reference: c.reference, name: c.name, phone: c.phone, whatsapp: c.whatsapp, email: c.email, city: c.city, type: c.customerType, tier: tierName(c.tier), status: c.isActive === false ? "Archived" : "Active", joined: dayOf(c.createdAt), consent: c.consent?.marketing ? "Yes" : "No" }));
    return { title: "Customer directory", from, to, tables: [table("Customers", [col("reference", "Ref"), col("name", "Name"), col("phone", "Phone"), col("whatsapp", "WhatsApp"), col("email", "Email"), col("city", "City"), col("type", "Type"), col("tier", "Tier"), col("status", "Status"), col("joined", "Joined"), col("consent", "Marketing OK")], rows)], notes: ["Contact details are personal data: share this list only with people who need it."] };
  }
  if (report === "followups") {
    /** @type {Record<string, any>[]} */
    const notes = (await db.collection("crmNotes").where("status", "==", "open").limit(500).get()).docs.map((d) => (row(d))).filter((n) => n.followUpDate && n.followUpDate <= to).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
    return { title: "Follow-ups and open complaints due", from, to, tables: [table("Open items", [col("due", "Due"), col("customer", "Customer"), col("type", "Type"), col("text", "What"), col("by", "Added by")], notes.map((n) => ({ due: n.followUpDate, customer: n.customerName, type: NOTE_TYPES[n.type] ?? n.type, text: n.text, by: n.createdByName })))], notes: [] };
  }
  if (report === "birthdays") {
    const md = (d) => d.slice(5);
    const list = profiles.filter((c) => c.dateOfBirth && c.isActive !== false).filter((c) => (md(from) <= md(to) ? md(c.dateOfBirth) >= md(from) && md(c.dateOfBirth) <= md(to) : md(c.dateOfBirth) >= md(from) || md(c.dateOfBirth) <= md(to))).sort((a, b) => md(a.dateOfBirth).localeCompare(md(b.dateOfBirth)));
    return { title: "Birthdays", from, to, tables: [table("Birthdays in the period (only customers who chose to share their date of birth)", [col("birthday", "Birthday"), col("name", "Customer"), col("phone", "Phone"), col("consent", "OK to message")], list.map((c) => ({ birthday: md(c.dateOfBirth), name: c.name, phone: c.phone, consent: c.consent?.marketing ? "Yes" : "No" })))], notes: ["Nothing is sent automatically. Only contact customers who agreed to receive messages."] };
  }
  if (report === "segments") {
    const keys = Object.keys(SEGMENT_LABEL);
    const rows = keys.map((k) => ({ name: SEGMENT_LABEL[k], customers: profiles.filter((c) => c.isActive !== false && (c.segments ?? []).includes(k)).length, spent: profiles.filter((c) => c.isActive !== false && (c.segments ?? []).includes(k)).reduce((n, c) => n + (c.stats?.spent ?? 0), 0) }));
    const tiers = cfg.tiers.map((t) => ({ name: t.name, minimum: t.minAnnualSpend, customers: profiles.filter((c) => c.isActive !== false && c.tier === t.key).length }));
    const members = profiles.filter((c) => c.isActive !== false && (c.segments ?? []).length).map((c) => ({ name: c.name, segments: segs(c), tier: tierName(c.tier), orders: c.stats?.orders ?? 0, spent: c.stats?.spent ?? 0 }));
    return { title: "Customer segmentation report", from, to, tables: [table("Customer groups", [col("name", "Group"), col("customers", "Customers", num), col("spent", "Total spent", money)], rows), table("Membership tiers (spend in the last 12 months)", [col("name", "Tier"), col("minimum", "From", money), col("customers", "Customers", num)], tiers), table("Members", [col("name", "Customer"), col("segments", "Groups"), col("tier", "Tier"), col("orders", "Orders", num), col("spent", "Spent", money)], members)], notes: [`Groups use the thresholds in the CRM settings (new ${cfg.segments.newDays} days, VIP from Rs ${cfg.segments.vipSpend / 100}, inactive after ${cfg.segments.inactiveDays} days…). Statistics are as of each customer's last refresh.`] };
  }
  if (report === "inactive") {
    const rows = profiles.filter((c) => c.isActive !== false && (c.segments ?? []).includes("inactive")).map((c) => ({ name: c.name, phone: c.phone, last: dayOf(c.stats?.lastAt), days: c.stats?.lastAt ? Math.floor((Date.now() - c.stats.lastAt) / 86400000) : null, orders: c.stats?.orders ?? 0, spent: c.stats?.spent ?? 0, consent: c.consent?.marketing ? "Yes" : "No" })).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
    return { title: "Inactive customer report", from, to, tables: [table(`No purchase for ${cfg.segments.inactiveDays}+ days`, [col("name", "Customer"), col("phone", "Phone"), col("last", "Last purchase"), col("days", "Days ago", num), col("orders", "Orders", num), col("spent", "Spent", money), col("consent", "OK to message")], rows)], notes: [] };
  }
  if (report === "lifetime") {
    const rows = profiles.filter((c) => (c.stats?.orders ?? 0) > 0).map((c) => { const months = Math.max(1, Math.round(((c.stats.lastAt ?? 0) - (c.stats.firstAt ?? 0)) / (30 * 86400000)) + 1); return { name: c.name, orders: c.stats.orders, spent: c.stats.spent, average: c.stats.averageOrder, months, perMonth: Math.round(c.stats.spent / months), first: dayOf(c.stats.firstAt) }; }).sort((a, b) => b.spent - a.spent);
    return { title: "Customer lifetime value", from, to, tables: [table("Lifetime spend (net of refunds)", [col("name", "Customer"), col("first", "First purchase"), col("orders", "Orders", num), col("spent", "Lifetime value", money), col("average", "Average order", money), col("months", "Months active", num), col("perMonth", "Per month", money)], rows, { name: "Total", first: "", orders: sum(rows, "orders"), spent: sum(rows, "spent"), average: null, months: null, perMonth: null })], notes: [] };
  }
  if (report === "loyalty") {
    const lots = (await db.collection("loyaltyLots").limit(MAX_DOCS + 1).get()).docs.map((d) => d.data());
    const accounts = new Map((await db.collection("loyaltyAccounts").limit(2001).get()).docs.map((d) => [d.id, d.data()]));
    const now = Date.now();
    const rows = profiles.filter((c) => accounts.has(c.id)).map((c) => { const a = accounts.get(c.id); const bal = lots.filter((l) => l.customerId === c.id && l.remaining > 0 && (!l.expiresAt || l.expiresAt.toMillis() > now)).reduce((n, l) => n + l.remaining, 0); return { name: c.name, earned: a.earned ?? 0, redeemed: a.redeemed ?? 0, adjusted: a.adjusted ?? 0, reversed: a.reversed ?? 0, expired: a.expired ?? 0, balance: bal }; });
    const tx = (await inRange("loyaltyTransactions", from, to, "at")).map((t) => ({ date: dayOf(t.at), customer: byId.get(t.customerId)?.name ?? t.customerId, type: t.type, points: t.points, note: t.note ?? "" }));
    return { title: "Loyalty points report", from, to, tables: [table("Points by customer (all time)", [col("name", "Customer"), col("earned", "Earned", num), col("redeemed", "Redeemed", num), col("adjusted", "Adjusted", num), col("reversed", "Taken back", num), col("expired", "Expired", num), col("balance", "Available now", num)], rows, { name: "Total", earned: sum(rows, "earned"), redeemed: sum(rows, "redeemed"), adjusted: sum(rows, "adjusted"), reversed: sum(rows, "reversed"), expired: sum(rows, "expired"), balance: sum(rows, "balance") }), table("Points transactions in the period", [col("date", "Date"), col("customer", "Customer"), col("type", "Type"), col("points", "Points", num), col("note", "Note")], tx)], notes: [cfg.loyalty.enabled ? `Each point is worth Rs ${cfg.loyalty.redeemValuePerPoint / 100} when redeemed.` : "The loyalty programme is switched off."] };
  }
  if (report === "discounts") {
    const uses = (await inRange("crmDiscountUses", from, to, "at")).filter((u) => u.saleId);
    const names = new Map((await db.collection("crmDiscounts").limit(300).get()).docs.map((d) => [d.id, d.data().name]));
    /** @type {Map<string, any>} */ const by = new Map();
    for (const u of uses) { const r = by.get(u.discountId) ?? { name: names.get(u.discountId) ?? u.discountId, uses: 0, amount: 0 }; r.uses += 1; r.amount += u.amount; by.set(u.discountId, r); }
    const rows = [...by.values()].sort((a, b) => b.amount - a.amount);
    const detail = uses.map((u) => ({ date: dayOf(u.at), discount: names.get(u.discountId) ?? u.discountId, customer: byId.get(u.customerId)?.name ?? "", amount: u.amount }));
    return { title: "Discount usage report", from, to, tables: [table("By discount", [col("name", "Discount"), col("uses", "Times used", num), col("amount", "Total given", money)], rows, { name: "Total", uses: sum(rows, "uses"), amount: sum(rows, "amount") }), table("Each use", [col("date", "Date"), col("discount", "Discount"), col("customer", "Customer"), col("amount", "Amount", money)], detail)], notes: [] };
  }

  // Reports from the sales in the period.
  const sales = await inRange("sales", from, to);
  const keyOf = (s) => (owner(s) ? owner(s).id : s.customerId ? `acct:${s.customerId}` : s.customerPhone ? `phone:${s.customerPhone}` : null);
  const counted = sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status));
  /** @type {Map<string, any>} */ const by = new Map();
  for (const s of counted) {
    const k = keyOf(s);
    if (!k) continue;
    const o = owner(s);
    const r = by.get(k) ?? { name: o?.name ?? s.customer?.name ?? "Customer", phone: o?.phone ?? s.customerPhone ?? "", orders: 0, spent: 0, last: 0 };
    r.orders += 1;
    r.spent += spentIn(s);
    r.last = Math.max(r.last, s.createdAt?.toMillis?.() ?? 0);
    by.set(k, r);
  }
  const people = [...by.entries()].map(([id, r]) => ({ id, ...r, average: r.orders ? Math.round(r.spent / r.orders) : 0, lastDate: dayOf(r.last) })).sort((a, b) => b.spent - a.spent);
  const walkIns = counted.filter((s) => !keyOf(s));
  if (report === "purchases" || report === "top") {
    const list = report === "top" ? people.slice(0, 25) : people;
    return { title: report === "top" ? "Top customers report" : "Customer purchase report", from, to, tables: [table(report === "top" ? "Top 25 customers by spend" : "Purchases by customer", [col("name", "Customer"), col("phone", "Phone"), col("orders", "Orders", num), col("spent", "Spent (net of refunds)", money), col("average", "Average order", money), col("lastDate", "Last purchase")], list, { name: "Total", phone: "", orders: sum(list, "orders"), spent: sum(list, "spent"), average: null, lastDate: "" })], notes: [`${walkIns.length} sale(s) in this period were to walk-in customers with no profile or phone and are not listed.`] };
  }
  if (report === "retention") {
    const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) + 86400000;
    const prevFrom = pktDateKey(new Date(Date.parse(`${from}T00:00:00Z`) - span));
    const prevTo = pktDateKey(new Date(Date.parse(`${from}T00:00:00Z`) - 86400000));
    const prev = (await inRange("sales", prevFrom, prevTo)).filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status));
    const prevSet = new Set(prev.map(keyOf).filter(Boolean));
    const nowSet = new Set(people.map((p) => p.id));
    const retained = [...nowSet].filter((k) => prevSet.has(k)).length;
    const rows = [{ what: `Customers who bought ${prevFrom} to ${prevTo}`, n: prevSet.size }, { what: `Customers who bought ${from} to ${to}`, n: nowSet.size }, { what: "Bought in both periods (retained)", n: retained }, { what: "Bought before but not now (lost)", n: prevSet.size - retained }, { what: "New in this period", n: nowSet.size - retained }];
    return { title: "Customer retention report", from, to, tables: [table("Retention", [col("what", "Measure"), col("n", "Customers", num)], rows), table("Retention rate", [col("rate", "Retained ÷ earlier customers")], [{ rate: prevSet.size ? `${Math.round((retained / prevSet.size) * 100)}%` : "—" }])], notes: ["Compares the chosen period with the period of the same length just before it."] };
  }
  // returns
  const returned = sales.filter((s) => ["returned", "refunded"].includes(s.status) || (s.refundedTotal ?? 0) > 0);
  const rows = returned.map((s) => ({ date: dayOf(s.createdAt), number: s.number, customer: owner(s)?.name ?? s.customer?.name ?? "Walk-in", status: s.status, total: s.total, refunded: s.refundedTotal ?? 0, items: (s.lines ?? []).map((l) => `${l.qty} × ${l.productName}`).join("; ") }));
  return { title: "Customer returns report", from, to, tables: [table("Returned and refunded sales", [col("date", "Date"), col("number", "Sale"), col("customer", "Customer"), col("status", "Status"), col("total", "Sale total", money), col("refunded", "Refunded", money), col("items", "Items")], rows, { date: "Total", number: "", customer: "", status: "", total: sum(rows, "total"), refunded: sum(rows, "refunded"), items: "" })], notes: ["From the existing sales and payments records (there is no separate returns system)."] };
}

/* ───────── POS preview ───────── */

/**
 * What the till will be charged after a customer discount and loyalty points, worked out with the SAME rules the checkout uses.
 * It writes nothing and is only a preview: the checkout decides again inside its own transaction.
 * @param {{ customerId?: string | null, items: { productId: string, variantId: string, qty: number, unitPrice?: number }[], discount?: any, applyCustomerDiscount?: boolean, redeemPoints?: number }} input
 */
export async function posQuote({ customerId = null, items, discount = null, applyCustomerDiscount = false, redeemPoints = 0 }) {
  const [cfg, profile, prods] = await Promise.all([getCrmSettings(), customerId ? db.collection("crmCustomers").doc(customerId).get() : null, Promise.all(items.map(async (i) => {
    const p = db.collection("products").doc(i.productId);
    const [prod, variant] = await Promise.all([p.get(), p.collection("variants").doc(i.variantId).get()]);
    return { prod, variant };
  }))]);
  const lines = items.map((i, n) => {
    const v = prods[n].variant.exists ? prods[n].variant.data() : null;
    const price = Math.min(i.unitPrice ?? Infinity, v ? effectivePrice(v) : 0);
    return { productId: i.productId, categoryId: prods[n].prod.data()?.categoryId ?? null, amount: price * i.qty };
  });
  const subtotal = lines.reduce((n, l) => n + l.amount, 0);
  let discountTotal = discount ? Math.min(subtotal, discount.type === "percent" ? percentOf(subtotal, discount.value) : discount.value) : 0;
  const cd = profile?.exists ? profile.data() : null;
  /** @type {{ name: string, amount: number } | null} */
  let customerDiscount = null;
  /** @type {{ points: number, value: number } | null} */
  let redeem = null;
  let error = null;
  const { list, lots } = await db.runTransaction(async (tx) => ({ list: applyCustomerDiscount ? await readDiscounts(tx, cd ? customerId : null) : [], lots: cd && redeemPoints > 0 ? await readLots(tx, /** @type {string} */ (customerId)) : [] }));
  if (applyCustomerDiscount) {
    if (discount) error = "A customer discount can't be combined with a manual discount.";
    else {
      const tier = cd?.tier ? cfg.tiers.find((t) => t.key === cd.tier) : null;
      const candidates = [...list, ...(tier && tier.discountPercent > 0 ? [{ id: `tier__${tier.key}`, name: `${tier.name} member discount`, scope: "all", type: "percent", value: tier.discountPercent, isActive: true, used: 0, usedByCustomer: 0 }] : [])];
      const best = pickDiscount(candidates, { customerId: cd ? customerId : null, tier: cd?.tier ?? null, segments: cd?.segments ?? [], lines });
      if (best) {
        customerDiscount = { name: best.discount.name, amount: best.amount };
        discountTotal += best.amount;
      }
    }
  }
  if (redeemPoints > 0 && !error) {
    if (!cd) error = "Points can only be redeemed by a customer with a profile.";
    else {
      const chk = redeemCheck({ requested: redeemPoints, balance: availablePoints(lots), payable: subtotal - discountTotal }, { ...CRM_DEFAULTS.loyalty, ...cfg.loyalty });
      if ("error" in chk) error = chk.error;
      else {
        redeem = { points: chk.points, value: chk.value };
        discountTotal += chk.value;
      }
    }
  }
  return { subtotal, manualDiscount: subtotal && discount ? Math.min(subtotal, discount.type === "percent" ? percentOf(subtotal, discount.value) : discount.value) : 0, customerDiscount, redeem, error, payableBeforeTax: Math.max(0, subtotal - discountTotal) };
}
