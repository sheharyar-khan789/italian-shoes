/**
 * Business intelligence: the executive dashboard and every analytics report. This is a READING layer over the records the earlier phases
 * already keep. It never re-implements accounting: revenue, cost of goods sold, expenses, profit, cash, receivables and payables come from
 * the posted journals through the accounting services (profitAndLoss, balancesAsOf, cashFlow, trialBalance …); sales, stock, customer and
 * purchase figures come from the saved sales (and their saved cost snapshots), the inventory scan, the CRM and the purchase records.
 *
 * Every report comes back in one shape: { title, from, to, tables: [{ title, columns, rows, totals }], charts, notes, estimates }.
 * `estimates` lists the tables that are forecasts or rules of thumb (days of stock left, reorder quantities, slow / dead stock), so they are
 * never mistaken for verified accounting figures.
 */
import { pktDateKey, naturalBalance } from "../shared/accounting.js";
import { daysBetween, addDays } from "../shared/finance.js";
import { UNCOUNTED_SALE_STATUSES } from "../shared/sales.js";
import { METHOD_KIND } from "../shared/finance.js";
import * as A from "../shared/analytics.js";
import { AppError } from "../lib/errors.js";
import { db } from "../lib/admin.js";
import { balancesAsOf, profitAndLoss, balanceSheet, cashFlow, trialBalance, generalLedger } from "./accountingReports.js";
import { financeReport } from "./financeReports.js";
import { inventoryItems, inventoryAlerts } from "./inventoryInsights.js";
import { crmDashboard, crmReport } from "./crmInsights.js";
import { purchaseReportTables } from "./purchaseDashboard.js";
import { MAX_DOCS, col, table, sum, pct, dayOf, inRange, byIds, accountingConfig, loadFacts, saleTotals, groupFacts, cached } from "./analyticsData.js";

const chart = (type, title, unit, labels, series) => ({ type, title, unit, labels, series });
const needBooks = async () => {
  const config = await accountingConfig();
  if (!config) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  return config;
};
const natural = (config, map, code) => (code && config.accounts[code] ? naturalBalance(config.accounts[code], map.get(code)?.debit ?? 0, map.get(code)?.credit ?? 0) : 0);

/** Cash, bank, receivables, payables and stock value as the books show them on a date. */
async function positionAsOf(config, dateKey) {
  const bal = await balancesAsOf(dateKey);
  const bankParent = config.accounts[config.roles.bank]?.parent;
  const cash = natural(config, bal, config.roles.cash);
  const wallet = natural(config, bal, config.roles.wallet_clearing);
  const bank = Object.entries(config.accounts).filter(([code, a]) => !a.isGroup && a.parent === bankParent && code !== config.roles.cash).reduce((n, [code]) => n + natural(config, bal, code), 0);
  return { cash, bank, wallet, receivables: natural(config, bal, config.roles.accounts_receivable) + natural(config, bal, config.roles.cod_receivable), payables: natural(config, bal, config.roles.accounts_payable), inventory: natural(config, bal, config.roles.inventory) };
}

/* ───────── Period aggregation for the sales trend ───────── */

/** Per-bucket sales figures from facts (line level) and sales (returns). */
function bucketAgg(facts, sales, g, lineFilter) {
  /** @type {Map<string, any>} */
  const m = new Map();
  const get = (k) => m.get(k) ?? (m.set(k, { orders: new Set(), units: 0, gross: 0, discounts: 0, net: 0, returns: 0 }), m.get(k));
  for (const f of facts) {
    if (!f.counted) continue;
    const r = get(A.bucketOf(f.date, g));
    r.orders.add(f.saleId);
    r.units += f.qty;
    r.gross += f.gross;
    r.discounts += f.itemDiscount + f.couponShare;
    r.net += f.net;
  }
  if (!lineFilter) for (const s of sales) if (s.status !== "cancelled" && (s.refundedTotal ?? 0) > 0) get(A.bucketOf(dayOf(s.createdAt), g)).returns += s.refundedTotal;
  return m;
}

/* ───────── Sales reports ───────── */

async function salesTrend(p, ctx) {
  const { from, to, compareFrom, compareTo, granularity: g, filters } = p;
  const cur = await loadFacts({ from, to }, filters, ctx);
  const buckets = A.bucketsBetween(from, to, g);
  const a = bucketAgg(cur.facts, cur.sales, g, cur.lineFilter);
  let b = null;
  let prevBuckets = [];
  if (compareFrom) {
    const prev = await loadFacts({ from: compareFrom, to: compareTo }, filters, ctx);
    prevBuckets = A.bucketsBetween(compareFrom, compareTo, g);
    b = bucketAgg(prev.facts, prev.sales, g, prev.lineFilter);
  }
  const rows = buckets.map((k, i) => {
    const r = a.get(k);
    const pr = b ? b.get(prevBuckets[i] ?? "") : null;
    const net = r?.net ?? 0;
    return { period: k, orders: r?.orders.size ?? 0, units: r?.units ?? 0, gross: r?.gross ?? 0, discounts: r?.discounts ?? 0, net, returns: cur.lineFilter ? null : (r?.returns ?? 0), ...(b ? { prevPeriod: prevBuckets[i] ?? "", prevNet: pr?.net ?? 0, change: A.growth(net, pr?.net ?? 0) } : {}) };
  });
  const totals = { period: "Total", orders: sum(rows, "orders"), units: sum(rows, "units"), gross: sum(rows, "gross"), discounts: sum(rows, "discounts"), net: sum(rows, "net"), returns: cur.lineFilter ? null : sum(rows, "returns"), ...(b ? { prevPeriod: "", prevNet: sum(rows, "prevNet"), change: A.growth(sum(rows, "net"), sum(rows, "prevNet")) } : {}) };
  const cols = [col("period", g === "day" ? "Date" : g === "week" ? "Week starting" : g === "month" ? "Month" : "Year"), col("orders", "Orders", "number"), col("units", "Pairs", "number"), col("gross", "Gross sales", "money"), col("discounts", "Discounts", "money"), col("net", "Net sales", "money"), col("returns", "Refunded", "money"), ...(b ? [col("prevPeriod", "Compared with"), col("prevNet", "Net sales then", "money"), col("change", "Change %", "number")] : [])];
  const series = [{ name: "Net sales", values: rows.map((r) => r.net) }, ...(b ? [{ name: "Comparison period", values: rows.map((r) => r.prevNet) }] : [])];
  return { title: "Sales trend", tables: [table(`By ${g}`, cols, rows, totals)], charts: [chart("line", "Net sales", "money", rows.map((r) => r.period), series)], notes: ["Counted sales only (cancelled, returned and refunded sales are left out). Net sales = list price − discounts, before delivery and tax. “Refunded” is money refunded on sales made in that period.", ...(cur.lineFilter ? ["A product or category filter is on, so refunds can't be split by item and are not shown."] : [])] };
}

async function salesYear(p, ctx) {
  const { from, to, filters } = p;
  const pf = A.yearBefore(from);
  const pt = A.yearBefore(to);
  const [cur, prev] = await Promise.all([loadFacts({ from, to }, filters, ctx), loadFacts({ from: pf, to: pt }, filters, ctx)]);
  const ca = bucketAgg(cur.facts, cur.sales, "month", true);
  const pa = bucketAgg(prev.facts, prev.sales, "month", true);
  const months = A.bucketsBetween(from, to, "month");
  const rows = months.map((m) => {
    const pm = `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
    const c = ca.get(m);
    const q = pa.get(pm);
    return { month: m, net: c?.net ?? 0, orders: c?.orders.size ?? 0, prevMonth: pm, prevNet: q?.net ?? 0, prevOrders: q?.orders.size ?? 0, change: A.growth(c?.net ?? 0, q?.net ?? 0) };
  });
  const totals = { month: "Total", net: sum(rows, "net"), orders: sum(rows, "orders"), prevMonth: "", prevNet: sum(rows, "prevNet"), prevOrders: sum(rows, "prevOrders"), change: A.growth(sum(rows, "net"), sum(rows, "prevNet")) };
  return { title: "Year-on-year sales comparison", tables: [table(`${from} to ${to} against ${pf} to ${pt}`, [col("month", "Month"), col("net", "Net sales", "money"), col("orders", "Orders", "number"), col("prevMonth", "Same month last year"), col("prevNet", "Net sales then", "money"), col("prevOrders", "Orders then", "number"), col("change", "Change %", "number")], rows, totals)], charts: [chart("column", "Net sales: this year and last year", "money", rows.map((r) => r.month), [{ name: "This period", values: rows.map((r) => r.net) }, { name: "Same period last year", values: rows.map((r) => r.prevNet) }])], notes: ["Change % is blank where last year had no sales to compare with."] };
}

/** One ranked table by a grouping of the sold lines. */
function groupReport(title, label, facts, keyFn, canSeeCost, limit, chartType = "bar") {
  const groups = groupFacts(facts, keyFn).sort((a, b) => b.net - a.net);
  const total = sum(groups, "net");
  const rows = groups.slice(0, limit).map((g) => ({ name: g.key, units: g.units, orders: g.orders, gross: g.gross, discounts: g.itemDiscount + g.couponShare, net: g.net, share: pct(g.net, total), ...(canSeeCost ? { profit: g.profit, margin: A.marginPercent(g.profit, g.costKnownNet) } : {}) }));
  const cols = [col("name", label), col("units", "Pairs", "number"), col("orders", "Orders", "number"), col("gross", "Gross", "money"), col("discounts", "Discounts", "money"), col("net", "Net sales", "money"), col("share", "Share %", "number"), ...(canSeeCost ? [col("profit", "Gross profit*", "money"), col("margin", "Margin %", "number")] : [])];
  const totals = { name: `Total${groups.length > limit ? " (all)" : ""}`, units: sum(groups, "units"), orders: null, gross: sum(groups, "gross"), discounts: sum(groups, "itemDiscount") + sum(groups, "couponShare"), net: total, share: 100, ...(canSeeCost ? { profit: sum(groups, "profit"), margin: A.marginPercent(sum(groups, "profit"), sum(groups, "costKnownNet")) } : {}) };
  const top = rows.slice(0, 10);
  return { tables: [table(title, cols, rows, totals)], charts: [chart(chartType, `${title}: net sales`, "money", top.map((r) => r.name), [{ name: "Net sales", values: top.map((r) => r.net) }])], notes: canSeeCost ? ["*Gross profit only counts lines whose cost was recorded with the sale."] : [] };
}

const SALES_GROUPS = {
  sales_product: ["Sales by product", "Product", (f) => f.productName, "bar"],
  sales_category: ["Sales by category", "Category", (f) => f.categoryName, "pie"],
  sales_size: ["Sales by size", "Size", (f) => f.size || "—", "column"],
  sales_colour: ["Sales by colour", "Colour", (f) => f.colour || "—", "column"],
  sales_variant: ["Sales by variant", "Variant", (f) => `${f.productName} — ${f.colour} / ${f.size}`, "bar"],
};

async function salesGroup(p, ctx) {
  const [title, label, keyFn, type] = SALES_GROUPS[p.report];
  const d = await loadFacts(p, p.filters, ctx);
  const r = groupReport(title, label, d.facts, keyFn, ctx.canSeeCost, p.limit, type);
  return { title, ...r };
}

/** The cash / bank / wallet / COD split of what customers paid (split POS payments are split exactly). */
async function salesPayment(p, ctx) {
  const d = await loadFacts(p, p.filters, ctx);
  /** @type {Record<string, { sales: number, amount: number }>} */
  const by = {};
  const add = (m, amount) => {
    const r = (by[m] ??= { sales: 0, amount: 0 });
    r.sales += 1;
    r.amount += amount;
  };
  for (const s of d.sales) {
    if (UNCOUNTED_SALE_STATUSES.includes(s.status)) continue;
    const tenders = s.pos?.tenders;
    if (tenders?.length) for (const t of tenders) add(t.method, t.amount);
    else add(s.paymentMethod ?? "other", s.total ?? 0);
  }
  const kind = (m) => (m === "cod" ? "Cash on delivery" : (METHOD_KIND[m] === "cash" ? "Cash" : METHOD_KIND[m] === "bank" ? "Bank" : METHOD_KIND[m] === "wallet" ? "Mobile wallet" : "Other"));
  const total = Object.values(by).reduce((n, r) => n + r.amount, 0);
  const rows = Object.entries(by).map(([m, r]) => ({ method: m, kind: kind(m), sales: r.sales, amount: r.amount, share: pct(r.amount, total) })).sort((a, b) => b.amount - a.amount);
  const groups = {};
  for (const r of rows) groups[r.kind] = (groups[r.kind] ?? 0) + r.amount;
  const kinds = Object.entries(groups).map(([k, amount]) => ({ kind: k, amount, share: pct(amount, total) })).sort((a, b) => b.amount - a.amount);
  return { title: "Payment method analysis", tables: [table("By method", [col("method", "Method"), col("kind", "Type"), col("sales", "Sales", "number"), col("amount", "Amount", "money"), col("share", "Share %", "number")], rows, { method: "Total", kind: "", sales: null, amount: total, share: 100 }), table("Cash vs bank vs wallet", [col("kind", "Type"), col("amount", "Amount", "money"), col("share", "Share %", "number")], kinds)], charts: [chart("pie", "Payment methods", "money", rows.map((r) => r.method), [{ name: "Amount", values: rows.map((r) => r.amount) }])], notes: ["Amounts are the sale totals (including delivery and tax); a POS sale paid in several ways is split by what each payment covered. This is how the sale was to be paid, not a bank reconciliation."] };
}

async function salesWarehouse(p, ctx) {
  const d = await loadFacts(p, p.filters, ctx);
  const whs = await db.collection("warehouses").get();
  const names = new Map(whs.docs.map((w) => [w.id, w.data().name]));
  names.set("main", names.get("main") ?? "Main warehouse");
  /** @type {Map<string, any>} */
  const by = new Map();
  for (const f of d.facts) {
    if (!f.counted) continue;
    const allocs = f.allocations?.length ? f.allocations : [{ warehouseId: f.warehouseIds?.[0] ?? "main", qty: f.qty }];
    for (const a of allocs) {
      const r = by.get(a.warehouseId) ?? { name: names.get(a.warehouseId) ?? a.warehouseId, units: 0, orders: new Set(), net: 0, cost: 0, costNet: 0 };
      const share = f.qty ? a.qty / f.qty : 0;
      r.units += a.qty;
      r.orders.add(f.saleId);
      r.net += Math.round(f.net * share);
      if (f.cost !== null) {
        r.cost += Math.round(f.cost * share);
        r.costNet += Math.round(f.net * share);
      }
      by.set(a.warehouseId, r);
    }
  }
  const rows = [...by.values()].map((r) => ({ name: r.name, units: r.units, orders: r.orders.size, net: r.net, ...(ctx.canSeeCost ? { profit: r.costNet - r.cost } : {}) })).sort((a, b) => b.net - a.net);
  return { title: "Sales by shop / warehouse", tables: [table("By warehouse (pairs are credited to the warehouse they were taken from)", [col("name", "Warehouse"), col("units", "Pairs", "number"), col("orders", "Sales touching it", "number"), col("net", "Net sales", "money"), ...(ctx.canSeeCost ? [col("profit", "Gross profit*", "money")] : [])], rows, { name: "Total", units: sum(rows, "units"), orders: null, net: sum(rows, "net"), ...(ctx.canSeeCost ? { profit: sum(rows, "profit") } : {}) })], charts: [chart("bar", "Net sales by warehouse", "money", rows.map((r) => r.name), [{ name: "Net sales", values: rows.map((r) => r.net) }])], notes: ctx.canSeeCost ? ["*Gross profit only counts lines whose cost was recorded."] : [] };
}

async function salesPerson(p, ctx) {
  const d = await loadFacts(p, p.filters, ctx);
  const rows = groupFacts(d.facts, (f) => (f.cashierUid ? `${f.cashierName ?? f.cashierUid}` : "Online orders (no salesperson)")).map((g) => ({ name: g.key, orders: g.orders, units: g.units, net: g.net, average: g.orders ? Math.round(g.net / g.orders) : 0, discounts: g.itemDiscount + g.couponShare, discountRate: pct(g.itemDiscount + g.couponShare, g.gross) })).sort((a, b) => b.net - a.net);
  return { title: "Salesperson performance", tables: [table("By cashier", [col("name", "Salesperson"), col("orders", "Sales", "number"), col("units", "Pairs", "number"), col("net", "Net sales", "money"), col("average", "Average sale", "money"), col("discounts", "Discounts given", "money"), col("discountRate", "Discount % of list", "number")], rows, { name: "Total", orders: sum(rows, "orders"), units: sum(rows, "units"), net: sum(rows, "net"), average: sum(rows, "orders") ? Math.round(sum(rows, "net") / sum(rows, "orders")) : 0, discounts: sum(rows, "discounts"), discountRate: null })], charts: [chart("bar", "Net sales by salesperson", "money", rows.map((r) => r.name), [{ name: "Net sales", values: rows.map((r) => r.net) }])], notes: ["The cashier who rang the sale up at the POS."] };
}

/* ───────── Profitability ───────── */

async function profitGroup(p, ctx) {
  const byCategory = p.report === "profit_category";
  const d = await loadFacts(p, p.filters, ctx);
  const groups = groupFacts(d.facts, (f) => (byCategory ? f.categoryName : f.productName)).filter((g) => g.lines - g.linesWithoutCost > 0).sort((a, b) => b.profit - a.profit);
  const rows = groups.slice(0, p.limit).map((g) => ({ name: g.key, units: g.units, net: g.net, cost: g.cost, profit: g.profit, margin: A.marginPercent(g.profit, g.costKnownNet), uncosted: g.linesWithoutCost }));
  const totals = { name: "Total", units: sum(groups, "units"), net: sum(groups, "net"), cost: sum(groups, "cost"), profit: sum(groups, "profit"), margin: A.marginPercent(sum(groups, "profit"), sum(groups, "costKnownNet")), uncosted: sum(groups, "linesWithoutCost") };
  const noCost = sum(groupFacts(d.facts, () => "all"), "linesWithoutCost");
  return { title: byCategory ? "Gross profit by category" : "Gross profit by product", tables: [table(byCategory ? "By category" : "By product", [col(byCategory ? "name" : "name", byCategory ? "Category" : "Product"), col("units", "Pairs", "number"), col("net", "Net sales", "money"), col("cost", "Cost of goods", "money"), col("profit", "Gross profit", "money"), col("margin", "Margin %", "number"), col("uncosted", "Lines without a cost", "number")], rows, totals)], charts: [chart("bar", "Gross profit", "money", rows.slice(0, 10).map((r) => r.name), [{ name: "Gross profit", values: rows.slice(0, 10).map((r) => r.profit) }])], notes: ["Cost is the unit cost recorded with each sale (the weighted-average cost at the time), never today's cost.", "Net sales here are after discounts and before tax and delivery. Gross profit is not net profit: expenses are not deducted.", ...(noCost ? [`${noCost} sold line(s) have no recorded cost and are left out of profit and margin.`] : [])] };
}

/** Gross profit, margin and discount / return impact from the saved sales, beside what the books say. */
async function profitImpact(p, ctx) {
  const d = await loadFacts(p, p.filters, ctx);
  const counted = d.facts.filter((f) => f.counted);
  const t = saleTotals(d.sales);
  const withCost = counted.filter((f) => f.cost !== null);
  const net = sum(withCost, "net");
  const cost = sum(withCost, "cost");
  const profit = net - cost;
  const discounts = sum(withCost, "itemDiscount") + sum(withCost, "couponShare");
  const rows = [
    { item: "Gross sales at list price", amount: t.gross, note: "Every counted sale" },
    { item: "Less: discounts (price markdowns, coupons, manual, customer discounts)", amount: -(t.itemDiscounts + t.discounts), note: pct(t.itemDiscounts + t.discounts, t.gross) === null ? "" : `${pct(t.itemDiscounts + t.discounts, t.gross)}% of list` },
    { item: "Net sales", amount: t.net, note: "Before delivery and tax" },
    { item: "Cost of goods sold (lines with a recorded cost)", amount: cost, note: `${withCost.length} of ${counted.length} sold lines` },
    { item: "Gross profit (lines with a recorded cost)", amount: profit, note: A.marginPercent(profit, net) === null ? "" : `${A.marginPercent(profit, net)}% margin` },
    { item: "Margin if no discount had been given (what-if)", amount: net + discounts - cost, note: `${A.marginPercent(net + discounts - cost, net + discounts) ?? "—"}% — an illustration, not an accounting figure` },
    { item: "Refunded to customers (sales made in this period)", amount: t.returns, note: `${t.returnedSales} sale(s) fully returned or refunded` },
  ];
  let books = null;
  const config = await accountingConfig();
  if (config) {
    const pl = await profitAndLoss({ from: p.from, to: p.to });
    const code = (r) => pl.revenue.find((x) => x.code === config.roles[r]);
    books = [
      { item: "Net revenue (posted journals)", amount: pl.netRevenue, note: "" },
      { item: "Sales discounts account (posted)", amount: code("sales_discounts")?.amount ?? 0, note: "Shown as a deduction" },
      { item: "Sales returns account (posted)", amount: code("sales_returns")?.amount ?? 0, note: "Shown as a deduction" },
      { item: "Cost of goods sold (posted)", amount: pl.costOfSalesTotal, note: pl.incomplete.note },
      { item: "Gross profit (posted)", amount: pl.grossProfit, note: "" },
    ];
  }
  return { title: "Discount and return impact", tables: [table("From the saved sales and their recorded costs", [col("item", "Item"), col("amount", "Amount", "money"), col("note", "Note")], rows), ...(books ? [table("From the accounting books (verified)", [col("item", "Item"), col("amount", "Amount", "money"), col("note", "Note")], books)] : [])], charts: [chart("column", "Where list-price sales went", "money", ["Cost of goods", "Gross profit", "Discounts"], [{ name: "Amount", values: [cost, Math.max(0, profit), discounts] }])], notes: ["The two tables can differ: the books post returns when a refund is recorded and may include sales whose cost was missing. The books are the verified figure.", ...(d.lineFilter ? ["A product or category filter is on, so sale-level figures (refunds, discounts on whole sales) are for matching sales."] : [])] };
}

/** Monthly revenue, cost, gross and net profit and margin, straight from the posted month totals. */
async function profitMonthly(p) {
  await needBooks();
  const fr = await financeReport({ report: "monthly", from: p.from, to: p.to });
  const t = fr.tables[0];
  const rows = t.rows.map((r) => ({ ...r, margin: A.marginPercent(r.gross, r.income), netMargin: A.marginPercent(r.net, r.income) }));
  const totals = { ...t.totals, margin: A.marginPercent(t.totals.gross, t.totals.income), netMargin: A.marginPercent(t.totals.net, t.totals.income) };
  return { title: "Monthly profit and margin", tables: [table("By month (whole months, from posted journals)", [...t.columns, col("margin", "Gross margin %", "number"), col("netMargin", "Net margin %", "number")], rows, totals)], charts: [chart("line", "Net profit by month", "money", rows.map((r) => r.month), [{ name: "Net profit", values: rows.map((r) => r.net) }]), chart("column", "Revenue and expenses by month", "money", rows.map((r) => r.month), [{ name: "Income", values: rows.map((r) => r.income) }, { name: "Expenses (incl. cost of sales)", values: rows.map((r) => r.cost + r.expenses) }])], notes: fr.notes };
}

async function profitExpenses(p) {
  await needBooks();
  const pl = await profitAndLoss({ from: p.from, to: p.to });
  const rows = pl.operatingExpenses.map((r) => ({ code: r.code, name: r.name, amount: r.amount, ofRevenue: pct(r.amount, pl.netRevenue), ofExpenses: pct(r.amount, pl.operatingExpensesTotal) })).sort((a, b) => b.amount - a.amount);
  const cat = await financeReport({ report: "expensecat", from: p.from, to: p.to }).catch(() => null);
  return { title: "Operating expense analysis", tables: [table("Operating expenses (posted journals)", [col("code", "Account"), col("name", "Name"), col("amount", "Amount", "money"), col("ofRevenue", "% of net revenue", "number"), col("ofExpenses", "% of expenses", "number")], rows, { code: "", name: "Total", amount: pl.operatingExpensesTotal, ofRevenue: pct(pl.operatingExpensesTotal, pl.netRevenue), ofExpenses: 100 }), ...(cat ? cat.tables : [])], charts: [chart("pie", "Operating expenses", "money", rows.map((r) => r.name), [{ name: "Amount", values: rows.map((r) => r.amount) }])], notes: ["Operating expenses are everything except cost of goods sold, from the posted journals.", ...(cat?.notes ?? [])] };
}

/* ───────── Financial statements (the accounting engine's own figures) ───────── */

const flat = (rows) => rows.map((r) => ({ code: r.code, name: r.name, amount: r.amount }));

async function finPnl(p) {
  await needBooks();
  const pl = await profitAndLoss({ from: p.from, to: p.to });
  const c = [col("code", "Account"), col("name", "Name"), col("amount", "Amount", "money")];
  return { title: "Profit & loss statement", tables: [table("Revenue", c, flat(pl.revenue), { code: "", name: "Net revenue", amount: pl.netRevenue }), table("Cost of sales", c, flat(pl.costOfSales), { code: "", name: "Total cost of sales", amount: pl.costOfSalesTotal }), table("Result", [col("name", "Line"), col("amount", "Amount", "money")], [{ name: "Gross profit", amount: pl.grossProfit }, { name: "Operating expenses", amount: pl.operatingExpensesTotal }, { name: "Net profit", amount: pl.netProfit }]), table("Operating expenses", c, flat(pl.operatingExpenses), { code: "", name: "Total operating expenses", amount: pl.operatingExpensesTotal })], charts: [chart("column", "Profit and loss", "money", ["Net revenue", "Cost of sales", "Operating expenses", "Net profit"], [{ name: "Amount", values: [pl.netRevenue, pl.costOfSalesTotal, pl.operatingExpensesTotal, pl.netProfit] }])], notes: pl.incomplete.note ? [pl.incomplete.note] : [] };
}

async function finBalanceSheet(p) {
  await needBooks();
  const b = await balanceSheet({ asOf: p.to });
  const c = [col("code", "Account"), col("name", "Name"), col("amount", "Amount", "money")];
  return { title: `Balance sheet as of ${p.to}`, tables: [table("Assets", c, flat(b.assets), { code: "", name: "Total assets", amount: b.totals.assets }), table("Liabilities", c, flat(b.liabilities), { code: "", name: "Total liabilities", amount: b.totals.liabilities }), table("Equity", c, flat(b.equity), { code: "", name: "Total equity", amount: b.totals.equity }), table("Check", [col("name", "Line"), col("amount", "Amount", "money")], [{ name: "Current earnings (not yet closed to equity)", amount: b.totals.currentEarnings }, { name: "Liabilities + equity + current earnings", amount: b.totals.liabilitiesAndEquity }, { name: b.balanced ? "Balanced: assets equal liabilities + equity" : "NOT BALANCED — see Accounting → Reconciliation", amount: b.totals.assets - b.totals.liabilitiesAndEquity }])], charts: [chart("column", "Balance sheet", "money", ["Assets", "Liabilities", "Equity + earnings"], [{ name: "Amount", values: [b.totals.assets, b.totals.liabilities, b.totals.equity + b.totals.currentEarnings] }])], notes: [b.note] };
}

async function finCashFlow(p) {
  await needBooks();
  const c = await cashFlow({ from: p.from, to: p.to });
  const rows = Object.entries(c.bySource).map(([source, t]) => ({ source, in: t.in, out: t.out, net: t.in - t.out })).sort((a, b) => b.in + b.out - (a.in + a.out));
  return { title: "Cash flow statement", tables: [table("Cash, bank and wallet accounts", [col("code", "Account"), col("name", "Name"), col("opening", "Opening", "money"), col("closing", "Closing", "money")], c.accounts, { code: "", name: "Total", opening: c.openingTotal, closing: c.closingTotal }), table("Money in and out, by what caused it", [col("source", "Source"), col("in", "Money in", "money"), col("out", "Money out", "money"), col("net", "Net", "money")], rows, { source: "Total", in: c.received, out: c.paid, net: c.netChange })], charts: [chart("column", "Cash in and out by source", "money", rows.map((r) => r.source), [{ name: "In", values: rows.map((r) => r.in) }, { name: "Out", values: rows.map((r) => r.out) }])], notes: [c.consistent ? "Opening + in − out equals closing: the statement reconciles." : "The statement does NOT reconcile; run the accounting reconciliation.", c.note] };
}

async function finTrialBalance(p) {
  await needBooks();
  const t = await trialBalance({ from: p.from, to: p.to });
  return { title: "Trial balance", tables: [table("All accounts with activity", [col("code", "Account"), col("name", "Name"), col("type", "Type"), col("openingNet", "Opening (Dr−Cr)", "money"), col("debit", "Debit", "money"), col("credit", "Credit", "money"), col("closingNet", "Closing (Dr−Cr)", "money")], t.rows, { code: "", name: "Total", type: "", openingNet: t.totals.openingNet, debit: t.totals.debit, credit: t.totals.credit, closingNet: t.totals.closingNet })], charts: [], notes: [t.balanced ? "Debits equal credits: the trial balance is in balance." : "The trial balance is NOT in balance."] };
}

async function finLedger(p) {
  await needBooks();
  const code = p.filters?.accountCode;
  if (!code) throw new AppError("invalid-argument", "Choose an account for the general ledger.", { fields: { accountCode: "Required" } });
  /** @type {any[]} */
  const rows = [];
  let after = null;
  for (let i = 0; i < 20; i += 1) {
    const g = await generalLedger({ accountCode: code, from: p.from, to: p.to, after }, { pageSize: 250 });
    rows.push(...g.rows);
    if (!g.next) return { title: `General ledger — ${g.account?.name ?? code}`, tables: [table("Ledger lines", [col("date", "Date"), col("journal", "Journal"), col("description", "Description"), col("debit", "Debit", "money"), col("credit", "Credit", "money"), col("running", "Balance", "money")], rows.map((r) => ({ date: r.dateKey, journal: r.number ?? "", description: r.memo ?? "", debit: r.debit, credit: r.credit, running: r.running })))], charts: [], notes: [g.opening !== null ? `Opening balance ${(g.opening / 100).toFixed(2)}; closing balance ${(g.closing / 100).toFixed(2)}.` : ""].filter(Boolean) };
    after = g.next;
  }
  throw new AppError("failed-precondition", "That account has too many lines in this range. Choose a shorter range.");
}

/** Open items ageing for sales owed to us. The control account is shown beside it so a difference is visible, not hidden. */
async function finArAging(p) {
  const config = await needBooks();
  const snap = await db.collection("sales").where("amountDue", ">", 0).limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", "There are too many unpaid sales to age in one report.");
  const open = /** @type {Record<string, any>[]} */ (snap.docs.map((d) => ({ id: d.id, ...d.data() }))).filter((s) => s.status !== "cancelled" && dayOf(s.createdAt) <= p.to);
  const buckets = Object.fromEntries(A.AGING_BUCKETS.map(([k]) => [k, 0]));
  const rows = open.map((s) => {
    const age = A.ageInDays(dayOf(s.createdAt), p.to);
    const b = A.agingBucket(age);
    buckets[b] += s.amountDue;
    return { number: s.number, customer: s.customer?.name ?? "Walk-in", date: dayOf(s.createdAt), age, due: s.amountDue, bucket: A.AGING_BUCKETS.find(([k]) => k === b)?.[1] };
  }).sort((a, b) => b.age - a.age);
  const books = (await positionAsOf(config, p.to)).receivables;
  const total = sum(rows, "due");
  return { title: `Accounts receivable ageing as of ${p.to}`, tables: [table("By age", [col("bucket", "Age"), col("amount", "Amount owed", "money")], A.AGING_BUCKETS.map(([k, label]) => ({ bucket: label, amount: buckets[k] })), { bucket: "Total", amount: total }), table("Unpaid sales", [col("number", "Sale"), col("customer", "Customer"), col("date", "Sale date"), col("age", "Days old", "number"), col("due", "Still owed", "money"), col("bucket", "Age band")], rows), table("Reconciliation", [col("item", "Line"), col("amount", "Amount", "money")], [{ item: "Unpaid sales (sale records)", amount: total }, { item: "Receivable accounts in the books", amount: books }, { item: "Difference", amount: books - total }])], charts: [chart("column", "Receivables by age", "money", A.AGING_BUCKETS.map(([, l]) => l), [{ name: "Owed", values: A.AGING_BUCKETS.map(([k]) => buckets[k]) }])], notes: ["Age = days since the sale. A difference to the books can come from cash-on-delivery balances or sales made before accounting was set up; it is shown, not hidden."] };
}

async function finApAging(p) {
  const config = await needBooks();
  const snap = await db.collection("purchaseOrders").where("paymentStatus", "in", ["unpaid", "partial"]).limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", "There are too many unpaid purchase orders to age in one report.");
  const buckets = Object.fromEntries(A.AGING_BUCKETS.map(([k]) => [k, 0]));
  const rows = /** @type {Record<string, any>[]} */ (snap.docs.map((d) => ({ id: d.id, ...d.data() }))).map((o) => ({ o, owed: (o.receivedValue ?? 0) - (o.returnedValue ?? 0) - (o.paidTotal ?? 0) })).filter((x) => x.owed > 0 && dayOf(x.o.createdAt) <= p.to).map(({ o, owed }) => {
    const date = dayOf(o.lastReceivedAt ?? o.createdAt);
    const age = A.ageInDays(date, p.to);
    const b = A.agingBucket(age);
    buckets[b] += owed;
    return { number: o.number, supplier: o.supplierName ?? "", date, age, owed, bucket: A.AGING_BUCKETS.find(([k]) => k === b)?.[1] };
  }).sort((a, b) => b.age - a.age);
  const total = sum(rows, "owed");
  const books = (await positionAsOf(config, p.to)).payables;
  return { title: `Accounts payable ageing as of ${p.to}`, tables: [table("By age", [col("bucket", "Age"), col("amount", "You owe", "money")], A.AGING_BUCKETS.map(([k, label]) => ({ bucket: label, amount: buckets[k] })), { bucket: "Total", amount: total }), table("Unpaid purchase orders", [col("number", "Order"), col("supplier", "Supplier"), col("date", "Goods received"), col("age", "Days old", "number"), col("owed", "You owe", "money"), col("bucket", "Age band")], rows), table("Reconciliation", [col("item", "Line"), col("amount", "Amount", "money")], [{ item: "Unpaid purchase orders (records)", amount: total }, { item: "Accounts payable in the books", amount: books }, { item: "Difference", amount: books - total }])], charts: [chart("column", "Payables by age", "money", A.AGING_BUCKETS.map(([, l]) => l), [{ name: "Owed", values: A.AGING_BUCKETS.map(([k]) => buckets[k]) }])], notes: ["Age = days since the goods were received. Supplier opening balances are not ageable and appear only as a difference to the books."] };
}

async function finEntries(p, kind) {
  await needBooks();
  const r = await financeReport({ report: kind === "expense" ? "expensecat" : "incomecat", from: p.from, to: p.to });
  const t = r.tables[0];
  return { title: kind === "expense" ? "Expense breakdown" : "Income breakdown", tables: r.tables, charts: [chart("pie", t.title, "money", t.rows.map((x) => x.category), [{ name: "Amount", values: t.rows.map((x) => x.amount) }])], notes: r.notes ?? [] };
}

async function finMonthly(p) {
  await needBooks();
  const r = await financeReport({ report: "monthly", from: p.from, to: p.to });
  const t = r.tables[0];
  const rows = t.rows.map((x, i) => ({ ...x, netChange: i ? A.growth(x.net, t.rows[i - 1].net) : null }));
  return { title: "Monthly financial comparison", tables: [table(t.title, [...t.columns, col("netChange", "Net profit vs previous month %", "number")], rows, t.totals)], charts: [chart("line", "Net profit by month", "money", rows.map((x) => x.month), [{ name: "Net profit", values: rows.map((x) => x.net) }]), chart("column", "Income vs expenses", "money", rows.map((x) => x.month), [{ name: "Income", values: rows.map((x) => x.income) }, { name: "Cost + expenses", values: rows.map((x) => x.cost + x.expenses) }])], notes: r.notes };
}

/* ───────── Product intelligence, customers, inventory, purchases ───────── */

/** Per-variant stock with what sold in the window, for the stock-movement estimates. */
async function stockWithDemand(p, ctx) {
  const [inv, d] = await Promise.all([inventoryItems(), loadFacts(p, p.filters, ctx)]);
  const days = daysBetween(p.from, p.to).length;
  /** @type {Map<string, number>} */
  const sold = new Map();
  for (const f of d.facts) if (f.counted) sold.set(`${f.productId}__${f.variantId}`, (sold.get(`${f.productId}__${f.variantId}`) ?? 0) + f.qty);
  const rows = inv.items.filter((r) => r.isActive).map((r) => ({ ...r, sold: sold.get(r.id) ?? 0 }));
  return { rows, days, facts: d.facts, sales: d.sales, warehouses: new Map(inv.warehouses.map((w) => [w.id, w])) };
}

async function productPerformance(p, ctx) {
  const { rows, days, facts } = await stockWithDemand(p, ctx);
  const byProduct = new Map();
  for (const r of rows) {
    const x = byProduct.get(r.productId) ?? { name: r.productName, onHand: 0, sold: 0, value: 0 };
    x.onHand += r.onHand;
    x.sold += r.sold;
    x.value += r.value;
    byProduct.set(r.productId, x);
  }
  const list = [...byProduct.values()].map((x) => ({ ...x, movement: A.classifyMovement({ sold: x.sold, onHand: x.onHand, days }), cover: A.daysOfCover({ onHand: x.onHand, sold: x.sold, days }) }));
  const label = { fast: "Fast moving", slow: "Slow moving", dead: "Dead stock", normal: "Normal", none: "No stock, no sales" };
  const mCols = [col("name", "Product"), col("sold", "Pairs sold", "number"), col("onHand", "On hand", "number"), col("cover", "Days of stock left (est.)", "number"), col("movementLabel", "Status (est.)"), col("value", "Stock value", "money")];
  const mk = (rows2) => rows2.map((x) => ({ ...x, movementLabel: label[x.movement] }));
  const best = [...list].sort((a, b) => b.sold - a.sold).filter((x) => x.sold > 0).slice(0, 10);
  const worst = [...list].filter((x) => x.onHand > 0).sort((a, b) => a.sold - b.sold).slice(0, 10);
  const groups = groupFacts(facts, (f) => f.productName);
  const margins = ctx.canSeeCost ? groups.filter((g) => g.lines - g.linesWithoutCost > 0 && g.costKnownNet > 0).map((g) => ({ name: g.key, units: g.units, net: g.net, profit: g.profit, margin: A.marginPercent(g.profit, g.costKnownNet) })) : [];
  const returned = groupFacts(facts.filter((f) => ["returned", "refunded"].includes(f.status)).map((f) => ({ ...f, counted: true })), (f) => f.productName).map((g) => ({ name: g.key, returnedUnits: g.units, soldUnits: groups.find((x) => x.key === g.key)?.units ?? 0 })).map((r) => ({ ...r, rate: pct(r.returnedUnits, r.returnedUnits + r.soldUnits) })).sort((a, b) => b.returnedUnits - a.returnedUnits).slice(0, 10);
  const size = groupFacts(facts, (f) => f.size || "—").sort((a, b) => b.units - a.units).slice(0, 10).map((g) => ({ name: g.key, units: g.units }));
  const colour = groupFacts(facts, (f) => f.colour || "—").sort((a, b) => b.units - a.units).slice(0, 10).map((g) => ({ name: g.key, units: g.units }));
  const dead = list.filter((x) => x.movement === "dead");
  const summary = [];
  if (best[0]) summary.push({ finding: `Best seller: ${best[0].name} (${best[0].sold} pairs in ${days} days).`, action: best[0].cover !== null && best[0].cover <= 21 ? `Only about ${best[0].cover} days of stock left at this rate: consider reordering.` : "Stock looks adequate." });
  if (dead.length) summary.push({ finding: `${dead.length} product(s) with stock have not sold in this period; ${dead.reduce((n, x) => n + x.onHand, 0)} pairs worth ${(dead.reduce((n, x) => n + x.value, 0) / 100).toFixed(2)} rupees are tied up.`, action: "Consider a promotion, a bundle, or stop reordering them." });
  if (margins.length) {
    const low = [...margins].sort((a, b) => a.margin - b.margin)[0];
    summary.push({ finding: `Lowest margin: ${low.name} at ${low.margin}%.`, action: "Check its price, discounts and purchase cost." });
  }
  if (returned[0]) summary.push({ finding: `Most returned: ${returned[0].name} (${returned[0].returnedUnits} pairs, ${returned[0].rate}% of pairs handled).`, action: "Check quality and size guidance." });
  return {
    title: "Product performance intelligence",
    tables: [
      table("Actionable summary (rules of thumb on real data)", [col("finding", "What the data shows"), col("action", "Suggested action")], summary),
      table("Best-selling products", mCols, mk(best)),
      table("Slowest-selling products that still have stock", mCols, mk(worst)),
      table("Fast-moving products (estimate)", mCols, mk(list.filter((x) => x.movement === "fast").sort((a, b) => b.sold - a.sold).slice(0, 20))),
      table("Slow-moving products (estimate)", mCols, mk(list.filter((x) => x.movement === "slow").sort((a, b) => b.value - a.value).slice(0, 20))),
      table("Dead stock (estimate: stock on hand, nothing sold in the period)", mCols, mk(dead.sort((a, b) => b.value - a.value).slice(0, 20)), { name: "Total", sold: 0, onHand: sum(dead, "onHand"), cover: null, movementLabel: "", value: sum(dead, "value") }),
      ...(margins.length ? [table("Highest-margin products", [col("name", "Product"), col("units", "Pairs", "number"), col("net", "Net sales", "money"), col("profit", "Gross profit", "money"), col("margin", "Margin %", "number")], [...margins].sort((a, b) => b.margin - a.margin).slice(0, 10)), table("Lowest-margin products", [col("name", "Product"), col("units", "Pairs", "number"), col("net", "Net sales", "money"), col("profit", "Gross profit", "money"), col("margin", "Margin %", "number")], [...margins].sort((a, b) => a.margin - b.margin).slice(0, 10))] : []),
      table("Most popular sizes", [col("name", "Size"), col("units", "Pairs", "number")], size),
      table("Most popular colours", [col("name", "Colour"), col("units", "Pairs", "number")], colour),
      table("Products returned most (fully returned or refunded sales)", [col("name", "Product"), col("returnedUnits", "Pairs returned", "number"), col("soldUnits", "Pairs sold", "number"), col("rate", "Return rate %", "number")], returned),
    ],
    charts: [chart("bar", "Best sellers (pairs)", "number", best.map((x) => x.name), [{ name: "Pairs", values: best.map((x) => x.sold) }]), chart("column", "Popular sizes (pairs)", "number", size.map((x) => x.name), [{ name: "Pairs", values: size.map((x) => x.units) }])],
    estimates: ["Fast-moving products (estimate)", "Slow-moving products (estimate)", "Dead stock (estimate: stock on hand, nothing sold in the period)"],
    notes: [`Movement is judged from the ${days} days chosen (fast = under ${A.MOVEMENT_DEFAULTS.fastCoverDays} days of stock left at the recent rate, slow = over ${A.MOVEMENT_DEFAULTS.slowCoverDays}, dead = stock with no sales). These are estimates that assume the recent rate continues. Choose at least 60–90 days for reliable results.`, "Partial refunds can't be attributed to a product, so “returned” counts only whole sales that were returned or refunded."],
  };
}

async function customerAnalytics(p, ctx) {
  const [d, dash] = await Promise.all([loadFacts(p, { ...p.filters, productIds: [], categoryIds: [] }, ctx), crmDashboard()]);
  const per = new Map();
  for (const s of d.sales) {
    if (UNCOUNTED_SALE_STATUSES.includes(s.status) || !s.customerId) continue;
    const x = per.get(s.customerId) ?? { orders: 0, net: 0 };
    x.orders += 1;
    x.net += s.netSales ?? 0;
    per.set(s.customerId, x);
  }
  const customers = per.size;
  const repeat = [...per.values()].filter((x) => x.orders >= 2).length;
  const freq = [1, 2, 3, 4].map((n) => ({ orders: n === 4 ? "4 or more" : String(n), customers: [...per.values()].filter((x) => (n === 4 ? x.orders >= 4 : x.orders === n)).length }));
  const identified = sum([...per.values()], "net");
  const counted = d.sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status));
  const summary = [
    { metric: "Customers who bought (registered)", value: customers },
    { metric: "Repeat purchase rate % (2+ orders in the period)", value: pct(repeat, customers) },
    { metric: "Average spending per customer", value: customers ? Math.round(identified / customers) : 0, money: true },
    { metric: "Average orders per customer", value: customers ? Math.round((sum([...per.values()], "orders") / customers) * 100) / 100 : 0 },
    { metric: "Sales to walk-ins with no customer record", value: counted.filter((s) => !s.customerId).length },
    { metric: "Customers on file / VIP / inactive", value: `${dash.total} / ${dash.vip} / ${dash.inactive}` },
  ];
  const names = ["top", "retention", "lifetime", "segments", "loyalty", "discounts", "inactive"];
  const parts = await Promise.all(names.map((report) => crmReport({ report, from: p.from, to: p.to }).catch(() => null)));
  const growthRows = await customerGrowth();
  return {
    title: "Customer analytics",
    tables: [table("Summary for the period", [col("metric", "Measure"), col("value", "Value", "mixed")], summary), table("Purchase frequency", [col("orders", "Orders in the period"), col("customers", "Customers", "number")], freq), table("New customers by month", [col("month", "Month"), col("joined", "Joined", "number"), col("total", "Total customers", "number")], growthRows), ...parts.flatMap((x) => x?.tables ?? [])],
    charts: [chart("line", "Customer growth", "number", growthRows.map((r) => r.month), [{ name: "Total customers", values: growthRows.map((r) => r.total) }]), chart("column", "Purchase frequency", "number", freq.map((f) => f.orders), [{ name: "Customers", values: freq.map((f) => f.customers) }])],
    notes: ["Customer names and contact-based detail come from the CRM and need the CRM permission. Groups, tiers and loyalty use the owner's own settings.", ...parts.flatMap((x) => x?.notes ?? [])],
  };
}

async function customerGrowth() {
  const snap = await db.collection("crmCustomers").limit(2001).get();
  const by = {};
  for (const x of snap.docs) {
    const t = x.data().createdAt?.toDate?.();
    if (t) by[pktDateKey(t).slice(0, 7)] = (by[pktDateKey(t).slice(0, 7)] ?? 0) + 1;
  }
  let run = 0;
  return Object.keys(by).sort().map((month) => ({ month, joined: by[month], total: (run += by[month]) }));
}

async function lastReceipts() {
  const snap = await db.collection("goodsReceipts").orderBy("createdAt", "desc").limit(MAX_DOCS).get();
  const last = new Map();
  for (const d of snap.docs) for (const l of d.data().lines ?? []) if ((l.acceptedQty ?? 0) > 0 && !last.has(`${l.productId}__${l.variantId}`)) last.set(`${l.productId}__${l.variantId}`, dayOf(d.data().createdAt));
  return last;
}

async function inventoryIntel(p, ctx) {
  const config = await accountingConfig();
  const [{ rows, days, facts, warehouses }, receipts, alerts, adj] = await Promise.all([stockWithDemand(p, ctx), lastReceipts(), inventoryAlerts().catch(() => null), inRange("stockAdjustments", p.from, p.to).catch(() => [])]);
  const today = pktDateKey(new Date());
  const settings = alerts?.settings ?? {};
  const lead = settings.leadDays ?? 14;
  const safety = settings.safetyDays ?? 7;
  const stock = rows.filter((r) => r.onHand > 0);
  const value = sum(rows, "value");
  let open = null;
  let close = null;
  let cogs = null;
  if (config) {
    [open, close] = await Promise.all([positionAsOf(config, addDays(p.from, -1)), positionAsOf(config, p.to)]);
    cogs = (await profitAndLoss({ from: p.from, to: p.to })).costOfSalesTotal;
  }
  const turn = cogs !== null ? A.turnover({ cogs, openingValue: open.inventory, closingValue: close.inventory }) : null;
  const med = (r) => ({ product: r.productName, variant: r.variantLabel, sku: r.sku, onHand: r.onHand, sold: r.sold, cover: A.daysOfCover({ onHand: r.onHand, sold: r.sold, days }), value: r.value, cost: r.cost });
  const reorder = rows.map((r) => ({ ...med(r), suggested: A.reorderQty({ onHand: r.onHand, sold: r.sold, days, leadDays: lead, safetyDays: safety, maxStock: r.maxStock ?? 0 }) })).filter((r) => r.suggested > 0).sort((a, b) => b.suggested - a.suggested).slice(0, 50);
  const over = stock.filter((r) => A.isOverstock({ onHand: r.onHand, sold: r.sold, days, maxStock: r.maxStock ?? 0 })).map(med).sort((a, b) => b.value - a.value).slice(0, 50);
  const slow = stock.filter((r) => A.classifyMovement({ sold: r.sold, onHand: r.onHand, days }) === "slow").map(med).sort((a, b) => b.value - a.value).slice(0, 50);
  const deadRows = stock.filter((r) => r.sold === 0);
  const remaining = stock.filter((r) => r.sold > 0).map(med).sort((a, b) => a.cover - b.cover).slice(0, 30);
  const ageBuckets = Object.fromEntries(A.AGING_BUCKETS.map(([k]) => [k, { units: 0, value: 0 }]).concat([["none", { units: 0, value: 0 }]]));
  for (const r of stock) {
    const rec = receipts.get(r.id);
    const k = rec ? A.agingBucket(A.ageInDays(rec, today)) : "none";
    ageBuckets[k].units += r.onHand;
    ageBuckets[k].value += r.value;
  }
  const whRows = [...warehouses.values()].map((w) => {
    const units = rows.reduce((n, r) => n + (r.byWh[w.id]?.onHand ?? 0), 0);
    const val = rows.reduce((n, r) => n + (r.cost === null ? 0 : (r.byWh[w.id]?.onHand ?? 0) * r.cost), 0);
    const net = facts.filter((f) => f.counted).reduce((n, f) => n + (f.allocations ?? []).filter((a) => a.warehouseId === w.id).reduce((m, a) => m + Math.round(f.net * (f.qty ? a.qty / f.qty : 0)), 0), 0);
    return { name: w.name, units, value: val, net, share: pct(val, value) };
  });
  const byReason = {};
  for (const a of adj.filter((x) => x.status === "applied")) {
    const r = (byReason[a.reason] ??= { reason: a.reason, adjustments: 0, units: 0, net: 0 });
    r.adjustments += 1;
    r.units += Math.abs(a.changeQty ?? 0);
    r.net += a.changeQty ?? 0;
  }
  const ledger = close ? [{ item: "Stock valuation (weighted average cost × pairs on hand)", amount: value }, { item: "Inventory account in the books", amount: close.inventory }, { item: "Difference", amount: close.inventory - value }] : [{ item: "Stock valuation (weighted average cost × pairs on hand)", amount: value }];
  const unc = rows.filter((r) => r.cost === null && r.onHand > 0);
  return {
    title: "Inventory intelligence",
    tables: [
      table("Verified figures", [col("item", "Measure"), col("value", "Value", "mixed")], [{ item: "Pairs on hand", value: sum(rows, "onHand") }, { item: "Stock valuation", value: { money: value } }, ...(turn !== null ? [{ item: `Stock turnover (cost of goods sold ÷ average inventory in the books)`, value: turn }] : [{ item: "Stock turnover", value: "Not available (needs accounting and stock value)" }]), { item: "Pairs without a recorded cost (valued at zero)", value: sum(unc, "onHand") }]),
      table("Stock valuation against the books (verified)", [col("item", "Line"), col("amount", "Amount", "money")], ledger),
      table("Reorder recommendations (estimate)", [col("product", "Product"), col("variant", "Variant"), col("sku", "SKU"), col("onHand", "On hand", "number"), col("sold", "Sold in period", "number"), col("cover", "Days left", "number"), col("suggested", "Suggested order (pairs)", "number")], reorder),
      table("Days of inventory remaining, lowest first (estimate)", [col("product", "Product"), col("variant", "Variant"), col("onHand", "On hand", "number"), col("sold", "Sold in period", "number"), col("cover", "Days left", "number")], remaining),
      table("Overstock (estimate)", [col("product", "Product"), col("variant", "Variant"), col("onHand", "On hand", "number"), col("sold", "Sold", "number"), col("cover", "Days of stock", "number"), col("value", "Value", "money")], over),
      table("Slow-moving inventory (estimate)", [col("product", "Product"), col("variant", "Variant"), col("onHand", "On hand", "number"), col("sold", "Sold", "number"), col("cover", "Days of stock", "number"), col("value", "Value", "money")], slow),
      table("Dead stock valuation (stock on hand, nothing sold in the period)", [col("product", "Product"), col("variant", "Variant"), col("sku", "SKU"), col("onHand", "On hand", "number"), col("value", "Value at cost", "money")], deadRows.map(med).sort((a, b) => b.value - a.value).slice(0, 100), { product: "Total", variant: "", sku: "", onHand: sum(deadRows, "onHand"), value: sum(deadRows, "value") }),
      table("Inventory ageing by time since the last goods receipt (estimate)", [col("band", "Band"), col("units", "Pairs", "number"), col("value", "Value", "money")], [...A.AGING_BUCKETS.map(([k, l]) => ({ band: l, units: ageBuckets[k].units, value: ageBuckets[k].value })), { band: "No receipt on record (opening stock)", units: ageBuckets.none.units, value: ageBuckets.none.value }]),
      table("Warehouse performance", [col("name", "Warehouse"), col("units", "Pairs on hand", "number"), col("value", "Stock value", "money"), col("net", "Net sales in period", "money"), col("share", "Share of stock value %", "number")], whRows),
      table("Stock discrepancy: recorded adjustments in the period", [col("reason", "Reason"), col("adjustments", "Adjustments", "number"), col("units", "Pairs affected", "number"), col("net", "Net pairs change", "number")], Object.values(byReason)),
    ],
    charts: [chart("pie", "Stock value by warehouse", "money", whRows.map((w) => w.name), [{ name: "Value", values: whRows.map((w) => w.value) }]), chart("column", "Stock age by value", "money", [...A.AGING_BUCKETS.map(([, l]) => l), "No receipt on record"], [{ name: "Value", values: [...A.AGING_BUCKETS.map(([k]) => ageBuckets[k].value), ageBuckets.none.value] }])],
    estimates: ["Reorder recommendations (estimate)", "Days of inventory remaining, lowest first (estimate)", "Overstock (estimate)", "Slow-moving inventory (estimate)", "Inventory ageing by time since the last goods receipt (estimate)"],
    notes: [`Demand is the ${days} days chosen. Reorder = enough for ${lead} days of lead time plus ${safety} days of safety at the recent selling rate, less what is on hand. Estimates assume the recent rate continues and are not accounting figures.`, "Ageing uses the date of the latest goods receipt per size/colour, not a first-in-first-out layer."],
  };
}

async function purchaseAnalytics(p) {
  const [sup, prod, ret, out, allGrns, allPays] = await Promise.all([purchaseReportTables({ report: "supplier", from: p.from, to: p.to }), purchaseReportTables({ report: "product", from: p.from, to: p.to }), purchaseReportTables({ report: "returns", from: p.from, to: p.to }), purchaseReportTables({ report: "outstanding", from: p.from, to: p.to }), inRange("goodsReceipts", p.from, p.to), inRange("supplierPayments", p.from, p.to)]);
  const only = new Set(p.filters?.supplierIds ?? []);
  const keep = (x) => !only.size || only.has(x.supplierId);
  const grns = allGrns.filter(keep);
  const pays = allPays.filter(keep);
  const months = A.bucketsBetween(p.from, p.to, "month");
  const monthly = months.map((m) => ({ month: m, purchased: grns.filter((g) => dayOf(g.createdAt).startsWith(m)).reduce((n, g) => n + (g.value ?? 0), 0), paid: pays.filter((x) => dayOf(x.createdAt).startsWith(m)).reduce((n, x) => n + (x.amount ?? 0), 0) }));
  const pos = await byIds("purchaseOrders", grns.map((g) => g.purchaseOrderId));
  const delivery = {};
  for (const g of grns) {
    const po = pos.get(g.purchaseOrderId);
    const r = (delivery[g.supplierId] ??= { supplier: g.supplierName, receipts: 0, withDate: 0, onTime: 0, lateDays: 0 });
    r.receipts += 1;
    if (po?.expectedDate) {
      r.withDate += 1;
      const late = A.ageInDays(po.expectedDate, dayOf(g.createdAt)) * (dayOf(g.createdAt) > po.expectedDate ? 1 : 0);
      if (late === 0) r.onTime += 1;
      r.lateDays += late;
    }
  }
  const deliveryRows = Object.values(delivery).map((r) => ({ supplier: r.supplier, receipts: r.receipts, measured: r.withDate, onTime: r.onTime, onTimeRate: pct(r.onTime, r.withDate), avgLate: r.withDate - r.onTime ? Math.round((r.lateDays / (r.withDate - r.onTime)) * 10) / 10 : 0 })).sort((a, b) => b.receipts - a.receipts);
  const cost = {};
  for (const g of grns) for (const l of g.lines ?? []) {
    if (!(l.acceptedQty > 0)) continue;
    const k = `${l.productId}/${l.variantId}`;
    const u = Math.round(l.value / l.acceptedQty);
    const r = (cost[k] ??= { product: l.productName, variant: l.variantLabel, receipts: 0, min: u, max: u, latest: u, latestAt: "" });
    r.receipts += 1;
    r.min = Math.min(r.min, u);
    r.max = Math.max(r.max, u);
    if (dayOf(g.createdAt) >= r.latestAt) { r.latest = u; r.latestAt = dayOf(g.createdAt); }
  }
  const costRows = Object.values(cost).filter((r) => r.receipts > 0).map((r) => ({ ...r, spread: r.max - r.min, change: A.growth(r.max, r.min) })).sort((a, b) => b.spread - a.spread).slice(0, 50);
  const total = sum(grns, "value");
  return { title: "Purchase and supplier analytics", tables: [table("Summary", [col("item", "Measure"), col("amount", "Amount", "money")], [{ item: "Total purchases (goods received, accepted pairs)", amount: total }, { item: "Paid to suppliers", amount: sum(pays, "amount") }]), ...(only.size ? [] : sup.tables), table("Purchases and payments by month", [col("month", "Month"), col("purchased", "Purchased", "money"), col("paid", "Paid", "money")], monthly), table("Supplier delivery performance (against the order's expected date)", [col("supplier", "Supplier"), col("receipts", "Deliveries", "number"), col("measured", "With an expected date", "number"), col("onTime", "On time", "number"), col("onTimeRate", "On time %", "number"), col("avgLate", "Average days late (late ones)", "number")], deliveryRows), table("Purchase cost comparison (unit cost between receipts)", [col("product", "Product"), col("variant", "Variant"), col("receipts", "Receipts", "number"), col("min", "Lowest unit cost", "money"), col("max", "Highest unit cost", "money"), col("latest", "Latest unit cost", "money"), col("spread", "Spread", "money")], costRows), ...(only.size ? [] : [...prod.tables, ...ret.tables, ...out.tables])], charts: [chart("column", "Purchases and payments by month", "money", monthly.map((m) => m.month), [{ name: "Purchased", values: monthly.map((m) => m.purchased) }, { name: "Paid", values: monthly.map((m) => m.paid) }]), chart("bar", "Purchases by supplier", "money", sup.tables[0].rows.filter((r) => !only.size || grns.some((g) => g.supplierName === r.supplier)).slice(0, 10).map((r) => r.supplier), [{ name: "Purchased", values: sup.tables[0].rows.filter((r) => !only.size || grns.some((g) => g.supplierName === r.supplier)).slice(0, 10).map((r) => r.purchased) }])], notes: ["Purchases count when goods are received, at the accepted pairs' value. Delivery performance only covers orders that had an expected date.", ...(only.size ? ["A supplier filter is on: only that supplier's monthly, delivery and cost tables are shown."] : sup.notes ?? [])] };
}

/* ───────── Dispatcher ───────── */

const BUILDERS = {
  sales_trend: salesTrend, sales_year: salesYear, sales_product: salesGroup, sales_category: salesGroup, sales_size: salesGroup, sales_colour: salesGroup, sales_variant: salesGroup, sales_payment: salesPayment, sales_warehouse: salesWarehouse, sales_person: salesPerson,
  profit_product: profitGroup, profit_category: profitGroup, profit_monthly: profitMonthly, profit_impact: profitImpact, profit_expenses: profitExpenses,
  product_performance: productPerformance, customer_analytics: customerAnalytics, inventory_intel: inventoryIntel, purchase_analytics: purchaseAnalytics,
  fin_pnl: finPnl, fin_balance_sheet: finBalanceSheet, fin_cash_flow: finCashFlow, fin_trial_balance: finTrialBalance, fin_ledger: finLedger, fin_ar_aging: finArAging, fin_ap_aging: finApAging,
  fin_expenses: (p) => finEntries(p, "expense"), fin_income: (p) => finEntries(p, "income"), fin_monthly: finMonthly,
};
const DEPENDS = {
  sales: ["sales"], profit: ["sales", "journals"], product: ["sales", "stock"], customer: ["sales", "customers", "loyalty"], inventory: ["stock", "sales", "purchases", "adjustments", "journals"], purchase: ["purchases", "payments", "orders"], fin: ["journals", "expenses", "sales", "orders"],
};

/**
 * Run one report. The caller has already checked authentication; this checks the report-specific permissions and validates the filters.
 * @param {Record<string, any>} input validated analyticsReportInput @param {string[]} perms the caller's permissions
 */
export async function analyticsReport(input, perms) {
  if (!A.canRunReport(input.report, perms)) throw new AppError("permission-denied", "You don't have permission to run this report.");
  const ctx = { canSeeCost: perms.includes("costs.read") && perms.includes("analytics.financial") };
  const group = input.report.split("_")[0];
  const key = JSON.stringify([input.report, input.from, input.to, input.compareFrom, input.compareTo, input.granularity, input.filters, input.limit, ctx.canSeeCost]);
  const result = await cached(`r_${input.report}_${hash(key)}`, DEPENDS[group] ?? ["sales"], async () => {
    const out = await BUILDERS[input.report]({ ...input, filters: input.filters ?? {} }, ctx);
    return { charts: [], notes: [], estimates: [], ...out, report: input.report, from: input.from, to: input.to, generatedAt: new Date().toISOString() };
  });
  return result;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ───────── Executive dashboard ───────── */

/** @param {{ from: string, to: string, compareFrom?: string, compareTo?: string }} input */
export async function analyticsExecutive(input) {
  const prev = input.compareFrom ? { from: input.compareFrom, to: input.compareTo } : A.previousPeriod(input.from, input.to);
  return cached(`exec_${hash(JSON.stringify([input.from, input.to, prev]))}`, ["sales", "journals", "stock", "customers", "purchases", "payments", "expenses"], async () => {
    const ctx = { canSeeCost: true };
    const none = { productIds: [], categoryIds: [], customerIds: [], paymentMethods: [], channel: "" };
    const win = { from: addDays(input.to, -89), to: input.to };
    const [cur, prv, win90, config, dash] = await Promise.all([loadFacts(input, none, ctx), loadFacts(prev, none, ctx), loadFacts(win, none, ctx), accountingConfig(), crmDashboard().catch(() => null)]);
    const t = saleTotals(cur.sales);
    const tp = saleTotals(prv.sales);
    const buyers = (sales) => new Set(sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status) && s.customerId).map((s) => s.customerId));
    const bc = buyers(cur.sales);
    const bp = buyers(prv.sales);
    const retained = [...bp].filter((id) => bc.has(id)).length;
    const identified = sum(cur.sales.filter((s) => !UNCOUNTED_SALE_STATUSES.includes(s.status) && s.customerId), "netSales");
    const sales = { totalSales: t.total, netSales: t.net, orders: t.orders, units: t.units, averageOrder: t.orders ? Math.round(t.total / t.orders) : 0, discounts: t.itemDiscounts + t.discounts, returns: t.returns, growth: A.growth(t.net, tp.net), ordersGrowth: A.growth(t.orders, tp.orders), previous: { netSales: tp.net, totalSales: tp.total, orders: tp.orders } };
    /** @type {Record<string, any> | null} */
    let financial = null;
    let reconciliation = null;
    let financialNote = "";
    let monthly = [];
    if (config) {
      const [pl, plPrev, pos, openPos, m] = await Promise.all([profitAndLoss(input), profitAndLoss(prev), positionAsOf(config, input.to), positionAsOf(config, addDays(input.from, -1)), financeReport({ report: "monthly", from: input.from, to: input.to }).catch(() => null)]);
      monthly = m?.tables[0].rows ?? [];
      financial = { revenue: pl.netRevenue, cogs: pl.costOfSalesTotal, grossProfit: pl.grossProfit, operatingExpenses: pl.operatingExpensesTotal, netProfit: pl.netProfit, revenueGrowth: A.growth(pl.netRevenue, plPrev.netRevenue), profitGrowth: plPrev.netProfit > 0 ? A.growth(pl.netProfit, plPrev.netProfit) : null, grossMargin: A.marginPercent(pl.grossProfit, pl.netRevenue), netMargin: A.marginPercent(pl.netProfit, pl.netRevenue), cash: pos.cash, bank: pos.bank, wallet: pos.wallet, receivables: pos.receivables, payables: pos.payables, inventoryBooks: pos.inventory, openingInventoryBooks: openPos.inventory, incomplete: pl.incomplete };
      reconciliation = [{ item: "Net sales per the saved sales (before delivery and tax)", amount: t.net }, { item: "Delivery charges per the saved sales", amount: t.delivery }, { item: "Net revenue per the posted journals", amount: pl.netRevenue }, { item: "Difference (journals − sales records)", amount: pl.netRevenue - t.net - t.delivery }];
    } else financialNote = "Accounting hasn't been set up, so profit, cash, receivables and payables are not shown. They come only from posted journals.";
    const inv = await inventoryItems();
    const alerts = await inventoryAlerts().catch(() => null);
    const stockRows = inv.items.filter((r) => r.isActive);
    const sold90 = new Map();
    for (const f of win90.facts) if (f.counted) sold90.set(`${f.productId}__${f.variantId}`, (sold90.get(`${f.productId}__${f.variantId}`) ?? 0) + f.qty);
    const mv = { fast: 0, slow: 0, dead: 0 };
    let deadValue = 0;
    for (const r of stockRows) {
      const c = A.classifyMovement({ sold: sold90.get(r.id) ?? 0, onHand: r.onHand, days: 90 });
      if (c in mv) mv[c] += 1;
      if (c === "dead") deadValue += r.value;
    }
    const value = sum(stockRows, "value");
    const turn = financial ? A.turnover({ cogs: financial.cogs, openingValue: financial.openingInventoryBooks, closingValue: financial.inventoryBooks }) : null;
    const inventory = { units: sum(stockRows, "onHand"), valuation: value, books: financial?.inventoryBooks ?? null, low: alerts?.counts.low ?? null, out: alerts?.counts.out ?? null, fast: mv.fast, slow: mv.slow, dead: mv.dead, deadValue, turnover: turn, unitsWithoutCost: stockRows.filter((r) => r.cost === null).reduce((n, r) => n + r.onHand, 0) };
    const customers = { total: dash?.total ?? null, newCustomers: dash?.newCustomers ?? null, returning: dash?.returning ?? null, vip: dash?.vip ?? null, inactive: dash?.inactive ?? null, buyers: bc.size, retention: pct(retained, bp.size), averageSpending: bc.size ? Math.round(identified / bc.size) : 0, lifetimeValue: dash?.total ? Math.round(dash.totalSales / dash.total) : null, repeatRate: pct([...bc].filter((id) => cur.sales.filter((s) => s.customerId === id && !UNCOUNTED_SALE_STATUSES.includes(s.status)).length >= 2).length, bc.size) };
    const g = input.to < addDays(input.from, 62) ? "day" : "month";
    const ba = bucketAgg(cur.facts, cur.sales, g, false);
    const bb = bucketAgg(prv.facts, prv.sales, g, false);
    const buckets = A.bucketsBetween(input.from, input.to, g);
    const pb = A.bucketsBetween(prev.from, prev.to, g);
    const cat = groupFacts(cur.facts, (f) => f.categoryName).sort((x, y) => y.net - x.net).slice(0, 8);
    const meth = {};
    for (const s of cur.sales) if (!UNCOUNTED_SALE_STATUSES.includes(s.status)) meth[s.paymentMethod ?? "other"] = (meth[s.paymentMethod ?? "other"] ?? 0) + (s.total ?? 0);
    const charts = [
      chart("line", "Net sales", "money", buckets, [{ name: "This period", values: buckets.map((k) => ba.get(k)?.net ?? 0) }, { name: "Previous period", values: buckets.map((k, i) => bb.get(pb[i] ?? "")?.net ?? 0) }]),
      ...(monthly.length ? [chart("column", "Revenue and expenses by month", "money", monthly.map((r) => r.month), [{ name: "Income", values: monthly.map((r) => r.income) }, { name: "Cost + expenses", values: monthly.map((r) => r.cost + r.expenses) }]), chart("line", "Net profit by month", "money", monthly.map((r) => r.month), [{ name: "Net profit", values: monthly.map((r) => r.net) }])] : []),
      chart("pie", "Sales by category", "money", cat.map((c) => c.key), [{ name: "Net sales", values: cat.map((c) => c.net) }]),
      chart("pie", "Sales by payment method", "money", Object.keys(meth), [{ name: "Sales", values: Object.values(meth) }]),
      chart("column", "Stock value by warehouse", "money", [...(await db.collection("warehouses").get()).docs.map((w) => w.data().name)], [{ name: "Value", values: (await db.collection("warehouses").get()).docs.map((w) => stockRows.reduce((n, r) => n + (r.cost === null ? 0 : (r.byWh[w.id]?.onHand ?? 0) * r.cost), 0)) }]),
    ];
    return { from: input.from, to: input.to, previous: prev, sales, financial, financialNote, reconciliation, inventory, customers, charts, generatedAt: new Date().toISOString(), notes: ["Sales, stock and customer figures come from the saved sales, the inventory records and the CRM. Revenue, cost of goods sold, expenses, profit, cash, bank, receivables and payables come only from posted journals.", "Fast, slow and dead stock are estimates from the last 90 days of sales."] };
  });
}

/** Cache for repeated "Recalculate" is by design invalidated by new records, so there is nothing to clear by hand. Kept for tests and tools. */
/** Run a report without the permission check (for scheduled summaries the schedule's creator was already allowed to set up). */
export const runInternal = (report, params, ctx = { canSeeCost: true }) => BUILDERS[report]({ report, granularity: "day", filters: {}, limit: 50, ...params }, ctx);

export const _internals = { bucketAgg, positionAsOf, hash, byIds, MAX_DOCS };
