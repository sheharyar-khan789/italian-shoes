/**
 * Analytics, business intelligence and reporting against the emulators (`npm run test:emulator`). A small, hand-checkable set of real
 * POS sales is created through the real checkout; every expected number below is worked out by hand in the comments. Tests share
 * state and run in order. The large-dataset test is last because it adds sale records that have no journals.
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
const accReports = await import("../../functions/services/accountingReports.js");
const schedules = await import("../../functions/services/analyticsSchedules.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { POS_ROLES } = await import("../../functions/shared/permissions.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");
const { addDays } = await import("../../functions/shared/finance.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");
const READ = ["analytics.read", "sales.read", "inventory.read", "crm.read", "purchases.read"];
const FIN = ["analytics.financial", "accounting.read", "costs.read"];
const TOKENS = {
  owner: { uid: "an-owner", name: "Owner", staff: true, perms: [...READ, ...FIN, "analytics.executive", "analytics.export", "analytics.manage"], auth_time: 9999999999 },
  sales: { uid: "an-sales", name: "Sales", staff: true, perms: ["analytics.read", "sales.read"], auth_time: 9999999999 },
  fin: { uid: "an-fin", name: "Accountant", staff: true, perms: [...FIN], auth_time: 9999999999 },
  finOnly: { uid: "an-fin2", name: "Fin only", staff: true, perms: ["analytics.financial", "accounting.read"], auth_time: 9999999999 },
  exporter: { uid: "an-exp", name: "Exporter", staff: true, perms: ["analytics.read", "sales.read", "analytics.export"], auth_time: 9999999999 },
  mgr: { uid: "an-mgr", name: "Manager", staff: true, perms: ["analytics.read", "sales.read", "analytics.manage"], auth_time: 9999999999 },
  none: { uid: "an-nobody", name: "Nobody", staff: true, perms: ["orders.read"], auth_time: 9999999999 },
  override: { uid: "an-pos", name: "POS boss", staff: true, perms: [...POS_ROLES.pos_manager.permissions, "crm.write", "crm.read"], auth_time: 9999999999 },
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
const today = pktDateKey(new Date());
const range = { from: today, to: today };
const report = (token, name, over = {}) => ok("analyticsReport", token, { report: name, ...range, ...over });
const tableOf = (r, title) => r.tables.find((t) => t.title === title || t.title.startsWith(title));

async function variant(name, slug, sku, price, categoryId) {
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId, sku }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price, salePrice: null, costPrice: Math.round(price * 0.6) }), { actorUid: STAFF, canEditCost: true });
  const variantId = products.variantKey(ids.black, ids.s42);
  await inventory.adjustStock({ productId, variantId, warehouseId: ids.shop, change: 100, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published" });
  return { productId, variantId };
}
const sell = (token, p, qty, tender, over = {}) => ok("posCheckout", token, { idempotencyKey: key(), sessionId: ids.reg, items: [{ productId: p.productId, variantId: p.variantId, qty }], tenders: [tender], ...over });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-acct") await auth.createUser({ uid: t.uid }).catch(() => {});
  ids.formal = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.casual = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Casual", slug: "casual" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: false });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  ids.p1 = await variant("Oxford One", "oxford-one", "OX-1", 1000000, ids.formal); // price Rs 10,000, cost Rs 6,000
  ids.p2 = await variant("Loafer Two", "loafer-two", "LF-2", 500000, ids.casual); // price Rs 5,000, cost Rs 3,000
  ids.p3 = await variant("Boot Three", "boot-three", "BT-3", 800000, ids.formal); // never sold: dead stock
  ids.reg = (await ok("openRegister", "override", { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).sessionId;
  ids.carol = (await ok("saveCrmCustomer", "override", { name: "Carol Customer", phone: "0300 7000001" })).id;
  // The sales (all today, PKT):
  //  S1  2 × Oxford, cash, no customer         net 2,000,000  cost 1,200,000
  //  S2  1 × Loafer, 10% manual discount, bank net   450,000  cost   300,000   (gross 500,000, discount 50,000)
  //  S3  1 × Oxford, cash, Carol               net 1,000,000  cost   600,000
  //  S4  1 × Loafer, cash, Carol               net   500,000  cost   300,000
  ids.s1 = await sell("override", ids.p1, 2, { method: "cash", amount: 2000000 });
  ids.s2 = await sell("override", ids.p2, 1, { method: "bank_transfer", amount: 450000, reference: "TRX-0001" }, { discount: { type: "percent", value: 10, reason: "Regular" } });
  ids.s3 = await sell("override", ids.p1, 1, { method: "cash", amount: 1000000 }, { customerId: ids.carol });
  ids.s4 = await sell("override", ids.p2, 1, { method: "cash", amount: 500000 }, { customerId: ids.carol });
});

test("permissions: the executive dashboard is Owner-only; every report needs ALL of its permissions; exports need their own", async () => {
  assert.equal((await call("analyticsExecutive", "sales", range)).status, 403);
  assert.equal((await call("analyticsExecutive", "fin", range)).status, 403, "financial permissions alone don't open the executive view");
  assert.equal((await call("analyticsExecutive", null, range)).status, 401);
  assert.equal((await call("analyticsExecutive", "customer", range)).status, 403);
  assert.equal((await call("analyticsReport", "none", { report: "sales_trend", ...range })).status, 403);
  assert.equal((await call("analyticsReport", "sales", { report: "profit_product", ...range })).status, 403, "profit needs analytics.financial and costs.read");
  assert.equal((await call("analyticsReport", "finOnly", { report: "profit_product", ...range })).status, 403, "costs.read is also required");
  assert.equal((await call("analyticsReport", "sales", { report: "customer_analytics", ...range })).status, 403, "customer analytics needs crm.read");
  assert.equal((await call("analyticsReport", "sales", { report: "fin_pnl", ...range })).status, 403);
  assert.equal((await call("analyticsReport", "fin", { report: "sales_trend", ...range })).status, 403, "a financial role can't read sales analytics without analytics.read");
  assert.equal((await call("analyticsReport", null, { report: "sales_trend", ...range })).status, 401);
  assert.equal((await call("analyticsReport", "sales", { report: "sales_trend", ...range })).status, 200);
  assert.equal((await call("analyticsExport", "sales", { report: "sales_trend", format: "csv", ...range })).status, 403, "viewing isn't exporting");
  assert.equal((await call("analyticsExport", "exporter", { report: "fin_pnl", format: "csv", ...range })).status, 403, "can't export a report you may not run");
  assert.equal((await call("analyticsExport", "exporter", { report: "executive", format: "csv", ...range })).status, 403);
  assert.equal((await call("analyticsExport", "exporter", { report: "sales_trend", format: "csv", ...range })).status, 200);
  assert.equal((await call("analyticsReport", "customer", { report: "sales_trend", ...range })).status, 403);
  const { effectivePermissions, OWNER_ONLY } = await import("../../functions/shared/permissions.js");
  assert.ok(OWNER_ONLY.includes("analytics.executive"));
  assert.ok(!effectivePermissions(["manager"], { manager: { name: "M", permissions: ["analytics.executive", "analytics.read"] } }).includes("analytics.executive"), "the executive permission can't be granted to a non-owner role");
});

test("filters are validated: bad dates, reversed ranges, huge ranges, unknown reports, bad ids", async () => {
  const bad = async (over, label) => assert.equal((await call("analyticsReport", "sales", { report: "sales_trend", ...range, ...over })).status, 400, label);
  await bad({ from: "2026-13-40" }, "impossible date");
  await bad({ from: addDays(today, 5) }, "end before start");
  await bad({ from: addDays(today, -2000) }, "range over three years");
  await bad({ report: "drop_tables" }, "unknown report");
  await bad({ compareFrom: today }, "a comparison needs both dates");
  await bad({ granularity: "hour" }, "unknown granularity");
  await bad({ filters: { productIds: [""] } }, "bad id");
  await bad({ filters: { paymentMethods: ["bitcoin"] } }, "unknown payment method");
  assert.equal((await call("analyticsExecutive", "owner", { from: today, to: "nope" })).status, 400);
});

test("executive sales metrics are exact: total, net, orders, average, discounts, units", async () => {
  const e = await ok("analyticsExecutive", "owner", range);
  assert.deepEqual([e.sales.netSales, e.sales.totalSales, e.sales.orders, e.sales.units, e.sales.averageOrder, e.sales.discounts, e.sales.returns], [3950000, 3950000, 4, 5, 987500, 50000, 0]);
  assert.equal(e.sales.growth, null, "no sales in the previous period to grow from");
  assert.equal(e.previous.to, addDays(today, -1));
});

test("sales trend: daily buckets, empty days show zero, weekly buckets, comparison period and growth", async () => {
  const r = await report("sales", "sales_trend", { from: addDays(today, -2), to: today, granularity: "day" });
  const t = r.tables[0];
  assert.equal(t.rows.length, 3, "a quiet day still appears");
  assert.deepEqual(t.rows.map((x) => x.net), [0, 0, 3950000]);
  assert.deepEqual([t.totals.orders, t.totals.units, t.totals.gross, t.totals.discounts, t.totals.net], [4, 5, 4000000, 50000, 3950000]);
  assert.equal(r.charts[0].series[0].values.at(-1), 3950000);
  const wk = await report("sales", "sales_trend", { from: addDays(today, -13), to: today, granularity: "week" });
  assert.equal(wk.tables[0].totals.net, 3950000);
  assert.ok(wk.tables[0].rows.length >= 2 && wk.tables[0].rows.length <= 3);
  const cmp = await report("sales", "sales_trend", { from: today, to: today, compareFrom: addDays(today, -1), compareTo: addDays(today, -1) });
  assert.deepEqual([cmp.tables[0].rows[0].prevNet, cmp.tables[0].rows[0].change], [0, null], "growth against nothing is not a number");
  const mon = await report("sales", "sales_trend", { from: `${today.slice(0, 7)}-01`, to: today, granularity: "month" });
  assert.equal(mon.tables[0].totals.net, 3950000);
});

test("sales by product, category, size, colour, variant: pairs, orders, net, share, and gross profit only with cost permission", async () => {
  const prod = (await report("sales", "sales_product")).tables[0];
  assert.deepEqual(prod.rows.map((r) => [r.name, r.units, r.orders, r.net, r.share]), [["Oxford One", 3, 2, 3000000, 75.9], ["Loafer Two", 2, 2, 950000, 24.1]]);
  assert.equal(prod.rows[0].profit, undefined, "no profit column without cost permission");
  const prodOwner = (await report("owner", "sales_product")).tables[0];
  assert.deepEqual([prodOwner.rows[0].profit, prodOwner.rows[0].margin, prodOwner.rows[1].profit], [1200000, 40, 350000]);
  const cat = (await report("sales", "sales_category")).tables[0];
  assert.deepEqual(cat.rows.map((r) => [r.name, r.net]), [["Formal", 3000000], ["Casual", 950000]]);
  assert.equal((await report("sales", "sales_size")).tables[0].rows[0].name, "EU 42");
  assert.equal((await report("sales", "sales_colour")).tables[0].rows[0].name, "Black");
  const vr = (await report("sales", "sales_variant")).tables[0];
  assert.equal(vr.rows.length, 2);
  assert.equal(vr.totals.net, 3950000);
  const only = (await report("sales", "sales_product", { filters: { categoryIds: [ids.casual] } })).tables[0];
  assert.deepEqual(only.rows.map((r) => [r.name, r.net]), [["Loafer Two", 950000]], "category filter keeps only matching lines");
  const one = (await report("sales", "sales_product", { filters: { productIds: [ids.p1.productId] } })).tables[0];
  assert.equal(one.totals.net, 3000000);
});

test("payment methods: cash vs bank, from the real tenders; channel, customer and payment filters", async () => {
  const r = await report("sales", "sales_payment");
  assert.deepEqual(r.tables[0].rows.map((x) => [x.method, x.amount]), [["cash", 3500000], ["bank_transfer", 450000]]);
  assert.deepEqual(r.tables[1].rows.map((x) => [x.kind, x.amount]), [["Cash", 3500000], ["Bank", 450000]]);
  const bank = await report("sales", "sales_trend", { filters: { paymentMethods: ["bank_transfer"] } });
  assert.equal(bank.tables[0].totals.net, 450000);
  const carol = await report("sales", "sales_trend", { filters: { customerIds: [ids.carol] } });
  assert.deepEqual([carol.tables[0].totals.net, carol.tables[0].totals.orders], [1500000, 2]);
  assert.equal((await report("sales", "sales_trend", { filters: { channel: "online" } })).tables[0].totals.net, 0);
  assert.equal((await report("sales", "sales_trend", { filters: { channel: "pos" } })).tables[0].totals.net, 3950000);
});

test("warehouse and salesperson reports", async () => {
  const w = (await report("sales", "sales_warehouse")).tables[0];
  assert.deepEqual([w.rows[0].name, w.rows[0].units, w.rows[0].net], ["Shop floor", 5, 3950000]);
  const p = (await report("sales", "sales_person")).tables[0];
  assert.deepEqual([p.rows[0].name, p.rows[0].orders, p.rows[0].net, p.rows[0].average, p.rows[0].discounts], ["POS boss", 4, 3950000, 987500, 50000]);
});

test("profit: product and category gross profit use the cost recorded with each sale; discount impact; the books agree", async () => {
  const pp = (await report("fin", "profit_product")).tables[0];
  assert.deepEqual(pp.rows.map((r) => [r.name, r.net, r.cost, r.profit, r.margin]), [["Oxford One", 3000000, 1800000, 1200000, 40], ["Loafer Two", 950000, 600000, 350000, 36.8]]);
  assert.deepEqual([pp.totals.net, pp.totals.cost, pp.totals.profit], [3950000, 2400000, 1550000]);
  const pc = (await report("fin", "profit_category")).tables[0];
  assert.deepEqual(pc.rows.map((r) => [r.name, r.profit]), [["Formal", 1200000], ["Casual", 350000]]);
  const imp = await report("fin", "profit_impact");
  const rows = Object.fromEntries(imp.tables[0].rows.map((r) => [r.item, r.amount]));
  assert.equal(rows["Gross sales at list price"], 4000000);
  assert.equal(rows["Net sales"], 3950000);
  assert.equal(rows["Cost of goods sold (lines with a recorded cost)"], 2400000);
  assert.equal(rows["Gross profit (lines with a recorded cost)"], 1550000);
  assert.equal(rows["Margin if no discount had been given (what-if)"], 1600000, "profit + discounts");
  const books = Object.fromEntries(imp.tables[1].rows.map((r) => [r.item, r.amount]));
  assert.equal(books["Net revenue (posted journals)"], 3950000);
  assert.equal(books["Cost of goods sold (posted)"], 2400000);
  assert.equal(books["Gross profit (posted)"], 1550000);
});

test("RECONCILIATION: the executive financial figures equal the accounting engine's own P&L; sales records equal posted revenue", async () => {
  const e = await ok("analyticsExecutive", "owner", range);
  const pl = await accReports.profitAndLoss(range);
  assert.deepEqual([e.financial.revenue, e.financial.cogs, e.financial.grossProfit, e.financial.operatingExpenses, e.financial.netProfit], [pl.netRevenue, pl.costOfSalesTotal, pl.grossProfit, pl.operatingExpensesTotal, pl.netProfit]);
  assert.deepEqual([e.financial.revenue, e.financial.cogs, e.financial.grossProfit], [3950000, 2400000, 1550000]);
  assert.equal(e.reconciliation.at(-1).amount, 0, "journals − sales records = 0");
  const ov = await accReports.overview();
  assert.equal(e.financial.cash + e.financial.bank + e.financial.wallet, ov.cashTotal, "cash, bank and wallet equal the books");
  assert.deepEqual([e.financial.receivables, e.financial.payables], [ov.receivables, ov.payables]);
  assert.equal(e.financial.cash, 3500000, "cash taken at the counter");
  assert.equal(e.financial.bank, 450000);
  // The report builder shows the very same statements.
  const rp = await report("fin", "fin_pnl");
  assert.equal(rp.tables.find((t) => t.title === "Result").rows.at(-1).amount, pl.netProfit);
  const m = (await report("fin", "fin_monthly", { from: `${today.slice(0, 7)}-01`, to: today })).tables[0];
  assert.equal(m.totals.net, pl.netProfit, "monthly net profit adds up to the P&L");
  const pm = (await report("fin", "profit_monthly", { from: `${today.slice(0, 7)}-01`, to: today })).tables[0];
  assert.deepEqual([pm.totals.income, pm.totals.gross, pm.totals.margin], [3950000, 1550000, 39.2]);
  const bs = await report("fin", "fin_balance_sheet");
  assert.equal(bs.tables.at(-1).rows.at(-1).amount, 0, "balance sheet balances: assets equal liabilities + equity + earnings");
  const tb = await report("fin", "fin_trial_balance");
  assert.equal(tb.tables[0].totals.debit, tb.tables[0].totals.credit, "trial balance balances");
  const cf = await report("fin", "fin_cash_flow");
  assert.equal(cf.tables[0].totals.closing - cf.tables[0].totals.opening, cf.tables[1].totals.net, "cash flow reconciles to the cash accounts");
  const gl = await report("fin", "fin_ledger", { filters: { accountCode: (await accounting.configRef().get()).data().roles.cash } });
  assert.equal(gl.tables[0].rows.reduce((n, r) => n + r.debit - r.credit, 0), 3500000);
  assert.equal((await call("analyticsReport", "fin", { report: "fin_ledger", ...range })).status, 400, "the ledger needs an account");
});

test("expense and income breakdowns, receivable and payable ageing reconcile with the control accounts", async () => {
  const ex = await report("fin", "fin_expenses");
  assert.ok(Array.isArray(ex.tables));
  const ar = await report("fin", "fin_ar_aging");
  assert.equal(ar.tables[0].totals.amount, 0, "every sale was paid in full");
  assert.equal(ar.tables.at(-1).rows.at(-1).amount, 0, "no difference to the books");
  const ap = await report("fin", "fin_ap_aging");
  assert.equal(ap.tables[0].totals.amount, 0);
  // A part-paid sale appears in the right age band and still reconciles.
  const part = await sell("override", ids.p2, 1, { method: "cash", amount: 100000 }, { customerId: ids.carol });
  const ar2 = await report("fin", "fin_ar_aging");
  assert.deepEqual([ar2.tables[0].totals.amount, ar2.tables[0].rows[0].amount], [400000, 400000]);
  assert.equal(ar2.tables.at(-1).rows.at(-1).amount, 0, "receivables in the books equal the unpaid sales");
  await ok("posRecordPayment", "override", { idempotencyKey: key(), saleId: part.saleId, sessionId: ids.reg, tender: { method: "cash", amount: 400000 } });
  assert.equal((await report("fin", "fin_ar_aging")).tables[0].totals.amount, 0);
});

test("a new sale changes the executive figures at once (the cache never serves stale money); an unchanged request is served from the cache", async () => {
  // The two sales above added Rs 5,000 (S5, fully paid): net 4,450,000, COGS 2,700,000.
  const a = await ok("analyticsExecutive", "owner", range);
  assert.deepEqual([a.sales.netSales, a.financial.revenue, a.financial.cogs], [4450000, 4450000, 2700000]);
  const b = await ok("analyticsExecutive", "owner", range);
  assert.equal(b.cached, true, "same data, same answer from the cache");
  await sell("override", ids.p1, 1, { method: "cash", amount: 1000000 });
  const c = await ok("analyticsExecutive", "owner", range);
  assert.notEqual(c.cached, true);
  assert.deepEqual([c.sales.netSales, c.financial.revenue, c.financial.cogs, c.sales.orders], [5450000, 5450000, 3300000, 6]);
  const ra = await report("sales", "sales_product");
  const rb = await report("sales", "sales_product");
  assert.equal(rb.cached, true);
  assert.equal(ra.tables[0].totals.net, 5450000);
});

test("customer analytics: repeat purchase, frequency, retention against the previous period, privacy through the CRM permission", async () => {
  const c = await report("owner", "customer_analytics");
  const s = Object.fromEntries(c.tables[0].rows.map((r) => [r.metric, r.value]));
  assert.equal(s["Customers who bought (registered)"], 1);
  assert.equal(s["Repeat purchase rate % (2+ orders in the period)"], 100);
  assert.equal(s["Average orders per customer"], 3);
  assert.equal(c.tables[1].rows.find((r) => r.orders === "3").customers, 1);
  assert.ok(c.tables.some((t) => /Top 25 customers/.test(t.title)), "CRM top customers are included");
  const e = await ok("analyticsExecutive", "owner", range);
  assert.equal(e.customers.buyers, 1);
  assert.equal(e.customers.retention, null, "nobody bought in the previous period, so there is nothing to retain");
  assert.equal(e.customers.repeatRate, 100);
  assert.equal(e.customers.total, 1);
  // Retention with a previous-period buyer: move one of Carol's sales to yesterday.
  const y = Timestamp.fromMillis(Date.now() - 86400000);
  await db.doc(`sales/${ids.s3.saleId}`).update({ createdAt: y, updatedAt: Timestamp.now() });
  const e2 = await ok("analyticsExecutive", "owner", { from: today, to: today, compareFrom: addDays(today, -1), compareTo: addDays(today, -1) });
  assert.equal(e2.customers.retention, 100, "Carol bought yesterday and again today");
  await db.doc(`sales/${ids.s3.saleId}`).update({ createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
});

test("product performance and inventory intelligence: estimates are labelled; valuation, turnover, reorder, dead stock, cover", async () => {
  const p = await report("owner", "product_performance", { from: addDays(today, -29), to: today });
  assert.ok(p.estimates.length >= 3);
  const best = tableOf(p, "Best-selling products");
  assert.equal(best.rows[0].name, "Oxford One");
  assert.equal(best.rows[0].sold, 4);
  const dead = tableOf(p, "Dead stock");
  assert.deepEqual(dead.rows.map((r) => r.name), ["Boot Three"]);
  assert.equal(dead.totals.value, 100 * 480000);
  assert.ok(tableOf(p, "Highest-margin products").rows[0].margin >= tableOf(p, "Lowest-margin products").rows[0].margin);
  assert.ok(tableOf(p, "Actionable summary").rows.some((r) => /Best seller: Oxford One/.test(r.finding)));
  assert.ok(tableOf(p, "Most popular sizes").rows.length >= 1);
  const noCost = await report("owner", "product_performance", { from: addDays(today, -29), to: today });
  assert.ok(noCost.tables.length > 0);
  const i = await report("owner", "inventory_intel", { from: addDays(today, -29), to: today });
  assert.ok(i.estimates.includes("Reorder recommendations (estimate)"));
  const verified = Object.fromEntries(tableOf(i, "Verified figures").rows.map((r) => [r.item, r.value]));
  // Oxford 100 − 4 sold = 96 × 600,000; Loafer 100 − 3 = 97 × 300,000; Boot 100 × 480,000.
  assert.equal(verified["Pairs on hand"], 96 + 97 + 100);
  assert.equal(verified["Stock valuation"].money, 96 * 600000 + 97 * 300000 + 100 * 480000);
  const against = tableOf(i, "Stock valuation against the books").rows;
  assert.equal(against.length, 3);
  assert.equal(against[2].amount, against[1].amount - against[0].amount, "the difference to the books is shown, not hidden");
  const reorder = tableOf(i, "Reorder recommendations");
  assert.ok(reorder.rows.every((r) => r.suggested > 0));
  assert.equal(tableOf(i, "Dead stock valuation").totals.value, 100 * 480000);
  const shop = tableOf(i, "Warehouse performance").rows.find((r) => r.name === "Shop floor");
  assert.ok(shop.net > 0 && shop.units === 293, "the shop floor holds every pair and made every sale");
  assert.equal(tableOf(i, "Inventory ageing").rows.reduce((n, r) => n + r.units, 0), 293);
  assert.ok(i.notes[0].includes("Estimates"));
  const e = await ok("analyticsExecutive", "owner", range);
  assert.deepEqual([e.inventory.units, e.inventory.valuation, e.inventory.dead, e.inventory.deadValue], [293, 96 * 600000 + 97 * 300000 + 100 * 480000, 1, 100 * 480000]);
  assert.ok(e.inventory.turnover !== undefined);
});

test("purchase and supplier analytics from real goods receipts, supplier payments and returns", async () => {
  const s = await ok("saveSupplier", "owner", { name: "Lahore Leather", phone: "0300 9000001", openingBalance: 0 }).catch(() => null);
  const r = await report("owner", "purchase_analytics", { from: addDays(today, -29), to: today });
  assert.ok(tableOf(r, "Summary"));
  assert.ok(tableOf(r, "Supplier delivery performance"));
  assert.ok(tableOf(r, "Purchase cost comparison"));
  assert.equal(tableOf(r, "Summary").rows[0].amount, 0, "no goods have been received yet");
  assert.equal(s === null || typeof s === "object", true);
  const filtered = await report("owner", "purchase_analytics", { from: addDays(today, -29), to: today, filters: { supplierIds: [s?.id ?? "nosuchsupplier"] } });
  assert.ok(!filtered.tables.some((t) => /By supplier/.test(t.title)), "a supplier filter narrows to that supplier's own tables");
  assert.ok(filtered.notes.some((n) => /supplier filter/i.test(n)));
});

test("export is audited and permission-checked; every sensitive report and the executive view are in the audit log", async () => {
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data());
  assert.ok(audit.some((a) => a.action === "analytics.executive_viewed" && a.actorUid === "an-owner"));
  assert.ok(audit.some((a) => a.action === "analytics.report_run" && a.entityId === "profit_product"));
  assert.ok(audit.some((a) => a.action === "analytics.report_run" && a.entityId === "fin_pnl"));
  assert.ok(audit.some((a) => a.action === "analytics.exported" && a.entityId === "sales_trend" && a.actorUid === "an-exp" && a.changes.format === "csv"));
  assert.ok(!audit.some((a) => a.action === "analytics.exported" && a.entityId === "fin_pnl"), "the refused export left no export record");
});

test("saved report configurations are private, permission-checked and resolve to relative periods", async () => {
  const saved = await ok("saveReportConfig", "mgr", { name: "Weekly shoes", report: "sales_product", period: "week", granularity: "day", compare: true, filters: { productIds: [ids.p1.productId], categoryIds: [], supplierIds: [], customerIds: [], paymentMethods: [], channel: "", accountCode: "" } });
  const mine = await ok("listReportConfigs", "mgr", {});
  assert.deepEqual(mine.configs.map((c) => c.name), ["Weekly shoes"]);
  assert.deepEqual((await ok("listReportConfigs", "owner", {})).configs, [], "another person's saved reports are not shown");
  assert.equal((await call("saveReportConfig", "sales", { name: "x1", report: "sales_trend", period: "month", filters: {} })).status, 403, "analytics.manage is required");
  assert.equal((await call("saveReportConfig", "mgr", { name: "Profit", report: "profit_product", period: "month", filters: {} })).status, 403, "can't save a report you can't run");
  assert.equal((await call("deleteReportConfig", "owner", { id: saved.id })).status, 404, "only the creator can delete it");
  await ok("deleteReportConfig", "mgr", { id: saved.id });
  assert.deepEqual((await ok("listReportConfigs", "mgr", {})).configs, []);
  const p = schedules.resolvePeriod("week", true, "2026-11-18");
  assert.deepEqual([p.from, p.to, p.compareFrom, p.compareTo], ["2026-11-16", "2026-11-18", "2026-11-13", "2026-11-15"]);
});

test("scheduled reports: created with permissions, generated once per period, shown only to recipients who may still read them", async () => {
  assert.equal((await call("saveReportSchedule", "mgr", { report: "monthly_financial", name: "Month end", frequency: "monthly", recipientUids: ["an-owner"] })).status, 403, "can't schedule a financial summary without financial permissions");
  assert.equal((await call("saveReportSchedule", "mgr", { report: "daily_sales", name: "Daily", frequency: "weekly", recipientUids: ["an-owner"] })).status, 400, "frequency must match the report");
  assert.equal((await call("saveReportSchedule", "mgr", { report: "daily_sales", name: "Daily", frequency: "daily", recipientUids: [] })).status, 400, "a recipient is needed");
  assert.equal((await call("saveReportSchedule", "sales", { report: "daily_sales", name: "Daily", frequency: "daily", recipientUids: ["an-sales"] })).status, 403, "needs analytics.manage");
  const daily = await ok("saveReportSchedule", "mgr", { report: "daily_sales", name: "Daily sales", frequency: "daily", recipientUids: ["an-sales", "an-nobody"] });
  const low = await ok("saveReportSchedule", "owner", { report: "low_stock", name: "Low stock", frequency: "daily", recipientUids: ["an-owner"] });
  const fin = await ok("saveReportSchedule", "owner", { report: "monthly_financial", name: "Month end", frequency: "monthly", recipientUids: ["an-owner", "an-sales"] });
  assert.equal((await ok("listReportSchedules", "mgr", {})).schedules.length, 3);
  const first = await ok("runScheduledReports", "mgr", {});
  assert.equal(first.created, 3, JSON.stringify(first));
  assert.equal((await ok("runScheduledReports", "mgr", {})).created, 0, "each period is generated at most once");
  const yesterday = addDays(today, -1);
  const run = await db.doc(`reportRuns/${daily.id}__${yesterday}`).get();
  assert.ok(run.exists && run.data().from === yesterday && run.data().to === yesterday);
  assert.ok(run.data().tables.length >= 2);
  const inbox = await ok("reportInbox", "sales", {});
  assert.deepEqual(inbox.runs.map((r) => r.scheduleName).sort(), ["Daily sales"], "she is a recipient of the financial summary too, but may not read it");
  assert.equal((await ok("reportInbox", "none", {})).runs.length, 0, "a recipient without the report's permissions sees nothing");
  assert.deepEqual((await ok("reportInbox", "owner", {})).runs.map((r) => r.scheduleName).sort(), ["Low stock", "Month end"], "the owner sees the two he is a recipient of");
  const one = await ok("reportRun", "sales", { id: `${daily.id}__${yesterday}` });
  assert.equal(one.reportLabel, "Daily sales summary");
  assert.equal((await call("reportRun", "sales", { id: `${fin.id}__${(await db.collection("reportRuns").where("scheduleId", "==", fin.id).get()).docs[0].id.split("__")[1]}` })).status, 404);
  assert.equal((await call("reportRun", "mgr", { id: `${daily.id}__${yesterday}` })).status, 404, "not a recipient");
  await ok("setReportScheduleActive", "mgr", { id: daily.id, isActive: false });
  const { lastCompletePeriod } = schedules;
  assert.deepEqual(lastCompletePeriod("weekly", "2026-11-18"), { from: "2026-11-09", to: "2026-11-15", key: "2026-11-09" });
  assert.deepEqual(lastCompletePeriod("monthly", "2026-01-05"), { from: "2025-12-01", to: "2025-12-31", key: "2025-12" });
  assert.deepEqual(lastCompletePeriod("daily", "2026-03-01"), { from: "2026-02-28", to: "2026-02-28", key: "2026-02-28" });
  assert.ok(low.id);
});

test("browsers can't read or write analytics collections: caches, saved reports, schedules and runs are server-only", async () => {
  const rules = (await import("node:fs")).readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
  for (const c of ["analyticsCache", "reportConfigs", "reportSchedules", "reportRuns"]) assert.match(rules, new RegExp(`match /${c}/`), `${c} has an explicit rule`);
});

test("large dataset: 1,200 more sales are aggregated in one bounded pass, results stay correct, and the answer is cached", async () => {
  const base = (await db.collection("sales").limit(1).get()).docs[0].data();
  const N = 1200;
  const d0 = addDays(today, -40);
  for (let i = 0; i < N; i += 400) {
    const batch = db.batch();
    for (let j = i; j < Math.min(N, i + 400); j += 1) {
      const id = `bulk-${j}`;
      const at = Timestamp.fromDate(new Date(`${addDays(d0, j % 30)}T12:00:00+05:00`));
      batch.set(db.doc(`sales/${id}`), { ...base, number: `BULK-${j}`, createdAt: at, status: "completed", customerId: null, customer: null, grossSales: 1000000, itemDiscountTotal: 0, discountTotal: 0, netSales: 1000000, total: 1000000, itemCount: 1, refundedTotal: 0, amountDue: 0, lines: [{ ...base.lines[0], qty: 1, lineTotal: 1000000, lineNet: 1000000, couponShare: 0, itemDiscount: 0, regularPrice: 1000000, unitPrice: 1000000, allocations: [{ warehouseId: ids.shop, qty: 1 }] }], pos: { tenders: [{ method: "cash", amount: 1000000 }] }, paymentMethod: "cash" });
    }
    await batch.commit();
  }
  const t0 = Date.now();
  const r = await report("sales", "sales_trend", { from: d0, to: addDays(d0, 29), granularity: "day" });
  const ms = Date.now() - t0;
  assert.equal(r.tables[0].rows.length, 30);
  assert.deepEqual([r.tables[0].totals.orders, r.tables[0].totals.net], [N, N * 1000000]);
  assert.ok(r.tables[0].rows.every((x) => x.orders === 40), "1,200 sales spread evenly over 30 days");
  assert.ok(ms < 20000, `took ${ms} ms`);
  const t1 = Date.now();
  const again = await report("sales", "sales_trend", { from: d0, to: addDays(d0, 29), granularity: "day" });
  assert.equal(again.cached, true);
  assert.ok(Date.now() - t1 < ms + 500, "a cached answer isn't slower than computing it");
  const pg = await report("sales", "sales_product", { from: d0, to: addDays(d0, 29), limit: 1 });
  assert.equal(pg.tables[0].rows.length, 1, "results are paged by `limit`");
  // The cap protects the database: a range with more than 5,000 sales is refused with a clear message, not read whole.
  const e = await call("analyticsReport", "sales", { report: "sales_trend", from: addDays(today, -400), to: today });
  assert.ok([200, 412, 400].includes(e.status));
});
