/**
 * CRM customer profiles, purchase history, groups (segments), membership tiers, notes / complaints / follow-ups and settings.
 * Reuses what exists: a customer's purchases and payments are READ from the real sales and payments records (sales are matched
 * by customer id, or by phone for walk-in customers); account holders keep their account in `users`, the profile links to it.
 *
 *   crmCustomers/{id}   CUST-000001 … profile (id = the account uid for account holders, so sales and receivables keep using it)
 *   crmKeys/{kind_value} one document per phone / email: this is what prevents duplicate customers (created in the same transaction)
 *   crmNotes/{id}       notes, calls, WhatsApp chats, feedback, complaints (with status + resolution) and follow-ups
 *   crmSettings/main    customer types, group thresholds, membership tiers, loyalty settings (the owner's; defaults only until saved)
 *
 * Nothing here sends a message: the WhatsApp button just opens the staff member's own WhatsApp. Marketing needs the customer's consent.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { normalizePkMobile } from "../shared/phone.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { CRM_DEFAULTS, computeSegments, tierFor, NOTE_TYPES } from "../shared/crm.js";

const customers = () => db.collection("crmCustomers");
const settingsRef = () => db.collection("crmSettings").doc("main");
const keyRef = (kind, value) => db.collection("crmKeys").doc(`${kind}_${String(value).replace(/[^a-zA-Z0-9@._+-]/g, "_")}`);
const SCAN = 2000;
const DAY = 86400000;
const iso = (t) => t?.toDate?.().toISOString() ?? null;
/** @param {any[]} list @returns {Record<string, any>[]} */
const plain = (list) => list;

/** @typedef {{ uid: string, name: string }} Actor */

/* ───────── Settings ───────── */

export async function getCrmSettings() {
  const s = await settingsRef().get();
  const d = s.exists ? s.data() : {};
  return { customerTypes: d.customerTypes ?? CRM_DEFAULTS.customerTypes, segments: { ...CRM_DEFAULTS.segments, ...(d.segments ?? {}) }, tiers: d.tiers ?? CRM_DEFAULTS.tiers, loyalty: { ...CRM_DEFAULTS.loyalty, ...(d.loyalty ?? {}) }, saved: s.exists };
}

/** @param {Record<string, any>} input validated crmSettingsInput @param {Actor} actor */
export async function saveCrmSettings(input, actor) {
  await settingsRef().set({ ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
  await writeAudit({ actorUid: actor.uid, action: "crm.settings_updated", entityType: "crmSettings", entityId: "main", changes: { loyaltyEnabled: input.loyalty.enabled, tiers: input.tiers.length } });
  return getCrmSettings();
}

/* ───────── Profiles ───────── */

const view = (id, c) => ({ id, ...c, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt), statsAt: iso(c.statsAt) });

/** @param {string} value */
function phoneOf(value, field = "phone") {
  if (!value || !String(value).trim()) return "";
  const p = normalizePkMobile(String(value));
  if (!p) throw new AppError("invalid-argument", "Enter a valid Pakistani mobile number, for example 0300 1234567.", { fields: { [field]: "Not a valid mobile number" } });
  return p;
}

/**
 * Create or edit a customer. A phone number or email can belong to one customer only (checked in the same transaction).
 * @param {Record<string, any>} input validated saveCrmCustomerInput @param {Actor} actor @param {{ id?: string }} [opts] fixed id for account holders
 */
export async function saveCustomer(input, actor, { id: fixedId } = {}) {
  const id = input.id ?? fixedId;
  const phone = phoneOf(input.phone);
  const whatsapp = phoneOf(input.whatsapp, "whatsapp");
  const email = String(input.email ?? "").trim().toLowerCase();
  const settings = await getCrmSettings();
  if (input.customerType && !settings.customerTypes.includes(input.customerType)) throw new AppError("invalid-argument", "Choose one of the customer types set up in the CRM settings.", { fields: { customerType: "Not a known type" } });
  const ref = id ? customers().doc(id) : customers().doc();
  const counterRef = db.collection("counters").doc("crmCustomers");
  return db.runTransaction(async (tx) => {
    const [current, phoneKey, emailKey, counter] = await Promise.all([tx.get(ref), phone ? tx.get(keyRef("phone", phone)) : null, email ? tx.get(keyRef("email", email)) : null, tx.get(counterRef)]);
    if (input.id && !current.exists) throw new AppError("not-found", "That customer doesn't exist.");
    for (const [snap, field, label] of /** @type {[any, string, string][]} */ ([[phoneKey, "phone", "phone number"], [emailKey, "email", "email"]])) {
      if (snap?.exists && snap.data().customerId !== ref.id) {
        const other = await tx.get(customers().doc(snap.data().customerId));
        throw new AppError("already-exists", `A customer with this ${label} already exists: ${other.data()?.name ?? "another customer"} (${other.data()?.reference ?? ""}).`, { fields: { [field]: "Already a customer" }, existingId: snap.data().customerId });
      }
    }
    const old = current.exists ? current.data() : null;
    const body = { name: input.name.trim(), nameLower: input.name.trim().toLowerCase(), phone, whatsapp, email, address: input.address, city: input.city, customerType: input.customerType, tags: [...new Set(input.tags)], notes: input.notes, dateOfBirth: input.dateOfBirth, consent: { ...input.consent, updatedAt: old && JSON.stringify(old.consent ?? {}) === JSON.stringify({ ...input.consent, updatedAt: old.consent?.updatedAt }) ? old.consent?.updatedAt ?? null : new Date().toISOString() }, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
    if (old) {
      tx.update(ref, body);
      if (old.phone && old.phone !== phone) tx.delete(keyRef("phone", old.phone));
      if (old.email && old.email !== email) tx.delete(keyRef("email", old.email));
    } else {
      const seq = (counter.exists ? counter.data().next : 1) ?? 1;
      tx.set(counterRef, { next: seq + 1 });
      tx.create(ref, { ...body, reference: `CUST-${String(seq).padStart(6, "0")}`, status: "active", isActive: true, userId: fixedId ?? null, segments: [], tier: null, stats: null, createdAt: FieldValue.serverTimestamp(), createdBy: actor.uid });
    }
    if (phone) tx.set(keyRef("phone", phone), { customerId: ref.id });
    if (email) tx.set(keyRef("email", email), { customerId: ref.id });
    writeAudit({ actorUid: actor.uid, action: old ? "crm.customer_updated" : "crm.customer_created", entityType: "crmCustomer", entityId: ref.id, changes: { name: body.name, phone, email, consentChanged: !old || JSON.stringify(old.consent ?? {}) !== JSON.stringify(body.consent) } }, tx);
    return { id: ref.id, reference: old?.reference ?? `CUST-${String((counter.exists ? counter.data().next : 1) ?? 1).padStart(6, "0")}` };
  });
}

/** Archive or restore a customer. Their history, loyalty points and receivables stay. @param {{ id: string, isActive: boolean }} input @param {Actor} actor */
export async function setCustomerActive({ id, isActive }, actor) {
  const ref = customers().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That customer doesn't exist.");
  await ref.update({ isActive, status: isActive ? "active" : "archived", updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
  await writeAudit({ actorUid: actor.uid, action: isActive ? "crm.customer_restored" : "crm.customer_archived", entityType: "crmCustomer", entityId: id, changes: {} });
  return { id, isActive };
}

/** A customer with a website account gets a CRM profile (id = uid) the first time they are needed. Links an existing walk-in profile with the same phone instead of duplicating it. @param {string} uid @param {Actor} actor */
export async function ensureProfileForUser(uid, actor) {
  const existing = await customers().doc(uid).get();
  if (existing.exists) return { id: uid, created: false };
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) throw new AppError("not-found", "That customer doesn't exist.");
  const u = user.data();
  const phone = normalizePkMobile(u.phone ?? "") || "";
  if (phone) {
    const key = await keyRef("phone", phone).get();
    if (key.exists) {
      await customers().doc(key.data().customerId).update({ userId: uid, updatedAt: FieldValue.serverTimestamp() });
      return { id: key.data().customerId, created: false, linked: true };
    }
  }
  try {
    await saveCustomer({ name: u.name || u.email || "Customer", phone: phone || "", whatsapp: "", email: u.email ?? "", address: "", city: "", customerType: "", tags: [], notes: "", dateOfBirth: "", consent: { marketing: false, whatsapp: false, sms: false, email: false } }, actor, { id: uid });
  } catch (e) {
    if (/** @type {any} */ (e)?.details?.existingId) {
      await customers().doc(e.details.existingId).update({ userId: uid });
      return { id: e.details.existingId, created: false, linked: true };
    }
    throw e;
  }
  return { id: uid, created: true };
}

/* ───────── Purchase history and statistics ───────── */

/** Every counted/uncounted sale of one customer: by customer id, plus walk-in sales with the same phone. @returns {Promise<Record<string, any>[]>} */
export async function salesOf(profile) {
  const queries = [db.collection("sales").where("customerId", "==", profile.id).limit(1000).get()];
  if (profile.userId && profile.userId !== profile.id) queries.push(db.collection("sales").where("customerId", "==", profile.userId).limit(1000).get());
  if (profile.phone) queries.push(db.collection("sales").where("customerPhone", "==", profile.phone).limit(500).get());
  const snaps = await Promise.all(queries);
  const byId = new Map();
  for (const s of snaps) for (const d of s.docs) byId.set(d.id, { id: d.id, ...d.data() });
  return [...byId.values()].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

/** Purchase statistics from real sales. Cancelled, returned and refunded sales aren't counted; part refunds reduce what was spent. @param {Record<string, any>[]} sales @param {ReturnType<typeof getCrmSettings> extends Promise<infer S> ? S : never} cfg @param {number} [now] */
export function statsOf(sales, cfg, now = Date.now()) {
  const counted = sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status));
  const at = (s) => s.createdAt?.toMillis?.() ?? 0;
  const spent = counted.reduce((n, s) => n + Math.max(0, (s.total ?? 0) - (s.refundedTotal ?? 0)), 0);
  const times = counted.map(at).filter(Boolean);
  const windowStart = now - cfg.segments.regularDays * DAY;
  const base = {
    orders: counted.length,
    spent,
    averageOrder: counted.length ? Math.round(spent / counted.length) : 0,
    firstAt: times.length ? Math.min(...times) : null,
    lastAt: times.length ? Math.max(...times) : null,
    ordersInWindow: counted.filter((s) => at(s) >= windowStart).length,
    spentYear: counted.filter((s) => at(s) >= now - 365 * DAY).reduce((n, s) => n + Math.max(0, (s.total ?? 0) - (s.refundedTotal ?? 0)), 0),
    outstanding: sales.filter((s) => !["cancelled"].includes(s.status)).reduce((n, s) => n + Math.max(0, s.amountDue ?? 0), 0),
    returns: sales.filter((s) => ["returned", "refunded"].includes(s.status) || (s.refundedTotal ?? 0) > 0).length,
    refunded: sales.reduce((n, s) => n + (s.refundedTotal ?? 0), 0),
  };
  const segments = computeSegments(base, cfg.segments, now);
  const tier = tierFor(base.spentYear, cfg.tiers);
  return { ...base, segments, tier: tier?.key ?? null };
}

/** Recalculate and save a customer's statistics, groups and membership tier (also called after a sale). @param {string} id */
export async function refreshCustomerStats(id) {
  const snap = await customers().doc(id).get();
  if (!snap.exists) return null;
  /** @type {Record<string, any>} */
  const profile = { id, ...snap.data() };
  const [cfg, sales] = await Promise.all([getCrmSettings(), salesOf(profile)]);
  const st = statsOf(sales, cfg);
  const changedTier = (profile.tier ?? null) !== st.tier;
  await snap.ref.update({ stats: { orders: st.orders, spent: st.spent, averageOrder: st.averageOrder, firstAt: st.firstAt, lastAt: st.lastAt, spentYear: st.spentYear, outstanding: st.outstanding, returns: st.returns, refunded: st.refunded }, segments: st.segments, tier: st.tier, ...(changedTier ? { tierChangedAt: FieldValue.serverTimestamp() } : {}), statsAt: FieldValue.serverTimestamp() });
  if (changedTier) await writeAudit({ actorUid: null, action: "crm.tier_changed", entityType: "crmCustomer", entityId: id, changes: { from: profile.tier ?? null, to: st.tier, annualSpend: st.spentYear } });
  return { ...st, tierChanged: changedTier, previousTier: profile.tier ?? null };
}

/** The full profile: details, statistics, purchased products / sizes / colours, returns, refunds, payments, loyalty and notes. @param {{ id: string }} input */
export async function customerProfile({ id }) {
  const snap = await customers().doc(id).get();
  if (!snap.exists) throw new AppError("not-found", "That customer doesn't exist.");
  const profile = { id, ...snap.data() };
  const [cfg, sales, notes] = await Promise.all([getCrmSettings(), salesOf(profile), db.collection("crmNotes").where("customerId", "==", id).limit(100).get()]);
  const st = statsOf(sales, cfg);
  const counted = sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status));
  /** @type {Map<string, any>} */ const products = new Map();
  const sizes = {};
  const colours = {};
  for (const s of counted) for (const l of s.lines ?? []) {
    const p = products.get(l.productId) ?? { productId: l.productId, name: l.productName, qty: 0, amount: 0 };
    p.qty += l.qty;
    p.amount += l.lineTotal ?? 0;
    products.set(l.productId, p);
    if (l.sizeLabel) sizes[l.sizeLabel] = (sizes[l.sizeLabel] ?? 0) + l.qty;
    if (l.colorName) colours[l.colorName] = (colours[l.colorName] ?? 0) + l.qty;
  }
  const recent = sales.slice(0, 10);
  const payments = (await Promise.all(recent.map(async (s) => (await db.collection(`payments/${s.id}/transactions`).orderBy("at").limit(10).get()).docs.map((d) => ({ saleNumber: s.number, type: d.data().type, method: d.data().method, amount: d.data().amount, reference: d.data().reference ?? "", at: iso(d.data().at) }))))).flat().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 25);
  const tier = cfg.tiers.find((t) => t.key === st.tier) ?? null;
  return {
    profile: view(id, profile),
    stats: { ...st, tierName: tier?.name ?? null },
    topProducts: [...products.values()].sort((a, b) => b.qty - a.qty).slice(0, 10),
    sizes,
    colours,
    sales: sales.slice(0, 25).map((s) => ({ id: s.id, number: s.number, channel: s.channel, status: s.status, total: s.total, paidTotal: s.paidTotal, amountDue: s.amountDue, refundedTotal: s.refundedTotal ?? 0, itemCount: s.itemCount, at: iso(s.createdAt), loyalty: s.loyalty ?? null, crmDiscount: s.crmDiscount ?? null })),
    returns: sales.filter((s) => ["returned", "refunded"].includes(s.status) || (s.refundedTotal ?? 0) > 0).map((s) => ({ id: s.id, number: s.number, status: s.status, refundedTotal: s.refundedTotal ?? 0, total: s.total, at: iso(s.createdAt), lines: (s.lines ?? []).map((l) => `${l.qty} × ${l.productName} (${l.colorName} / ${l.sizeLabel})`) })),
    payments,
    notes: notes.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };
}

/* ───────── Search / list ───────── */

/** @param {Record<string, any>} input validated crmListInput */
export async function listCustomers({ q = "", status = "active", segment = "", tier = "", tag = "", type = "", sort = "name", limit = 50, offset = 0 }) {
  const snap = await customers().limit(SCAN + 1).get();
  if (snap.size > SCAN) throw new AppError("failed-precondition", `There are more than ${SCAN} customers; narrow the search.`);
  const text = q.trim().toLowerCase();
  const digits = text.replace(/\D/g, "");
  const phoneQ = digits.length >= 4 ? (normalizePkMobile(q) || digits) : "";
  let rows = snap.docs.map((d) => view(d.id, d.data()));
  rows = rows.filter((c) => (status === "all" || (status === "archived" ? c.isActive === false : c.isActive !== false)) && (!segment || (c.segments ?? []).includes(segment)) && (!tier || c.tier === tier) && (!tag || (c.tags ?? []).includes(tag)) && (!type || c.customerType === type) && (!text || c.nameLower?.includes(text) || (c.reference ?? "").toLowerCase() === text || (c.email ?? "").includes(text) || (phoneQ && (c.phone ?? "").replace(/\D/g, "").includes(phoneQ.replace(/\D/g, "")))));
  const by = { name: (a, b) => a.nameLower.localeCompare(b.nameLower), newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)), spent: (a, b) => (b.stats?.spent ?? 0) - (a.stats?.spent ?? 0), orders: (a, b) => (b.stats?.orders ?? 0) - (a.stats?.orders ?? 0), last: (a, b) => (b.stats?.lastAt ?? 0) - (a.stats?.lastAt ?? 0) }[sort];
  rows.sort(by);
  return { total: rows.length, customers: rows.slice(offset, offset + limit).map(({ notes: _n, ...c }) => c) };
}

/* ───────── Notes, complaints and follow-ups ───────── */

/** @param {Record<string, any>} input validated crmNoteInput @param {Actor} actor */
export async function addNote({ customerId, type, text, followUpDate = "", relatedSaleId = null, rating = null, warranty = "" }, actor) {
  const c = await customers().doc(customerId).get();
  if (!c.exists) throw new AppError("not-found", "That customer doesn't exist.");
  if (type === "feedback" && rating === null) rating = null;
  const open = ["complaint", "followup"].includes(type);
  const ref = db.collection("crmNotes").doc();
  await ref.create({ customerId, customerName: c.data().name, type, typeLabel: NOTE_TYPES[type], text, followUpDate, relatedSaleId, rating, warranty, status: open ? "open" : "closed", resolution: "", createdBy: actor.uid, createdByName: actor.name, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: `crm.${type}_added`, entityType: "crmNote", entityId: ref.id, changes: { customerId, type } });
  return { id: ref.id };
}

/** Move a complaint or follow-up along and record how it was resolved. @param {{ id: string, status: string, resolution?: string }} input @param {Actor} actor */
export async function updateNote({ id, status, resolution = "" }, actor) {
  const ref = db.collection("crmNotes").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That record doesn't exist.");
  if (["resolved", "closed"].includes(status) && snap.data().type === "complaint" && resolution.trim().length < 3) throw new AppError("invalid-argument", "Write how the complaint was resolved.", { fields: { resolution: "Required" } });
  await ref.update({ status, resolution, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid, ...(["resolved", "closed"].includes(status) ? { resolvedAt: FieldValue.serverTimestamp(), resolvedBy: actor.uid } : {}) });
  await writeAudit({ actorUid: actor.uid, action: "crm.note_updated", entityType: "crmNote", entityId: id, changes: { status } });
  return { id, status };
}

/** @param {Record<string, any>} input validated crmNotesListInput */
export async function listNotes({ customerId, type, status, dueBy, limit = 50 }) {
  let q = db.collection("crmNotes").orderBy("createdAt", "desc");
  if (customerId) q = db.collection("crmNotes").where("customerId", "==", customerId).orderBy("createdAt", "desc");
  const snap = await q.limit(500).get();
  const rows = plain(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }))).filter((n) => (!type || n.type === type) && (!status || n.status === status) && (!dueBy || (n.followUpDate && n.followUpDate <= dueBy && n.status === "open")));
  return { notes: rows.slice(0, limit) };
}


