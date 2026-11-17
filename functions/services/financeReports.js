/**
 * Financial dashboard and reports. Every figure comes from POSTED journals (the accounting engine's day and month
 * totals) or from saved finance entries; nothing is typed in and nothing is estimated. Reports are returned as plain
 * tables ({ title, columns, rows, totals }) so the screen, the CSV export and the print/PDF view all use the same data.
 * Money values are integer paisa.
 */
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { naturalBalance, monthOf, dayBefore, pktDateKey } from "../shared/accounting.js";
import { daysBetween } from "../shared/finance.js";
import { configRef } from "./accounting.js";
import { balancesAsOf, profitAndLoss, overview, cashFlow } from "./accountingReports.js";
import { moneyAccountsOf } from "./finance.js";

const MAX_ENTRIES = 5000;
const col = (key, label, type = "text") => ({ key, label, type });
const table = (title, columns, rows, totals = null) => ({ title, columns, rows, totals });

async function loadConfig() {
  const snap = await configRef().get();
  if (!snap.exists || !snap.data().enabled) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  return snap.data();
}

/** Income / cost of sales / operating expenses from one day's or month's account totals. */
function split(config, accounts) {
  const cogsParent = config.accounts[config.roles.cogs]?.parent;
  const out = { income: 0, cost: 0, expenses: 0 };
  for (const [code, t] of Object.entries(accounts ?? {})) {
    const a = config.accounts[code];
    if (!a || (a.type !== "revenue" && a.type !== "expense")) continue;
    const n = naturalBalance(a, t.debit ?? 0, t.credit ?? 0);
    const signed = a.contra ? -n : n;
    if (a.type === "revenue") out.income += signed;
    else if (a.parent === cogsParent) out.cost += signed;
    else out.expenses += signed;
  }
  return out;
}

/** @returns {Promise<Record<string, any>[]>} */
async function postedEntries(from, to) {
  const snap = await db.collection("financeEntries").where("date", ">=", from).where("date", "<=", to).orderBy("date").limit(MAX_ENTRIES + 1).get();
  if (snap.size > MAX_ENTRIES) throw new AppError("failed-precondition", `That range has more than ${MAX_ENTRIES} entries. Please choose a shorter range.`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

/* ───────── Dashboard ───────── */

/** @param {{ from: string, to: string }} range */
export async function financeDashboard({ from, to }) {
  const config = await loadConfig();
  const today = pktDateKey(new Date());
  const [pl, todayPl, ov] = await Promise.all([profitAndLoss({ from, to }), profitAndLoss({ from: today, to: today }), overview()]);
  const salesCodes = new Set([config.roles.sales_revenue, config.roles.sales_discounts, config.roles.sales_returns, config.roles.delivery_income].filter(Boolean));
  const salesIncome = pl.revenue.filter((r) => salesCodes.has(r.code)).reduce((n, r) => n + r.amount, 0);
  const cashAccounts = ov.cashAccounts;
  const totalExpenses = pl.costOfSalesTotal + pl.operatingExpensesTotal;
  return {
    from,
    to,
    income: { total: pl.netRevenue, sales: salesIncome, other: pl.netRevenue - salesIncome },
    costOfSales: pl.costOfSalesTotal,
    grossProfit: pl.grossProfit,
    operatingExpenses: pl.operatingExpensesTotal,
    totalExpenses,
    netProfit: pl.netProfit,
    today: { date: today, income: todayPl.netRevenue, expenses: todayPl.costOfSalesTotal + todayPl.operatingExpensesTotal },
    cash: { inHand: cashAccounts.filter((a) => a.kind === "cash").reduce((n, a) => n + a.balance, 0), bank: cashAccounts.filter((a) => a.kind === "bank").reduce((n, a) => n + a.balance, 0), wallet: cashAccounts.filter((a) => a.kind === "wallet").reduce((n, a) => n + a.balance, 0), accounts: cashAccounts },
    receivables: ov.receivables,
    payables: ov.payables,
    incomplete: { ...ov.incomplete, note: pl.incomplete?.note ?? "" },
  };
}

/* ───────── Reports ───────── */

/** @param {{ report: string, from: string, to: string, accountCode?: string }} input */
export async function financeReport({ report, from, to, accountCode }) {
  const config = await loadConfig();
  const days = daysBetween(from, to);
  const monthsLimit = 24;
  const dayDocs = async () => {
    if (days.length > 93) throw new AppError("failed-precondition", "Choose at most about three months for this report.");
    return (await db.collection("accountDays").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", to).get()).docs;
  };

  if (report === "daily") {
    const docs = await dayDocs();
    const rows = docs.map((d) => ({ date: d.id, ...split(config, d.data().accounts) })).map((r) => ({ ...r, gross: r.income - r.cost, net: r.income - r.cost - r.expenses })).sort((a, b) => a.date.localeCompare(b.date));
    const totals = { date: "Total", income: sum(rows, "income"), cost: sum(rows, "cost"), gross: sum(rows, "gross"), expenses: sum(rows, "expenses"), net: sum(rows, "net") };
    return { title: "Daily income & expense report", from, to, tables: [table("By day", [col("date", "Date"), col("income", "Income", "money"), col("cost", "Cost of sales", "money"), col("gross", "Gross profit", "money"), col("expenses", "Expenses", "money"), col("net", "Net profit", "money")], rows, totals)], notes: ["Income is recognised when a sale is recorded, from the posted journals. Transfers between your own accounts are not income or expenses."] };
  }

  if (report === "monthly") {
    const firstMonth = monthOf(from);
    const lastMonth = monthOf(to);
    const docs = (await db.collection("accountMonths").where(FieldPath.documentId(), ">=", firstMonth).where(FieldPath.documentId(), "<=", lastMonth).get()).docs;
    if (docs.length > monthsLimit) throw new AppError("failed-precondition", "Choose at most two years.");
    const rows = docs.map((d) => ({ month: d.id, ...split(config, d.data().accounts) })).map((r) => ({ ...r, gross: r.income - r.cost, net: r.income - r.cost - r.expenses })).sort((a, b) => a.month.localeCompare(b.month));
    const totals = { month: "Total", income: sum(rows, "income"), cost: sum(rows, "cost"), gross: sum(rows, "gross"), expenses: sum(rows, "expenses"), net: sum(rows, "net") };
    return { title: "Monthly financial report", from: `${firstMonth}-01`, to: `${lastMonth}-31`, tables: [table("By month (whole months)", [col("month", "Month"), col("income", "Income", "money"), col("cost", "Cost of sales", "money"), col("gross", "Gross profit", "money"), col("expenses", "Expenses", "money"), col("net", "Net profit", "money")], rows, totals)], notes: ["Whole calendar months containing the chosen dates."] };
  }

  if (report === "pnl") {
    const pl = await profitAndLoss({ from, to });
    const rows = [
      ...pl.revenue.map((r) => ({ section: "Income", name: `${r.code} ${r.name}`, amount: r.amount })),
      { section: "Income", name: "Net income", amount: pl.netRevenue },
      ...pl.costOfSales.map((r) => ({ section: "Cost of sales", name: `${r.code} ${r.name}`, amount: r.amount })),
      { section: "Gross profit", name: "Gross profit", amount: pl.grossProfit },
      ...pl.operatingExpenses.map((r) => ({ section: "Expenses", name: `${r.code} ${r.name}`, amount: r.amount })),
      { section: "Expenses", name: "Total operating expenses", amount: pl.operatingExpensesTotal },
      { section: "Net profit", name: "Net profit", amount: pl.netProfit },
    ];
    return { title: "Profit & loss statement", from, to, tables: [table("Profit & loss", [col("section", "Section"), col("name", "Account"), col("amount", "Amount", "money")], rows)], notes: pl.incomplete?.note ? [pl.incomplete.note] : [] };
  }

  if (report === "cashflow") {
    const cf = await cashFlow({ from, to });
    const SOURCE = { sale: "Sales", payment: "Customer payments", refund: "Refunds to customers", grn: "Goods received", supplierpayment: "Supplier payments", purchasereturn: "Purchase returns", manual: "Manual journals", opening: "Opening balances", reversal: "Reversals", registermove: "Register cash in/out", registervariance: "Register differences", finance: "Income, expenses, transfers and adjustments" };
    const rows = Object.entries(cf.bySource).map(([k, v]) => ({ source: SOURCE[k] ?? k, in: v.in, out: v.out, net: v.in - v.out }));
    return {
      title: "Cash flow statement",
      from,
      to,
      tables: [
        table("Where money came from and went", [col("source", "Source"), col("in", "Money in", "money"), col("out", "Money out", "money"), col("net", "Net", "money")], rows, { source: "Total", in: cf.received, out: cf.paid, net: cf.netChange }),
        table("Accounts", [col("name", "Account"), col("opening", "Opening", "money"), col("closing", "Closing", "money")], cf.accounts, { name: "Total", opening: cf.openingTotal, closing: cf.closingTotal }),
      ],
      notes: [`Closing = opening + money in − money out. ${cf.consistent ? "This period adds up." : "This period does NOT add up — see Accounting → Reconciliation."}`, cf.note],
    };
  }

  if (report === "cashregister" || report === "bank") {
    const money = moneyAccountsOf(config);
    const codes = report === "cashregister" ? [accountCode && money.get(accountCode)?.kind === "cash" ? accountCode : config.roles.cash] : [...money.values()].filter((a) => a.kind !== "cash").map((a) => a.code);
    const docs = await dayDocs();
    const [openBal, closeBal] = await Promise.all([balancesAsOf(dayBefore(from)), balancesAsOf(to)]);
    const nat = (map, code) => naturalBalance(config.accounts[code], map.get(code)?.debit ?? 0, map.get(code)?.credit ?? 0);
    const tables = [];
    if (report === "cashregister") {
      const code = codes[0];
      let running = nat(openBal, code);
      const rows = docs.sort((a, b) => a.id.localeCompare(b.id)).filter((d) => d.data().accounts?.[code]).map((d) => {
        const t = d.data().accounts[code];
        const opening = running;
        running = opening + (t.debit ?? 0) - (t.credit ?? 0);
        return { date: d.id, opening, in: t.debit ?? 0, out: t.credit ?? 0, closing: running };
      });
      tables.push(table(`${config.accounts[code].name}: day by day`, [col("date", "Date"), col("opening", "Opening cash", "money"), col("in", "Cash in", "money"), col("out", "Cash out", "money"), col("closing", "Closing cash", "money")], rows, { date: "Period", opening: nat(openBal, code), in: sum(rows, "in"), out: sum(rows, "out"), closing: nat(closeBal, code) }));
      const reg = await db.collection("registerSessions").where("openedAt", ">=", Timestamp.fromDate(new Date(`${from}T00:00:00+05:00`))).where("openedAt", "<=", Timestamp.fromDate(new Date(`${to}T23:59:59+05:00`))).orderBy("openedAt").limit(500).get();
      tables.push(table("Shop registers", [col("number", "Register"), col("cashier", "Cashier"), col("status", "Status"), col("sales", "Sales", "money"), col("expected", "Expected cash", "money"), col("counted", "Counted", "money"), col("variance", "Difference", "money")], reg.docs.map((d) => { const s = d.data(); return { number: s.number, cashier: s.cashierName, status: s.status, sales: s.salesTotal ?? 0, expected: s.expectedCash ?? null, counted: s.countedCash ?? null, variance: s.variance ?? null }; })));
      const cc = await db.collection("cashCounts").where("accountCode", "==", code).where("date", ">=", from).where("date", "<=", to).orderBy("date").limit(500).get();
      tables.push(table("Cash counts (reconciliation)", [col("date", "Date"), col("expected", "Expected", "money"), col("counted", "Counted", "money"), col("variance", "Difference", "money"), col("status", "Result"), col("by", "Counted by")], cc.docs.map((d) => { const c = d.data(); return { date: c.date, expected: c.expected, counted: c.counted, variance: c.variance, status: c.status, by: c.countedByName }; })));
    } else {
      const rows = codes.map((code) => {
        let inn = 0;
        let out = 0;
        for (const d of docs) {
          inn += d.data().accounts?.[code]?.debit ?? 0;
          out += d.data().accounts?.[code]?.credit ?? 0;
        }
        return { account: `${code} ${config.accounts[code].name}`, opening: nat(openBal, code), in: inn, out, closing: nat(closeBal, code) };
      });
      tables.push(table("Bank and wallet accounts", [col("account", "Account"), col("opening", "Opening", "money"), col("in", "Money in", "money"), col("out", "Money out", "money"), col("closing", "Closing", "money")], rows, { account: "Total", opening: sum(rows, "opening"), in: sum(rows, "in"), out: sum(rows, "out"), closing: sum(rows, "closing") }));
      const ents = (await postedEntries(from, to)).filter((e) => e.status === "posted" && (codes.includes(e.accountCode) || codes.includes(e.toAccountCode)));
      tables.push(table("Transactions on these accounts", [col("date", "Date"), col("number", "Ref"), col("type", "Type"), col("title", "Description"), col("account", "Account"), col("reference", "Payment reference"), col("amount", "Amount", "money")], ents.map((e) => ({ date: e.date, number: e.number, type: e.type, title: e.title, account: e.toAccountName ? `${e.accountName} → ${e.toAccountName}` : e.accountName, reference: e.reference, amount: e.amount }))));
    }
    return { title: report === "bank" ? "Bank account report" : "Cash register report", from, to, tables, notes: ["Balances are from posted journals. Wallet money is held in a clearing account until you transfer it to the bank."] };
  }

  const ents = await postedEntries(from, to);
  if (report === "expensecat" || report === "incomecat") {
    const kind = report === "expensecat" ? "expense" : "income";
    const live = ents.filter((e) => e.status === "posted" && e.type === kind);
    /** @type {Record<string, { category: string, entries: number, amount: number }>} */
    const by = {};
    for (const e of live) (by[e.categoryId] ??= { category: e.categoryName, entries: 0, amount: 0 }, by[e.categoryId].entries += 1, by[e.categoryId].amount += e.amount);
    const rows = Object.values(by).sort((a, b) => b.amount - a.amount);
    const extra = [];
    if (kind === "income") {
      const pl = await profitAndLoss({ from, to });
      const salesCodes = new Set([config.roles.sales_revenue, config.roles.sales_discounts, config.roles.sales_returns, config.roles.delivery_income].filter(Boolean));
      extra.push({ category: "Sales (from sales journals, net)", entries: null, amount: pl.revenue.filter((r) => salesCodes.has(r.code)).reduce((n, r) => n + r.amount, 0) });
    }
    const all = [...extra, ...rows];
    return { title: kind === "expense" ? "Expense category report" : "Income category report", from, to, tables: [table(kind === "expense" ? "Expenses by category" : "Income by category", [col("category", "Category"), col("entries", "Entries", "number"), col("amount", "Amount", "money")], all, { category: "Total", entries: sum(rows, "entries"), amount: sum(all, "amount") })], notes: kind === "expense" ? ["Entered expenses only. Shop expenses taken from a register and supplier payments are in their own reports."] : [] };
  }

  // ledger
  const rows = ents.filter((e) => e.status !== "void").sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number)).map((e) => ({ date: e.date, number: e.number, type: e.type, status: e.status, title: e.title, category: e.categoryName ?? "", account: e.toAccountName ? `${e.accountName} → ${e.toAccountName}` : e.accountName, method: e.method ?? "", reference: e.reference ?? "", amount: e.amount }));
  return { title: "Transaction ledger", from, to, tables: [table("Entries", [col("date", "Date"), col("number", "Ref"), col("type", "Type"), col("status", "Status"), col("title", "Description"), col("category", "Category"), col("account", "Account"), col("method", "Method"), col("reference", "Reference"), col("amount", "Amount", "money")], rows)], notes: ["Voided entries are left out (they stay on record in Income / Expenses)."] };
}
