/**
 * Accounting reports and the reconciliation checks. Everything is derived from POSTED journals:
 *
 *   balances at a date   the month totals before that date's month (accountMonths, one read per month) plus the day
 *                        totals inside it (accountDays, at most 31 reads) — never a scan of journal lines.
 *   general ledger       one account's ledger rows in a date range, a page at a time, with the running balance.
 *   cash flow            the ledger rows of the cash, bank and wallet accounts in the range (bounded).
 *
 * Nothing here writes. Figures that can't be complete are labelled as such (for example sales whose cost was not
 * recorded, which post revenue but no cost of goods sold) and the reconciliation reports what is missing or
 * inconsistent instead of repairing it.
 */
import { FieldPath } from "firebase-admin/firestore";
import { db } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { naturalBalance, monthOf, dayBefore, pktDateKey } from "../shared/accounting.js";
import { configRef } from "./accounting.js";

const PAGE = 100;
const MAX_LINES = 5000;

async function loadConfig() {
  const snap = await configRef().get();
  if (!snap.exists) throw new AppError("failed-precondition", "Accounting hasn't been set up yet. Create the chart of accounts first.");
  return snap.data();
}

/** Add one month/day document's account totals into a map. */
function addTotals(map, doc, sign = 1) {
  for (const [code, t] of Object.entries(doc.data().accounts ?? {})) {
    const m = map.get(code) ?? { debit: 0, credit: 0 };
    m.debit += sign * (t.debit ?? 0);
    m.credit += sign * (t.credit ?? 0);
    map.set(code, m);
  }
}

/**
 * Cumulative debit and credit per account up to and including a date.
 * @param {string} dateKey @returns {Promise<Map<string, { debit: number, credit: number }>>}
 */
export async function balancesAsOf(dateKey) {
  const month = monthOf(dateKey);
  const [months, days] = await Promise.all([
    db.collection("accountMonths").where(FieldPath.documentId(), "<", month).get(),
    db.collection("accountDays").where(FieldPath.documentId(), ">=", `${month}-01`).where(FieldPath.documentId(), "<=", dateKey).get(),
  ]);
  const map = new Map();
  months.docs.forEach((d) => addTotals(map, d));
  days.docs.forEach((d) => addTotals(map, d));
  return map;
}

const get = (map, code) => map.get(code) ?? { debit: 0, credit: 0 };

/* ───────── Trial balance ───────── */

/**
 * Opening, debit, credit and closing for every account over a period. Opening = everything before `from`.
 * @param {{ from: string, to: string }} range
 */
export async function trialBalance({ from, to }) {
  const [config, open, close] = await Promise.all([loadConfig(), balancesAsOf(dayBefore(from)), balancesAsOf(to)]);
  const rows = Object.entries(config.accounts)
    .filter(([, a]) => !a.isGroup)
    .map(([code, a]) => {
      const o = get(open, code);
      const c = get(close, code);
      const debit = c.debit - o.debit;
      const credit = c.credit - o.credit;
      return { code, name: a.name, type: a.type, contra: a.contra, active: a.active, openingNet: o.debit - o.credit, debit, credit, closingNet: c.debit - c.credit };
    })
    .filter((r) => r.openingNet || r.debit || r.credit || r.closingNet)
    .sort((a, b) => a.code.localeCompare(b.code));
  const sum = (f) => rows.reduce((n, r) => n + r[f], 0);
  const totals = { openingNet: sum("openingNet"), debit: sum("debit"), credit: sum("credit"), closingNet: sum("closingNet"), closingDebit: rows.reduce((n, r) => n + Math.max(0, r.closingNet), 0), closingCredit: rows.reduce((n, r) => n + Math.max(0, -r.closingNet), 0) };
  return { from, to, rows, totals, balanced: totals.closingNet === 0 && totals.debit === totals.credit };
}

/* ───────── Profit & loss, balance sheet ───────── */

/** Sales whose cost was not recorded: they post revenue but no cost of goods sold, so profit is overstated for them. */
async function salesWithoutCost(from, to) {
  const q = db.collection("journalEntries").where("sourceType", "==", "sale").where("costMissing", "==", true);
  const snap = await (from ? q.where("dateKey", ">=", from).where("dateKey", "<=", to) : q).count().get();
  return snap.data().count;
}

/** @param {{ from: string, to: string }} range */
export async function profitAndLoss({ from, to }) {
  const [config, open, close, missing] = await Promise.all([loadConfig(), balancesAsOf(dayBefore(from)), balancesAsOf(to), salesWithoutCost(from, to)]);
  const cogsParent = config.accounts[config.roles.cogs]?.parent;
  const line = ([code, a]) => {
    const o = get(open, code);
    const c = get(close, code);
    return { code, name: a.name, contra: a.contra, amount: naturalBalance(a, c.debit - o.debit, c.credit - o.credit) };
  };
  const live = (rows) => rows.filter((r) => r.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const postable = Object.entries(config.accounts).filter(([, a]) => !a.isGroup);
  const revenue = live(postable.filter(([, a]) => a.type === "revenue").map(line));
  const expenses = postable.filter(([, a]) => a.type === "expense").map(line);
  const costOfSales = live(expenses.filter((r) => config.accounts[r.code].parent === cogsParent));
  const operating = live(expenses.filter((r) => config.accounts[r.code].parent !== cogsParent));
  // A contra account (discounts, returns) already reduces revenue: its natural amount is negative for revenue purposes.
  const signed = (r) => (r.contra ? -r.amount : r.amount);
  const netRevenue = revenue.reduce((n, r) => n + signed(r), 0);
  const cost = costOfSales.reduce((n, r) => n + signed(r), 0);
  const operatingExpenses = operating.reduce((n, r) => n + signed(r), 0);
  return {
    from,
    to,
    revenue: revenue.map((r) => ({ ...r, amount: signed(r) })),
    netRevenue,
    costOfSales: costOfSales.map((r) => ({ ...r, amount: signed(r) })),
    costOfSalesTotal: cost,
    grossProfit: netRevenue - cost,
    operatingExpenses: operating.map((r) => ({ ...r, amount: signed(r) })),
    operatingExpensesTotal: operatingExpenses,
    netProfit: netRevenue - cost - operatingExpenses,
    incomplete: { salesWithoutCost: missing, note: missing ? `${missing} sale${missing === 1 ? "" : "s"} in this period have no recorded cost, so no cost of goods sold was posted for them and gross profit is overstated by their cost.` : "" },
  };
}

/** @param {{ asOf: string }} input */
export async function balanceSheet({ asOf }) {
  const [config, bal] = await Promise.all([loadConfig(), balancesAsOf(asOf)]);
  const rows = Object.entries(config.accounts)
    .filter(([, a]) => !a.isGroup)
    .map(([code, a]) => ({ code, name: a.name, type: a.type, contra: a.contra, amount: naturalBalance(a, get(bal, code).debit, get(bal, code).credit) }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const side = (type) => rows.filter((r) => r.type === type);
  // Contra accounts reduce their section.
  const total = (list) => list.reduce((n, r) => n + (r.contra ? -r.amount : r.amount), 0);
  const revenue = total(side("revenue"));
  const expense = total(side("expense"));
  const currentEarnings = revenue - expense;
  const assets = total(side("asset"));
  const liabilities = total(side("liability"));
  const equity = total(side("equity"));
  return {
    asOf,
    assets: side("asset"),
    liabilities: side("liability"),
    equity: side("equity"),
    totals: { assets, liabilities, equity, currentEarnings, liabilitiesAndEquity: liabilities + equity + currentEarnings },
    balanced: assets === liabilities + equity + currentEarnings,
    note: "Current earnings = all revenue less all expenses to this date. No year-end closing has been made, so it is shown as one line.",
  };
}

/* ───────── Overview ───────── */

export async function overview() {
  const config = await loadConfig();
  const today = pktDateKey(new Date());
  const [bal, missing, failed] = await Promise.all([balancesAsOf(today), salesWithoutCost(null, null), db.collection("accountingExceptions").where("status", "==", "failed").count().get()]);
  const natural = (code) => (code && config.accounts[code] ? naturalBalance(config.accounts[code], get(bal, code).debit, get(bal, code).credit) : 0);
  const typed = (type) => Object.entries(config.accounts).filter(([, a]) => !a.isGroup && a.type === type).reduce((n, [code, a]) => n + (a.contra ? -natural(code) : natural(code)), 0);
  const revenue = typed("revenue");
  const cogsParent = config.accounts[config.roles.cogs]?.parent;
  const cogs = Object.entries(config.accounts).filter(([, a]) => !a.isGroup && a.type === "expense" && a.parent === cogsParent).reduce((n, [code, a]) => n + (a.contra ? -natural(code) : natural(code)), 0);
  const expenses = typed("expense");
  const bankParent = config.accounts[config.roles.bank]?.parent;
  const cashAccounts = Object.entries(config.accounts)
    .filter(([code, a]) => !a.isGroup && (code === config.roles.cash || code === config.roles.wallet_clearing || a.parent === bankParent))
    .map(([code, a]) => ({ code, name: a.name, balance: natural(code), kind: code === config.roles.cash ? "cash" : code === config.roles.wallet_clearing ? "wallet" : "bank" }));
  return {
    asOf: today,
    totalRevenue: revenue,
    totalExpenses: expenses,
    grossProfit: revenue - cogs,
    netProfit: revenue - expenses,
    receivables: natural(config.roles.accounts_receivable) + natural(config.roles.cod_receivable),
    payables: natural(config.roles.accounts_payable),
    inventory: natural(config.roles.inventory),
    cashAccounts,
    cashTotal: cashAccounts.reduce((n, a) => n + a.balance, 0),
    incomplete: { salesWithoutCost: missing, failedPostings: failed.data().count },
  };
}

/* ───────── General ledger and cash flow ───────── */

/** @param {{ accountCode: string, from: string, to: string, after?: { id: string, running: number } | null }} input @param {{ pageSize?: number }} [opts] */
export async function generalLedger({ accountCode, from, to, after }, { pageSize = PAGE } = {}) {
  const config = await loadConfig();
  const account = config.accounts[accountCode];
  if (!account) throw new AppError("not-found", "That account doesn't exist.");
  let running;
  let opening = null;
  if (after) running = after.running;
  else {
    const o = get(await balancesAsOf(dayBefore(from)), accountCode);
    opening = naturalBalance(account, o.debit, o.credit);
    running = opening;
  }
  let q = db.collection("ledgerEntries").where("accountCode", "==", accountCode).where("dateKey", ">=", from).where("dateKey", "<=", to).orderBy("dateKey").limit(pageSize + 1);
  if (after) {
    const cursor = await db.collection("ledgerEntries").doc(after.id).get();
    if (!cursor.exists) throw new AppError("not-found", "The page marker is no longer valid. Start again.");
    q = q.startAfter(cursor);
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, pageSize);
  const rows = docs.map((d) => {
    const e = d.data();
    running += naturalBalance(account, e.debit, e.credit);
    return { id: d.id, dateKey: e.dateKey, number: e.number, journalId: e.journalId, memo: e.memo, sourceType: e.sourceType, debit: e.debit, credit: e.credit, partyType: e.partyType, partyId: e.partyId, running };
  });
  const hasMore = snap.size > pageSize;
  let closing = null;
  if (!hasMore) {
    const c = get(await balancesAsOf(to), accountCode);
    closing = naturalBalance(account, c.debit, c.credit);
  }
  return { account: { code: accountCode, name: account.name, type: account.type, contra: account.contra }, from, to, opening, rows, next: hasMore ? { id: docs[docs.length - 1].id, running } : null, closing };
}

/** @param {{ from: string, to: string }} range */
export async function cashFlow({ from, to }) {
  const config = await loadConfig();
  const bankParent = config.accounts[config.roles.bank]?.parent;
  const cash = Object.entries(config.accounts).filter(([code, a]) => !a.isGroup && (code === config.roles.cash || code === config.roles.wallet_clearing || a.parent === bankParent));
  const [open, close] = await Promise.all([balancesAsOf(dayBefore(from)), balancesAsOf(to)]);
  const natural = (map, code) => naturalBalance(config.accounts[code], get(map, code).debit, get(map, code).credit);
  /** @type {Record<string, { in: number, out: number }>} */
  const bySource = {};
  for (const [code] of cash) {
    const snap = await db.collection("ledgerEntries").where("accountCode", "==", code).where("dateKey", ">=", from).where("dateKey", "<=", to).limit(MAX_LINES + 1).get();
    if (snap.size > MAX_LINES) throw new AppError("failed-precondition", `That range has more than ${MAX_LINES} cash movements. Please choose a shorter range.`);
    for (const d of snap.docs) {
      const e = d.data();
      const t = (bySource[e.sourceType] ??= { in: 0, out: 0 });
      t.in += e.debit;
      t.out += e.credit;
    }
  }
  const accounts = cash.map(([code, a]) => ({ code, name: a.name, opening: natural(open, code), closing: natural(close, code) }));
  const openingTotal = accounts.reduce((n, a) => n + a.opening, 0);
  const closingTotal = accounts.reduce((n, a) => n + a.closing, 0);
  const received = Object.values(bySource).reduce((n, t) => n + t.in, 0);
  const paid = Object.values(bySource).reduce((n, t) => n + t.out, 0);
  return { from, to, accounts, openingTotal, closingTotal, received, paid, netChange: received - paid, bySource, consistent: openingTotal + received - paid === closingTotal, note: "Mobile-wallet money is shown as clearing, not as confirmed bank settlement." };
}

/* ───────── Receivables and payables ───────── */

/** @param {{ partyType: "customer" | "supplier", after?: string | null }} input */
export async function partyList({ partyType, after }) {
  let q = db.collection("partyBalances").where("partyType", "==", partyType).orderBy("balance", "desc").limit(50 + 1);
  if (after) {
    const cursor = await db.collection("partyBalances").doc(after).get();
    if (cursor.exists) q = q.startAfter(cursor);
  }
  const [snap, config, bal] = await Promise.all([q.get(), loadConfig(), balancesAsOf(pktDateKey(new Date()))]);
  const docs = snap.docs.slice(0, 50);
  const codes = partyType === "customer" ? [config.roles.accounts_receivable, config.roles.cod_receivable] : [config.roles.accounts_payable];
  const control = codes.reduce((n, c) => n + (c && config.accounts[c] ? naturalBalance(config.accounts[c], get(bal, c).debit, get(bal, c).credit) : 0), 0);
  return {
    partyType,
    control,
    rows: docs.map((d) => /** @type {Record<string, any>} */ ({ id: d.id, ...d.data() })).filter((r) => r.balance !== 0).map(({ updatedAt: _u, ...r }) => r),
    next: snap.size > 50 ? docs[docs.length - 1].id : null,
    note: partyType === "supplier" ? "Supplier opening balances are not posted automatically; post them through Opening Balances to bring this in line with the supplier ledger." : "",
  };
}

/* ───────── Reconciliation ───────── */

const issue = (type, severity, sourceType, sourceId, message) => ({ type, severity, sourceType, sourceId, message });

/**
 * Check one stage, one page at a time. Reports problems; repairs nothing.
 * @param {{ stage: string, cursor?: string | null }} input
 */
export async function reconcileStage({ stage, cursor }) {
  const config = await loadConfig();
  const initialized = config.initializedAt?.toMillis?.() ?? 0;
  const old = (t) => (t?.toMillis?.() ?? 0) < initialized;
  const sources = { sales: "sales", grn: "goodsReceipts", supplierPayments: "supplierPayments", purchaseReturns: "purchaseReturns", customerPayments: "payments", suppliers: "suppliers", journals: "journalEntries" };
  let q = db.collection(sources[stage]).orderBy("__name__").limit(PAGE);
  if (cursor) q = q.startAfter(db.collection(sources[stage]).doc(cursor));
  const page = await q.get();
  /** @type {ReturnType<typeof issue>[]} */
  const issues = [];
  const jget = async (ids) => (ids.length ? new Map((await db.getAll(...ids.map((id) => db.collection("journalEntries").doc(id)))).map((s) => [s.id, s])) : new Map());
  const missing = (type, sourceType, id, atTime, label) => issues.push(issue(type, old(atTime) ? "info" : "error", sourceType, id, old(atTime) ? `${label} was made before accounting was set up and has no journal (use the historical backfill).` : `${label} has no journal.`));

  if (stage === "journals") {
    const refs = page.docs.flatMap((d) => (d.data().status === "posted" ? d.data().lines.map((_, i) => db.collection("ledgerEntries").doc(`${d.id}_${i}`)) : []));
    /** @type {FirebaseFirestore.DocumentSnapshot[]} */
    const lines = [];
    for (let i = 0; i < refs.length; i += 300) lines.push(...(await db.getAll(...refs.slice(i, i + 300))));
    const have = new Set(lines.filter((s) => s.exists).map((s) => s.id));
    for (const d of page.docs) {
      const j = d.data();
      if (j.status !== "posted") continue;
      const dr = j.lines.reduce((n, l) => n + l.debit, 0);
      const cr = j.lines.reduce((n, l) => n + l.credit, 0);
      if (dr !== cr || dr !== j.totalDebit || cr !== j.totalCredit) issues.push(issue("journal_unbalanced", "error", j.sourceType, d.id, `${j.number}: debits ${dr}, credits ${cr}, recorded totals ${j.totalDebit}/${j.totalCredit}`));
      if (j.lines.some((_, i) => !have.has(`${d.id}_${i}`))) issues.push(issue("ledger_missing", "error", j.sourceType, d.id, `${j.number}: a ledger line is missing`));
    }
  } else if (stage === "sales") {
    const ids = page.docs.flatMap((d) => [`sale__${d.id}`, `reversal__sale__${d.id}`]);
    const js = await jget(ids);
    for (const d of page.docs) {
      const s = d.data();
      const j = js.get(`sale__${d.id}`);
      if (!j?.exists) {
        missing("sale_without_journal", "sale", d.id, s.createdAt, `Sale ${s.number}`);
        continue;
      }
      const rec = j.data().lines.filter((l) => config.accounts[l.accountCode]?.control === "receivable").reduce((n, l) => n + l.debit, 0);
      if (rec !== s.total) issues.push(issue("sale_amount_mismatch", "error", "sale", d.id, `Sale ${s.number}: total ${s.total} but the journal shows ${rec} receivable`));
      if (["cancelled", "returned", "refunded"].includes(s.status) && !js.get(`reversal__sale__${d.id}`)?.exists) issues.push(issue("sale_reversal_missing", "error", "sale", d.id, `Sale ${s.number} is ${s.status} but its journal wasn't reversed`));
    }
  } else if (stage === "grn" || stage === "supplierPayments" || stage === "purchaseReturns") {
    const prefix = { grn: "grn", supplierPayments: "supplierpayment", purchaseReturns: "purchasereturn" }[stage];
    const amountOf = (x) => (stage === "supplierPayments" ? x.amount : x.value);
    const js = await jget(page.docs.map((d) => `${prefix}__${d.id}`));
    for (const d of page.docs) {
      const x = d.data();
      if (stage !== "supplierPayments" && !(x.value > 0)) continue;
      const j = js.get(`${prefix}__${d.id}`);
      if (!j?.exists) missing(`${prefix}_without_journal`, prefix, d.id, x.createdAt, `${x.number}`);
      else if (j.data().totalDebit !== amountOf(x)) issues.push(issue(`${prefix}_amount_mismatch`, "error", prefix, d.id, `${x.number}: ${amountOf(x)} but the journal total is ${j.data().totalDebit}`));
    }
  } else if (stage === "customerPayments") {
    for (const d of page.docs) {
      const txs = await d.ref.collection("transactions").get();
      const ids = txs.docs.map((t) => (t.data().type === "reversal" ? `reversal__payment__${t.data().reverses}` : `${t.data().type === "refund" ? "refund" : "payment"}__${t.id}`));
      const js = await jget(ids);
      txs.docs.forEach((t, i) => {
        const x = t.data();
        const j = js.get(ids[i]);
        if (!j?.exists) {
          // A reversal of an entry that itself had no journal has nothing to reverse: not a gap.
          if (x.type === "reversal") return;
          missing("payment_without_journal", x.type, `${d.id}/${t.id}`, x.at, `Payment record ${x.type} of ${x.amount} for order ${d.id}`);
        }
      });
    }
  } else if (stage === "suppliers") {
    const parties = await db.getAll(...(page.docs.length ? page.docs.map((s) => db.collection("partyBalances").doc(`supplier__${s.id}`)) : [db.collection("partyBalances").doc("_none_")]));
    const byId = new Map(parties.map((p) => [p.id, p]));
    for (const s of page.docs) {
      const ledgerBalance = s.data().balance ?? 0;
      const books = byId.get(`supplier__${s.id}`)?.data()?.balance ?? 0;
      if (ledgerBalance !== books) issues.push(issue("supplier_balance_mismatch", "warning", "supplier", s.id, `${s.data().name}: supplier ledger ${ledgerBalance}, accounting ${books} (opening balances and pre-accounting activity are not posted automatically)`));
    }
  }
  return { stage, scanned: page.size, issues, nextCursor: page.size === PAGE ? page.docs[page.size - 1].id : null };
}
