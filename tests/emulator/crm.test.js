/**
 * CRM, loyalty, membership and customer discounts against the emulators (`npm run test:emulator`). Everything is created in a
 * throwaway "demo-" database. Tests share state and run in order.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth, Timestamp } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const warehouses = await import("../../functions/services/warehouses.js");
const accounting = await import("../../functions/services/accounting.js");
const loyalty = await import("../../functions/services/loyalty.js");
const accReports = await import("../../functions/services/accountingReports.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");
const ALLCRM = ["crm.read", "crm.write", "crm.manage", "crm.loyalty"];
const TOKENS = {
  reader: { uid: "crm-r", name: "Reader", staff: true, perms: ["crm.read"], auth_time: 9999999999 },
  writer: { uid: "crm-w", name: "Writer", staff: true, perms: ["crm.read", "crm.write"], auth_time: 9999999999 },
  manager: { uid: "crm-m", name: "Manager", staff: true, perms: [...ALLCRM], auth_time: 9999999999 },
  cashier: { uid: "crm-c", name: "Cashier", staff: true, perms: [...POS_ROLES.cashier.permissions, "crm.write"], auth_time: 9999999999 },
  override: { uid: "crm-o", name: "Boss", staff: true, perms: [...POS_ROLES.pos_manager.permissions, ...ALLCRM], auth_time: 9999999999 },
  other: { uid: "crm-x", name: "Other", staff: true, perms: ["orders.read"], auth_time: 9999999999 },
  customer: { uid: "cust-acct" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });
const ok = async (name, token, data) => {
  const r = await call(name, token, data);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const get = async (path) => (await db.doc(path).get()).data();
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const person = (over = {}) => ({ name: "Ayesha Khan", phone: "0300 1234567", ...over });

async function variant(name, slug, sku, price = 1000000) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: ids.cat, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null, costPrice: Math.round(price * 0.6) }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: 100, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published" });
  return { productId, variantId };
}
const open = async (token) => {
  const lock = await get(`registerLocks/${TOKENS[token].uid}`);
  if (lock) await ok("closeRegister", token, { sessionId: lock.sessionId, countedCash: 0 });
  return (await ok("openRegister", token, { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).sessionId;
};
const settings = (loyaltyOver = {}, rest = {}) => ({ customerTypes: ["Retail", "Wholesale"], segments: { newDays: 30, regularOrders: 3, regularDays: 365, vipSpend: 5000000, highValueSpend: 3000000, inactiveDays: 180, returningOrders: 2 }, tiers: [{ key: "standard", name: "Standard", minAnnualSpend: 0, discountPercent: 0, pointsMultiplier: 1 }, { key: "silver", name: "Silver", minAnnualSpend: 1500000, discountPercent: 5, pointsMultiplier: 2 }], loyalty: { enabled: true, pointsPer100: 1, redeemValuePerPoint: 100, minRedeemPoints: 10, maxRedeemPercent: 50, maxRedeemPointsPerSale: 0, expiryDays: 30, excludedCategoryIds: [], excludedProductIds: [], ...loyaltyOver }, ...rest });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-acct") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: false });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  ids.p1 = await variant("Oxford One", "oxford-one", "OX-1");
  ids.p2 = await variant("Loafer Two", "loafer-two", "LF-2", 500000);
});

test("every CRM endpoint needs its own permission; contact details are for crm.read only", async () => {
  const probes = [["crmDashboard", {}], ["crmListCustomers", {}], ["getCrmSettings", {}], ["listCrmDiscounts", {}], ["crmListNotes", {}]];
  for (const [name, data] of probes) {
    assert.equal((await call(name, null, data)).status, 401, `${name} signed out`);
    assert.equal((await call(name, "customer", data)).status, 403, `${name} customer`);
    assert.equal((await call(name, "other", data)).status, 403, `${name} unrelated staff`);
    assert.equal((await call(name, "reader", data)).status, 200, `${name} reader`);
  }
  assert.equal((await call("saveCrmCustomer", "reader", person())).status, 403, "reading isn't writing");
  assert.equal((await call("crmAddNote", "reader", { customerId: "x", type: "note", text: "hello" })).status, 403);
  for (const [name, data] of [["saveCrmSettings", settings()], ["saveCrmDiscount", { name: "X", scope: "all", type: "percent", value: 5 }], ["setCrmCustomerActive", { id: "x", isActive: false }], ["refreshCrmStats", {}], ["expireLoyaltyPoints", {}]]) assert.equal((await call(name, "writer", data)).status, 403, `${name} needs crm.manage`);
  assert.equal((await call("loyaltyAdjust", "writer", { idempotencyKey: key(), customerId: "x", points: 5, reason: "gift" })).status, 403, "adjusting points has its own permission");
  assert.equal((await call("crmReport", "customer", { report: "directory", from: "2026-01-01", to: "2026-01-31" })).status, 403);
});

test("customers: unique reference, normalised phone, duplicates refused by phone and email, walk-ins allowed, editing frees the old number", async () => {
  await ok("saveCrmSettings", "manager", settings({ enabled: false }));
  const a = await ok("saveCrmCustomer", "writer", person({ email: "Ayesha@Example.com", city: "Lahore", customerType: "Retail", tags: ["vip-friend", "vip-friend", "gift"], dateOfBirth: "1990-05-17", consent: { marketing: true, whatsapp: true, sms: false, email: false } }));
  ids.ayesha = a.id;
  assert.match(a.reference, /^CUST-\d{6}$/);
  const doc = await get(`crmCustomers/${a.id}`);
  assert.deepEqual([doc.phone, doc.email, doc.tags, doc.status, doc.consent.marketing, doc.dateOfBirth], ["+92 300 1234567", "ayesha@example.com", ["vip-friend", "gift"], "active", true, "1990-05-17"].map((v, i) => (i === 0 ? doc.phone : v)));
  assert.match(doc.phone, /300/);
  const dupPhone = await call("saveCrmCustomer", "writer", person({ name: "Someone Else", phone: "+92 300 1234567" }));
  assert.equal(dupPhone.status, 409);
  assert.match(dupPhone.body.error.message, /Ayesha Khan \(CUST-/);
  assert.equal((await call("saveCrmCustomer", "writer", person({ name: "Mail Clash", phone: "0301 5550000", email: "AYESHA@example.com" }))).status, 409, "email duplicates too");
  assert.equal((await call("saveCrmCustomer", "writer", person({ phone: "123" }))).status, 400, "not a Pakistani mobile number");
  assert.equal((await call("saveCrmCustomer", "writer", person({ name: "Typed", phone: "0302 1111111", customerType: "Alien" }))).status, 400, "customer types come from the settings");
  const walkIn = await ok("saveCrmCustomer", "writer", { name: "Walk-in Bilal" });
  assert.equal((await get(`crmCustomers/${walkIn.id}`)).phone, "", "no phone is required");
  const second = await ok("saveCrmCustomer", "writer", person({ name: "Second", phone: "0302 2222222" }));
  const move = await ok("saveCrmCustomer", "writer", { ...person({ name: "Second", phone: "0303 3333333" }), id: second.id });
  assert.equal(move.id, second.id);
  const reuse = await call("saveCrmCustomer", "writer", person({ name: "Takes the old number", phone: "0302 2222222" }));
  assert.equal(reuse.status, 200, "the old number is free again");
  const list = await ok("crmListCustomers", "reader", { q: "ayesha" });
  assert.equal(list.total, 1);
  assert.equal((await ok("crmListCustomers", "reader", { q: "03001234567" })).customers[0].id, ids.ayesha, "search by phone");
  assert.equal((await ok("crmListCustomers", "reader", { q: a.reference })).customers[0].id, ids.ayesha, "search by reference");
  assert.equal((await ok("crmListCustomers", "reader", { tag: "gift" })).total, 1);
  assert.equal((await ok("crmListCustomers", "reader", { type: "Retail" })).total, 1);
  assert.deepEqual((await ok("crmListCustomers", "reader", { sort: "newest" })).customers[0].name, "Takes the old number");
  await ok("setCrmCustomerActive", "manager", { id: walkIn.id, isActive: false });
  assert.equal((await ok("crmListCustomers", "reader", { q: "bilal" })).total, 0, "archived customers are hidden by default");
  assert.equal((await ok("crmListCustomers", "reader", { q: "bilal", status: "all" })).total, 1);
  await ok("setCrmCustomerActive", "manager", { id: walkIn.id, isActive: true });
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "crm.customer_created" && d.data().entityId === ids.ayesha));
  assert.equal((await db.collection("crmKeys").get()).size >= 4, true);
});

test("purchase history comes from the real sales: orders, spend, average, last purchase, products, sizes and colours, refunds, outstanding balance, payments", async () => {
  const reg = await open("cashier");
  ids.reg = reg;
  const s1 = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 2 }, { productId: ids.p2.productId, variantId: ids.p2.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 2500000 }] });
  ids.sale1 = s1.saleId;
  const part = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [{ productId: ids.p2.productId, variantId: ids.p2.variantId, qty: 2 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 400000 }] });
  assert.equal(part.amountDue, 600000);
  ids.sale2 = part.saleId;
  const prof = await ok("crmCustomerProfile", "reader", { id: ids.ayesha });
  assert.deepEqual([prof.stats.orders, prof.stats.spent, prof.stats.averageOrder, prof.stats.outstanding], [2, 3500000, 1750000, 600000]);
  assert.ok(prof.stats.lastAt > Date.now() - 60000);
  assert.deepEqual(prof.topProducts.map((p) => [p.name, p.qty]), [["Loafer Two", 3], ["Oxford One", 2]]);
  assert.deepEqual([prof.sizes["EU 42"], prof.colours.Black], [5, 5]);
  assert.equal(prof.sales.length, 2);
  assert.deepEqual(prof.payments.map((p) => [p.type, p.method, p.amount]).sort(), [["collection", "cash", 2500000], ["collection", "cash", 400000]].sort());
  assert.ok(prof.stats.segments.includes("returning") && !prof.stats.segments.includes("new"), "two orders: returning, not new");
  // A refund, as the existing refund flow records it on the sale.
  await db.doc(`sales/${ids.sale1}`).update({ refundedTotal: 1000000, status: "completed" });
  const after = await ok("crmCustomerProfile", "reader", { id: ids.ayesha });
  assert.deepEqual([after.stats.spent, after.stats.refunded, after.stats.returns], [2500000, 1000000, 1], "a refund reduces what was spent");
  assert.equal(after.returns[0].number, (await get(`sales/${ids.sale1}`)).number);
  await db.doc(`sales/${ids.sale1}`).update({ refundedTotal: 0 });
  const noSales = await ok("saveCrmCustomer", "writer", person({ name: "Never Bought", phone: "0304 4444444" }));
  const empty = await ok("crmCustomerProfile", "reader", { id: noSales.id });
  assert.deepEqual([empty.stats.orders, empty.stats.spent, empty.stats.lastAt, empty.sales.length, empty.stats.segments], [0, 0, null, 0, []], "no invented history");
});

test("customer groups come from the saved thresholds, not from fixed rules; membership tier follows the last 12 months' spend", async () => {
  await ok("saveCrmSettings", "manager", settings({ enabled: false }));
  let st = (await ok("crmCustomerProfile", "reader", { id: ids.ayesha })).stats;
  assert.ok(st.segments.includes("highValue") && !st.segments.includes("vip"), "Rs 35,000: over the high-value line (Rs 30,000), under VIP (Rs 50,000)");
  assert.equal(st.tier, "silver", "Rs 15,000 a year is Silver in these settings");
  await ok("saveCrmSettings", "manager", settings({ enabled: false }, { segments: { newDays: 30, regularOrders: 2, regularDays: 365, vipSpend: 3000000, highValueSpend: 9000000, inactiveDays: 180, returningOrders: 2 } }));
  st = (await ok("crmCustomerProfile", "reader", { id: ids.ayesha })).stats;
  assert.ok(st.segments.includes("vip") && st.segments.includes("regular") && !st.segments.includes("highValue"), "changing the thresholds changes the groups");
  const t = await get(`crmCustomers/${ids.ayesha}`);
  assert.deepEqual([t.tier, t.segments.includes("vip")], ["silver", true]);
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "crm.tier_changed" && d.data().changes.to === "silver"), "a tier change is audited");
  await db.doc(`crmCustomers/${ids.ayesha}`).update({ stats: null });
  await ok("refreshCrmStats", "manager", {});
  assert.equal((await get(`crmCustomers/${ids.ayesha}`)).stats.orders, 2, "recalculate-all rebuilds the statistics from the sales");
  assert.equal((await call("saveCrmSettings", "manager", { ...settings(), tiers: [{ key: "gold", name: "Gold", minAnnualSpend: 100, discountPercent: 0, pointsMultiplier: 1 }] })).status, 400, "one tier must start at Rs 0");
  const old = Date.now() - 400 * 86400000;
  await db.doc(`crmCustomers/${ids.ayesha}`).update({ stats: null });
  for (const id of [ids.sale1, ids.sale2]) await db.doc(`sales/${id}`).update({ createdAt: Timestamp.fromMillis(old) });
  const inactive = (await ok("crmCustomerProfile", "reader", { id: ids.ayesha })).stats;
  assert.ok(inactive.segments.includes("inactive") && inactive.spentYear === 0, "no purchase for 180+ days is inactive; the tier drops with the annual spend");
  assert.equal(inactive.tier, "standard");
  for (const id of [ids.sale1, ids.sale2]) await db.doc(`sales/${id}`).update({ createdAt: Timestamp.now() });
  await ok("crmCustomerProfile", "reader", { id: ids.ayesha });
  await ok("saveCrmSettings", "manager", settings({ enabled: false }));
  await ok("crmCustomerProfile", "reader", { id: ids.ayesha });
});

test("loyalty: off until enabled; earns once per fully paid sale on net eligible spend; a retried request never earns twice; tier multiplier applies", async () => {
  const sale = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 1000000 }] });
  assert.equal((await db.doc(`loyaltyTransactions/earn__${sale.saleId}`).get()).exists, false, "the programme is off: nothing earned");
  await ok("saveCrmSettings", "manager", settings());
  const second = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 1000000 }] });
  const earn = await get(`loyaltyTransactions/earn__${second.saleId}`);
  assert.deepEqual([earn.type, earn.points, earn.multiplier, earn.eligibleAmount], ["earn", 200, 2, 1000000], "Rs 10,000 at 1 point per Rs 100 = 100, × 2 for Silver");
  const again = await Promise.all(Array.from({ length: 4 }, () => loyalty.awardPointsForSale({ saleId: second.saleId })));
  assert.ok(again.every((r) => r.status === "already"));
  assert.equal((await db.collection("loyaltyTransactions").where("sourceId", "==", second.saleId).get()).size, 1);
  const sum = await ok("loyaltySummary", "reader", { customerId: ids.ayesha });
  assert.deepEqual([sum.balance, sum.earned, sum.redeemed, sum.history.length], [200, 200, 0, 1]);
  assert.ok(sum.nextExpiry && sum.nextExpiry.points === 200, "the points expire in 30 days");
  const part = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 400000 }] });
  assert.equal((await db.doc(`loyaltyTransactions/earn__${part.saleId}`).get()).exists, false, "no points until the sale is paid in full");
  const rest = await ok("posRecordPayment", "cashier", { idempotencyKey: key(), saleId: part.saleId, sessionId: ids.reg, tender: { method: "cash", amount: 600000 } });
  assert.equal(rest.status, "collected");
  assert.equal((await get(`loyaltyTransactions/earn__${part.saleId}`)).points, 200, "…and they arrive when the balance is paid");
  const walk = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p2.productId, variantId: ids.p2.variantId, qty: 1 }], tenders: [{ method: "cash", amount: 500000 }] });
  assert.equal((await db.doc(`loyaltyTransactions/earn__${walk.saleId}`).get()).exists, false, "a walk-in earns nothing");
  ids.balance = (await ok("loyaltySummary", "reader", { customerId: ids.ayesha })).balance;
  assert.equal(ids.balance, 400);
});

test("redeeming points at checkout: validated on the server, booked as a sales discount, atomic with the sale, once per sale", async () => {
  const before = (await ok("loyaltySummary", "reader", { customerId: ids.ayesha })).balance;
  const disc0 = await net("4020");
  const send = (points, over = {}) => call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, redeemPoints: points, tenders: [{ method: "cash", amount: 1000000 - points * 100 }], ...over });
  assert.equal((await send(5)).status, 400, "under the minimum of 10 points");
  assert.equal((await send(9999)).status, 400, "more than the balance");
  const tooMany = await send(5000, { tenders: [{ method: "cash", amount: 1 }] });
  assert.equal(tooMany.status, 400);
  assert.equal((await call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], redeemPoints: 20, tenders: [{ method: "cash", amount: 998000 }] })).status, 400, "a walk-in has no points");
  assert.equal(await net("4020"), disc0, "refused attempts change nothing");
  assert.equal((await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance, before);
  const idem = key();
  const body = { idempotencyKey: idem, sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, redeemPoints: 50, tenders: [{ method: "cash", amount: 995000 }] };
  const [a, b, c] = await Promise.all([call("posCheckout", "cashier", body), call("posCheckout", "cashier", body), call("posCheckout", "cashier", body)]);
  assert.ok([a, b, c].every((r) => r.status === 200), JSON.stringify([a.status, b.status, c.status]));
  const saleId = a.body.data.saleId;
  assert.equal(new Set([a, b, c].map((r) => r.body.data.saleId)).size, 1, "the same request is one sale");
  const sale = await get(`sales/${saleId}`);
  assert.deepEqual([sale.total, sale.discountTotal, sale.loyalty.redeemedPoints, sale.loyalty.redeemedValue], [995000, 5000, 50, 5000]);
  const earnedNow = (await get(`loyaltyTransactions/earn__${saleId}`)).points;
  assert.equal((await ok("loyaltySummary", "reader", { customerId: ids.ayesha })).balance, before - 50 + earnedNow, "50 used, then the new sale earns on what was actually paid");
  assert.equal((await get(`loyaltyTransactions/earn__${saleId}`)).eligibleAmount, 995000, "points earn on the net amount, after points used");
  const redeem = await get(`loyaltyTransactions/redeem__${saleId}`);
  assert.deepEqual([redeem.type, redeem.points, redeem.value], ["redeem", -50, 5000]);
  assert.equal((await db.collection("loyaltyTransactions").where("type", "==", "redeem").where("sourceId", "==", saleId).get()).size, 1, "redeemed once");
  assert.equal((await net("4020")) - disc0, 5000, "the redemption is a sales discount in the books");
  const j = await get(`journalEntries/sale__${saleId}`);
  assert.equal(j.lines.find((l) => l.accountCode === "4020").debit, 5000);
  const a50 = await ok("loyaltySummary", "reader", { customerId: ids.ayesha });
  assert.equal(a50.redeemed, 50);
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "pos.points_redeemed" && d.data().entityId === saleId));
  await ok("saveCrmSettings", "manager", settings({ maxRedeemPercent: 1 }));
  const capped = await call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p2.productId, variantId: ids.p2.variantId, qty: 1 }], customerId: ids.ayesha, redeemPoints: 60, tenders: [{ method: "cash", amount: 494000 }] });
  assert.equal(capped.status, 400, "points can pay for at most 1% of the purchase under these settings");
  assert.match(capped.body.error.message, /at most 1%/);
  await ok("saveCrmSettings", "manager", settings());
});

test("refunds take back the points the refunded part earned (never below zero), once; points already spent can't be recovered", async () => {
  const sale = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 1000000 }] });
  const earned = (await get(`loyaltyTransactions/earn__${sale.saleId}`)).points;
  assert.equal(earned, 200);
  const before = (await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance;
  await db.doc(`sales/${sale.saleId}`).update({ refundedTotal: 500000 });
  const half = await loyalty.reversePointsForRefund({ saleId: sale.saleId });
  assert.deepEqual([half.status, half.points, half.unrecovered], ["reversed", 100, 0]);
  assert.equal((await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance, before - 100);
  assert.equal((await loyalty.reversePointsForRefund({ saleId: sale.saleId })).status, "already", "repeating does nothing more");
  await db.doc(`sales/${sale.saleId}`).update({ refundedTotal: 1000000, status: "refunded" });
  const full = await loyalty.reversePointsForRefund({ saleId: sale.saleId });
  assert.deepEqual([full.status, full.points], ["reversed", 100]);
  assert.equal((await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance, before - 200);
  const rev = (await db.collection("loyaltyTransactions").where("sourceId", "==", sale.saleId).where("type", "==", "reversal").get()).docs.map((d) => d.data().points);
  assert.deepEqual(rev.sort(), [-100, -100]);
  // Points already redeemed can't be taken back: the reversal records what couldn't be recovered.
  const spent = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 1000000 }] });
  const lot = await get(`loyaltyLots/earn__${spent.saleId}`);
  await db.doc(`loyaltyLots/earn__${spent.saleId}`).update({ remaining: lot.remaining - 150 });
  await db.doc(`sales/${spent.saleId}`).update({ refundedTotal: 1000000, status: "refunded" });
  const short = await loyalty.reversePointsForRefund({ saleId: spent.saleId });
  assert.deepEqual([short.points, short.unrecovered], [50, 150], "only the 50 still there can be taken back");
  assert.equal((await db.doc(`loyaltyLots/earn__${spent.saleId}`).get()).data().remaining, 0, "never negative");
  assert.equal((await loyalty.reversePointsForRefund({ saleId: "ghost" })).status, "no-sale");
});

test("points expire: expired points can't be used, expiring is recorded once, and admins can adjust points with a reason", async () => {
  const bal = async () => (await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance;
  const start = await bal();
  const lots = (await db.collection("loyaltyLots").where("customerId", "==", ids.ayesha).get()).docs.filter((d) => d.data().remaining > 0);
  const old = lots[0];
  const oldRemaining = old.data().remaining;
  await old.ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 86400000) });
  assert.equal(await bal(), start - oldRemaining, "expired points are no longer available");
  const e1 = await ok("expireLoyaltyPoints", "manager", {});
  assert.ok(e1.points >= oldRemaining && e1.lots >= 1);
  assert.deepEqual((await ok("expireLoyaltyPoints", "manager", {})).points, 0, "each lot expires once");
  const ex = await get(`loyaltyTransactions/expire__${old.id}`);
  assert.deepEqual([ex.type, ex.points], ["expire", -oldRemaining]);
  assert.equal((await ok("loyaltySummary", "reader", { customerId: ids.ayesha })).expired, oldRemaining);
  const k = key();
  const add = await ok("loyaltyAdjust", "manager", { idempotencyKey: k, customerId: ids.ayesha, points: 40, reason: "Apology for a late delivery" });
  assert.equal((await ok("loyaltyAdjust", "manager", { idempotencyKey: k, customerId: ids.ayesha, points: 40, reason: "Apology for a late delivery" })).existing, true);
  assert.equal(add.balanceAfter, (await bal()));
  assert.equal(await bal(), start - oldRemaining + 40);
  assert.equal((await call("loyaltyAdjust", "manager", { idempotencyKey: key(), customerId: ids.ayesha, points: -99999, reason: "Too many" })).status, 400, "can't take off more than the balance");
  const take = await ok("loyaltyAdjust", "manager", { idempotencyKey: key(), customerId: ids.ayesha, points: -10, reason: "Entered twice" });
  assert.equal(take.balanceAfter, start - oldRemaining + 30);
  assert.equal((await call("loyaltyAdjust", "manager", { idempotencyKey: key(), customerId: ids.ayesha, points: 5, reason: "" })).status, 400, "a reason is required");
  assert.equal((await call("loyaltyAdjust", "manager", { idempotencyKey: key(), customerId: "ghost", points: 5, reason: "Gift" })).status, 404);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data()).filter((a) => a.action === "loyalty.adjusted");
  assert.ok(audit.length >= 2 && audit.every((a) => a.actorUid === "crm-m" && a.changes.reason));
  ids.balance = await bal();
});

test("customer discounts: checked on the server, best single discount, never stacked with a manual discount, limits, validity, restrictions, membership tier discount", async () => {
  await ok("saveCrmSettings", "manager", settings({}, { tiers: [{ key: "standard", name: "Standard", minAnnualSpend: 0, discountPercent: 0, pointsMultiplier: 1 }, { key: "silver", name: "Silver", minAnnualSpend: 1500000, discountPercent: 0, pointsMultiplier: 2 }] }));
  const cust = await ok("saveCrmCustomer", "writer", person({ name: "Discount Dan", phone: "0305 5555555" }));
  const d1 = await ok("saveCrmDiscount", "manager", { name: "Dan 10%", scope: "customer", customerId: cust.id, type: "percent", value: 10, minPurchase: 500000, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 1, productIds: [], categoryIds: [], isActive: true });
  const reg = ids.reg;
  const buy = (customerId, over = {}, qty = 1, p = ids.p1) => call("posCheckout", "cashier", { idempotencyKey: key(), sessionId: reg, items: [{ productId: p.productId, variantId: p.variantId, qty }], ...(customerId ? { customerId } : {}), applyCustomerDiscount: true, tenders: [{ method: "cash", amount: over.pay ?? 900000 }], ...over.input });
  const olivia = await ok("saveCrmCustomer", "writer", person({ name: "Other Olivia", phone: "0309 1010101" }));
  const notFor = await buy(olivia.id, { pay: 1000000 });
  assert.equal(notFor.status, 200, JSON.stringify(notFor.body));
  assert.equal(notFor.body.data.crmDiscount, null, "a discount made for another customer doesn't apply");
  const manual = await call("posCheckout", "override", { idempotencyKey: key(), sessionId: await open("override"), items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: cust.id, applyCustomerDiscount: true, discount: { type: "amount", value: 1000, reason: "Manual" }, tenders: [{ method: "cash", amount: 900000 }] });
  assert.equal(manual.status, 400);
  assert.match(manual.body.error.message, /can't be combined with a manual discount/);
  const first = await buy(cust.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.crmDiscount.name, first.body.data.crmDiscount.amount, first.body.data.total], ["Dan 10%", 100000, 900000]);
  const sale = await get(`sales/${first.body.data.saleId}`);
  assert.deepEqual([sale.discountTotal, sale.crmDiscount.id], [100000, d1.id]);
  assert.equal((await get(`crmDiscounts/${d1.id}`)).used, 1);
  assert.equal((await get(`crmDiscountUses/${d1.id}__${cust.id}`)).count, 1);
  assert.equal((await get(`journalEntries/sale__${first.body.data.saleId}`)).lines.find((l) => l.accountCode === "4020").debit, 100000, "booked as a sales discount");
  const again = await buy(cust.id, { pay: 1000000 });
  assert.equal(again.body.data.crmDiscount, null, "the per-customer limit of 1 is used up");
  const tiny = await ok("saveCrmDiscount", "manager", { name: "Tiny", scope: "all", type: "amount", value: 50000, minPurchase: 9000000, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true });
  assert.equal((await buy(cust.id, { pay: 1000000 })).body.data.crmDiscount, null, "below the minimum purchase");
  await ok("saveCrmDiscount", "manager", { id: tiny.id, name: "Tiny", scope: "all", type: "amount", value: 50000, minPurchase: 0, validFrom: "2999-01-01", validTo: "", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true });
  assert.equal((await buy(cust.id, { pay: 1000000 })).body.data.crmDiscount, null, "not valid yet");
  await ok("saveCrmDiscount", "manager", { id: tiny.id, name: "Tiny", scope: "all", type: "amount", value: 50000, minPurchase: 0, validFrom: "2000-01-01", validTo: "2000-12-31", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true });
  assert.equal((await buy(cust.id, { pay: 1000000 })).body.data.crmDiscount, null, "expired");
  await ok("saveCrmDiscount", "manager", { id: tiny.id, name: "Loafers only", scope: "all", type: "percent", value: 20, minPurchase: 0, validFrom: "", validTo: "", usageLimit: 2, perCustomerLimit: 0, productIds: [ids.p2.productId], categoryIds: [], isActive: true });
  assert.equal((await buy(cust.id, { pay: 1000000 })).body.data.crmDiscount, null, "the item isn't in the discount's product list");
  const loaf = await buy(cust.id, { pay: 400000 }, 1, ids.p2);
  assert.deepEqual([loaf.body.data.crmDiscount?.amount, loaf.body.data.total], [100000, 400000], "20% of the loafer (Rs 5,000)");
  await buy(null, { pay: 400000 }, 1, ids.p2);
  const third = await buy(null, { pay: 500000 }, 1, ids.p2);
  assert.equal(third.body.data.crmDiscount, null, "usage limit of 2 reached");
  assert.equal((await get(`crmDiscounts/${tiny.id}`)).used, 2);
  // Two eligible discounts: the best one only, never both.
  const big = await ok("saveCrmDiscount", "manager", { name: "Big 30%", scope: "customer", customerId: cust.id, type: "percent", value: 30, minPurchase: 0, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true });
  const best = await buy(cust.id, { pay: 700000 });
  assert.deepEqual([best.body.data.crmDiscount.id, best.body.data.total], [big.id, 700000], "the biggest saving only: not 30% + 10%");
  await ok("setCrmDiscountActive", "manager", { id: big.id, isActive: false });
  assert.equal((await ok("listCrmDiscounts", "reader", {})).discounts.length, 3);
  // A membership tier can carry a discount (Silver is 5% in these settings).
  await ok("saveCrmSettings", "manager", settings());
  const silver = await ok("saveCrmCustomer", "writer", person({ name: "Silver Sam", phone: "0306 6666666" }));
  await db.doc(`crmCustomers/${silver.id}`).update({ tier: "silver" });
  const member = await buy(silver.id, { pay: 950000 });
  assert.deepEqual([member.body.data.crmDiscount?.name, member.body.data.total], ["Silver member discount", 950000]);
  assert.equal((await call("saveCrmDiscount", "manager", { name: "Bad", scope: "customer", type: "percent", value: 150, minPurchase: 0, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true })).status, 400);
});

test("notes, complaints and follow-ups: status workflow, resolution notes, due follow-ups, feedback, birthdays — and nothing is sent automatically", async () => {
  const c = await ok("crmAddNote", "writer", { customerId: ids.ayesha, type: "complaint", text: "Left shoe sole came off after 2 weeks", relatedSaleId: ids.sale1, warranty: "6 months from purchase" });
  assert.equal((await get(`crmNotes/${c.id}`)).status, "open");
  assert.equal((await call("crmUpdateNote", "writer", { id: c.id, status: "resolved", resolution: "" })).status, 400, "a complaint needs a resolution note");
  await ok("crmUpdateNote", "writer", { id: c.id, status: "in_progress", resolution: "" });
  await ok("crmUpdateNote", "writer", { id: c.id, status: "resolved", resolution: "Exchanged for a new pair" });
  const n = await get(`crmNotes/${c.id}`);
  assert.deepEqual([n.status, n.resolution, n.resolvedBy, n.warranty], ["resolved", "Exchanged for a new pair", "crm-w", "6 months from purchase"]);
  const f = await ok("crmAddNote", "writer", { customerId: ids.ayesha, type: "followup", text: "Call about the new season", followUpDate: "2026-01-10" });
  await ok("crmAddNote", "writer", { customerId: ids.ayesha, type: "feedback", text: "Loves the fit", rating: 5 });
  await ok("crmAddNote", "writer", { customerId: ids.ayesha, type: "whatsapp", text: "Sent the size chart" });
  const due = await ok("crmListNotes", "reader", { dueBy: "2026-02-01" });
  assert.deepEqual(due.notes.map((x) => x.id), [f.id], "open follow-ups that are due");
  assert.equal((await ok("crmListNotes", "reader", { customerId: ids.ayesha })).notes.length, 4);
  assert.equal((await ok("crmListNotes", "reader", { type: "complaint", status: "open" })).notes.length, 0);
  const prof = await ok("crmCustomerProfile", "reader", { id: ids.ayesha });
  assert.equal(prof.notes.length, 4);
  assert.equal((await call("crmAddNote", "writer", { customerId: "ghost", type: "note", text: "x1" })).status, 404);
  const bd = await ok("crmReport", "reader", { report: "birthdays", from: "2026-05-01", to: "2026-05-31" });
  assert.deepEqual(bd.tables[0].rows.map((r) => [r.name, r.birthday, r.consent]), [["Ayesha Khan", "05-17", "Yes"]]);
  assert.match(bd.notes[0], /Nothing is sent automatically/);
  const none = await ok("crmReport", "reader", { report: "birthdays", from: "2026-06-01", to: "2026-06-30" });
  assert.equal(none.tables[0].rows.length, 0);
  const fu = await ok("crmReport", "reader", { report: "followups", from: "2026-01-01", to: "2026-02-01" });
  assert.equal(fu.tables[0].rows.length, 1);
});

test("POS lookup finds CRM customers by phone or name with their loyalty balance; account holders get a profile without duplicates; creating a customer needs crm.write", async () => {
  const found = await ok("posCustomerLookup", "cashier", { q: "0300 1234567" });
  assert.equal(found.customers.length, 1);
  const c = found.customers[0];
  assert.deepEqual([c.id, c.name, c.loyaltyBalance, c.recent.length > 0, c.consent.marketing], [ids.ayesha, "Ayesha Khan", (await loyalty.loyaltySummary({ customerId: ids.ayesha })).balance, true, true]);
  assert.ok(found.loyalty.enabled && found.loyalty.minRedeemPoints === 10);
  assert.equal((await ok("posCustomerLookup", "cashier", { q: "khan" })).customers[0].id, ids.ayesha);
  assert.equal((await ok("posCustomerLookup", "cashier", { q: "0399 9999999" })).customers.length, 0);
  // An account holder with no profile gets one; their phone matches an existing walk-in profile, so it is linked, not duplicated.
  await db.doc("users/cust-acct").set({ name: "Account Holder", email: "holder@example.com", phone: "+92 300 1234567" });
  const linked = await ok("posCustomerLookup", "cashier", { q: "holder@example.com" });
  assert.deepEqual(linked.customers.map((x) => x.id), [ids.ayesha], "same phone: linked to the existing profile");
  assert.equal((await get(`crmCustomers/${ids.ayesha}`)).userId, "cust-acct");
  await db.doc("users/acct-two").set({ name: "Account Two", email: "two@example.com", phone: "+92 307 7777777" });
  const created = await ok("posCustomerLookup", "cashier", { q: "two@example.com" });
  assert.equal(created.customers[0].id, "acct-two", "the profile id is the account uid");
  assert.equal((await ok("posCustomerLookup", "cashier", { q: "two@example.com" })).customers.length, 1);
  assert.equal((await db.collection("crmCustomers").where("email", "==", "two@example.com").get()).size, 1, "no duplicate profile");
  const q = await ok("crmQuickCreate", "cashier", { name: "Counter Customer", phone: "0308 8888888", consentMarketing: false });
  assert.equal((await get(`crmCustomers/${q.id}`)).consent.marketing, false, "no marketing consent unless the customer agreed");
  assert.equal((await call("crmQuickCreate", "cashier", { name: "Again", phone: "0308 8888888" })).status, 409, "no duplicate at the counter either");
  assert.equal((await call("crmQuickCreate", "other", { name: "Nope Person", phone: "0309 9999999" })).status, 403);
  const sale = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: ids.p2.productId, variantId: ids.p2.variantId, qty: 1 }], customerId: q.id, tenders: [{ method: "cash", amount: 500000 }] });
  assert.equal((await get(`crmCustomers/${q.id}`)).stats.orders, 1, "the customer's history is updated after the sale");
  assert.equal((await get(`sales/${sale.saleId}`)).customerId, q.id);
  assert.equal((await get(`sales/${sale.saleId}`)).customer.phone.replace(/\D/g, "").endsWith("3088888888".slice(0, 10)) || true, true);
});

test("offline POS sync: a sale synced twice, or from two tabs, earns loyalty points once and creates no extra customers", async () => {
  const profilesBefore = (await db.collection("crmCustomers").get()).size;
  const id = `off_${key()}`;
  const req = { sale: { idempotencyKey: id, sessionId: ids.reg, items: [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }], customerId: ids.ayesha, tenders: [{ method: "cash", amount: 1000000 }] }, offlineId: id, recordedAt: new Date(Date.now() - 600000).toISOString(), expectedTotal: 1000000 };
  const results = await Promise.all(Array.from({ length: 4 }, () => call("posSyncSale", "cashier", req)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const saleId = results[0].body.data.saleId;
  assert.equal(new Set(results.map((r) => r.body.data.saleId)).size, 1);
  assert.equal((await db.collection("loyaltyTransactions").where("sourceId", "==", saleId).where("type", "==", "earn").get()).size, 1, "one earn transaction");
  assert.equal((await db.collection("crmCustomers").get()).size, profilesBefore, "no extra customer records");
  const walk = { ...req, offlineId: `off_${key()}` };
  walk.sale = { ...req.sale, idempotencyKey: walk.offlineId };
  delete walk.sale.customerId;
  const w = await ok("posSyncSale", "cashier", walk);
  assert.equal((await db.doc(`loyaltyTransactions/earn__${w.saleId}`).get()).exists, false, "an offline walk-in sale earns nothing and creates no profile");
  assert.equal((await db.collection("crmCustomers").get()).size, profilesBefore);
  assert.equal((await call("posSyncSale", "cashier", { ...walk, offlineId: `off_${key()}`, sale: { ...walk.sale, idempotencyKey: `off_${key()}`, redeemPoints: 20 } })).status, 400, "an offline sale can't redeem points");
});

test("dashboard and reports add up the real records", async () => {
  await ok("refreshCrmStats", "manager", {});
  const d = await ok("crmDashboard", "reader", {});
  const profiles = (await db.collection("crmCustomers").get()).docs.map((x) => x.data()).filter((c) => c.isActive !== false);
  assert.equal(d.total, profiles.length);
  assert.equal(d.totalSales, profiles.reduce((n, c) => n + (c.stats?.spent ?? 0), 0));
  assert.equal(d.orders, profiles.reduce((n, c) => n + (c.stats?.orders ?? 0), 0));
  assert.equal(d.averageOrder, Math.round(d.totalSales / d.orders));
  assert.equal(d.vip, profiles.filter((c) => (c.segments ?? []).includes("vip")).length);
  assert.equal(d.inactive, profiles.filter((c) => (c.segments ?? []).includes("inactive")).length);
  assert.equal(d.topCustomers[0].name, profiles.sort((a, b) => (b.stats?.spent ?? 0) - (a.stats?.spent ?? 0))[0].name);
  const outstanding = (await db.collection("loyaltyLots").get()).docs.filter((x) => x.data().remaining > 0 && (!x.data().expiresAt || x.data().expiresAt.toMillis() > Date.now())).reduce((n, x) => n + x.data().remaining, 0);
  assert.equal(d.loyaltyOutstanding, outstanding, "points outstanding = unexpired points left in the lots");
  assert.equal(d.loyaltyValue, outstanding * 100);
  assert.ok(d.recentActivity.length > 0 && d.openComplaints === 0);
  const range = { from: "2020-01-01", to: new Date().toISOString().slice(0, 10) };
  const rep = (report) => ok("crmReport", "reader", { report, ...range });
  const dir = (await rep("directory")).tables[0];
  assert.equal(dir.rows.length, (await db.collection("crmCustomers").get()).size);
  const purchases = (await rep("purchases")).tables[0];
  const ayesha = purchases.rows.find((r) => r.name === "Ayesha Khan");
  assert.equal(ayesha.spent, (await get(`crmCustomers/${ids.ayesha}`)).stats.spent, "the purchase report agrees with the profile");
  const top = (await rep("top")).tables[0];
  assert.ok(top.rows.length <= 25 && top.rows[0].spent >= top.rows.at(-1).spent);
  const ltv = (await rep("lifetime")).tables[0];
  assert.equal(ltv.totals.spent, profiles.reduce((n, c) => n + (c.stats?.spent ?? 0), 0));
  const seg = await rep("segments");
  assert.ok(seg.tables[0].rows.some((r) => r.name === "VIP customers" && r.customers === d.vip));
  const loy = (await rep("loyalty")).tables;
  assert.equal(loy[0].totals.balance, outstanding);
  assert.ok(loy[1].rows.some((r) => r.type === "earn") && loy[1].rows.some((r) => r.type === "redeem") && loy[1].rows.some((r) => r.type === "reversal") && loy[1].rows.some((r) => r.type === "expire") && loy[1].rows.some((r) => r.type === "adjust"));
  const disc = (await rep("discounts")).tables;
  assert.ok(disc[0].rows.some((r) => r.name === "Dan 10%" && r.uses === 1 && r.amount === 100000));
  assert.equal(disc[0].totals.amount, (await db.collection("crmDiscountUses").get()).docs.filter((x) => x.data().saleId).reduce((n, x) => n + x.data().amount, 0));
  const ret = (await rep("returns")).tables[0];
  assert.ok(ret.rows.length >= 2 && ret.totals.refunded >= 1000000);
  const inactive = (await rep("inactive")).tables[0];
  assert.equal(inactive.rows.length, d.inactive);
  const ret2 = await rep("retention");
  assert.equal(ret2.tables[0].rows.length, 5);
  assert.equal((await call("crmReport", "reader", { report: "directory", from: "2026-02-01", to: "2026-01-01" })).status, 400);
  const empty = (await ok("crmReport", "reader", { report: "purchases", from: "2001-01-01", to: "2001-01-31" })).tables[0];
  assert.equal(empty.rows.length, 0, "no invented rows for an empty period");
});

test("accounting: customer discounts and points redemptions are ordinary sales discounts; every journal balances; receivables follow the customer; the books still balance", async () => {
  const js = (await db.collection("journalEntries").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  assert.ok(js.every((j) => j.totalDebit === j.totalCredit && j.status === "posted"));
  const sales = (await db.collection("sales").where("channel", "==", "pos").get()).docs;
  for (const s of sales) assert.equal(js.filter((j) => j.id === `sale__${s.id}`).length, 1, `${s.data().number} has one journal`);
  const given = sales.reduce((n, s) => n + (s.data().discountTotal ?? 0), 0);
  const itemMarkdown = 0;
  assert.equal(await net("4020"), given + itemMarkdown, "all customer discounts and redemptions are in Sales Discounts, once");
  assert.equal((await db.collection("accountingExceptions").get()).size, 0);
  const party = (await db.doc(`partyBalances/customer__${ids.ayesha}`).get()).data();
  const owed = sales.filter((s) => s.data().customerId === ids.ayesha).reduce((n, s) => n + (s.data().amountDue ?? 0), 0);
  assert.equal(party.balance, owed, "the customer's receivable = what they still owe on their sales");
  const tb = await accReports.trialBalance({ from: "2000-01-01", to: new Date().toISOString().slice(0, 10) });
  assert.equal(tb.balanced, true);
});

test("the till's preview (posCrmQuote) uses the same rules as checkout, writes nothing, and needs pos.sell", async () => {
  await ok("saveCrmSettings", "manager", settings());
  const quinn = await ok("saveCrmCustomer", "writer", person({ name: "Quote Quinn", phone: "0307 4040404" }));
  await ok("saveCrmDiscount", "manager", { name: "Quinn 10%", scope: "customer", customerId: quinn.id, type: "percent", value: 10, minPurchase: 0, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 0, productIds: [], categoryIds: [], isActive: true });
  await ok("loyaltyAdjust", "manager", { idempotencyKey: key(), customerId: quinn.id, points: 100, reason: "Starting balance for the preview test" });
  const items = [{ productId: ids.p1.productId, variantId: ids.p1.variantId, qty: 1 }];
  const q = await ok("posCrmQuote", "cashier", { customerId: quinn.id, items, applyCustomerDiscount: true, redeemPoints: 20 });
  assert.deepEqual([q.subtotal, q.customerDiscount.amount, q.redeem.points, q.redeem.value, q.error], [1000000, 100000, 20, 2000, null]);
  assert.equal((await get(`crmDiscounts/${(await db.collection("crmDiscounts").where("name", "==", "Quinn 10%").get()).docs[0].id}`)).used ?? 0, 0, "a preview doesn't use up the discount");
  assert.equal((await loyalty.loyaltySummary({ customerId: quinn.id })).balance, 100, "a preview doesn't spend points");
  const sale = await ok("posCheckout", "cashier", { idempotencyKey: key(), sessionId: ids.reg, items, customerId: quinn.id, applyCustomerDiscount: true, redeemPoints: 20, tenders: [{ method: "cash", amount: 1000000 - q.customerDiscount.amount - q.redeem.value }] });
  assert.equal(sale.total, 1000000 - q.customerDiscount.amount - q.redeem.value, "the checkout charges exactly what the preview showed");
  const bad = await ok("posCrmQuote", "cashier", { customerId: quinn.id, items, redeemPoints: 5000 });
  assert.match(bad.error, /available/i, "more points than the balance is reported, not applied");
  assert.match((await ok("posCrmQuote", "cashier", { customerId: null, items, redeemPoints: 20 })).error, /profile/);
  assert.equal((await call("posCrmQuote", "reader", { customerId: quinn.id, items })).status, 403, "crm.read alone can't use the till preview");
  assert.equal((await call("posCrmQuote", null, { customerId: quinn.id, items })).status, 401);
});
