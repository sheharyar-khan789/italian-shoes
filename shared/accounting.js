/**
 * Accounting vocabulary and rules shared by the server and the admin. Money is whole paisa everywhere.
 *
 * Normal balances: assets and expenses grow with debits; liabilities, equity and revenue grow with credits.
 * A "contra" account (sales discounts, sales returns) belongs to a type but carries the opposite balance.
 *
 * Accounts are identified by their code (the document id), so a code can never be used twice. The accounts a
 * business event posts to are found through ROLES (for example "cash" or "sales_revenue"), which the owner can
 * point at a different account of the right type; the templates below are structure only — no figure is invented.
 */

export const ACCOUNT_TYPES = /** @type {const} */ (["asset", "liability", "equity", "revenue", "expense"]);
export const ACCOUNT_TYPE_LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", expense: "Expenses" };

/** @param {string} type @param {boolean} [contra] @returns {"debit" | "credit"} */
export function normalBalanceOf(type, contra = false) {
  const base = type === "asset" || type === "expense" ? "debit" : "credit";
  if (!contra) return base;
  return base === "debit" ? "credit" : "debit";
}

/** Balance in the account's normal direction (positive = normal). @param {{ type: string, contra?: boolean }} account */
export function naturalBalance(account, debit, credit) {
  return normalBalanceOf(account.type, account.contra) === "debit" ? debit - credit : credit - debit;
}

/** A role is a job an account does in the posting rules; its account must be of this type. control: the account carries customer / supplier balances. */
export const ROLES = {
  cash: { label: "Cash in Hand", type: "asset" },
  bank: { label: "Bank account (default)", type: "asset" },
  wallet_clearing: { label: "JazzCash / Easypaisa clearing", type: "asset" },
  cod_receivable: { label: "COD / courier receivable", type: "asset", control: "receivable" },
  accounts_receivable: { label: "Accounts receivable", type: "asset", control: "receivable" },
  inventory: { label: "Inventory", type: "asset" },
  accounts_payable: { label: "Accounts payable", type: "liability", control: "payable" },
  sales_tax: { label: "Sales tax payable", type: "liability" },
  owner_capital: { label: "Owner capital", type: "equity" },
  retained_earnings: { label: "Retained earnings", type: "equity" },
  sales_revenue: { label: "Sales revenue", type: "revenue" },
  sales_discounts: { label: "Sales discounts", type: "revenue", contra: true },
  sales_returns: { label: "Sales returns & allowances", type: "revenue", contra: true },
  delivery_income: { label: "Delivery / shipping income", type: "revenue" },
  other_income: { label: "Other income", type: "revenue" },
  inventory_adjustments: { label: "Inventory adjustments & write-offs", type: "expense" },
  cogs: { label: "Cost of goods sold", type: "expense" },
  operating_expenses: { label: "Operating expenses", type: "expense" },
  salaries: { label: "Salaries", type: "expense" },
  employee_advances: { label: "Employee advances & loans", type: "asset" },
  salary_payable: { label: "Salaries payable", type: "liability" },
  payroll_deductions: { label: "Payroll deductions payable", type: "liability" },
};

/**
 * The chart of accounts the owner can create in one step. Codes, names and structure only — no balances.
 * @type {{ code: string, name: string, type: string, parent: string | null, isGroup?: boolean, contra?: boolean, role?: string, description?: string }[]}
 */
export const DEFAULT_ACCOUNTS = [
  { code: "1000", name: "Current Assets", type: "asset", parent: null, isGroup: true },
  { code: "1010", name: "Cash in Hand", type: "asset", parent: "1000", role: "cash" },
  { code: "1020", name: "Bank Accounts", type: "asset", parent: "1000", isGroup: true, description: "Add one child account per bank account" },
  { code: "1021", name: "Main Bank Account", type: "asset", parent: "1020", role: "bank" },
  { code: "1030", name: "JazzCash / Easypaisa Clearing", type: "asset", parent: "1000", role: "wallet_clearing", description: "Mobile-wallet money not yet confirmed as settled in the bank" },
  { code: "1100", name: "COD / Courier Receivable", type: "asset", parent: "1000", role: "cod_receivable", description: "Cash on delivery owed by customers or couriers until collected" },
  { code: "1110", name: "Accounts Receivable", type: "asset", parent: "1000", role: "accounts_receivable" },
  { code: "1130", name: "Employee Advances & Loans", type: "asset", parent: "1000", role: "employee_advances", description: "Salary advances and loans paid to employees and not yet recovered from their pay" },
  { code: "1200", name: "Inventory", type: "asset", parent: "1000", role: "inventory" },
  { code: "2000", name: "Current Liabilities", type: "liability", parent: null, isGroup: true },
  { code: "2010", name: "Accounts Payable", type: "liability", parent: "2000", role: "accounts_payable" },
  { code: "2020", name: "Sales Tax Payable", type: "liability", parent: "2000", role: "sales_tax" },
  { code: "2030", name: "Salaries Payable", type: "liability", parent: "2000", role: "salary_payable", description: "Net salaries approved in payroll and not yet paid to employees" },
  { code: "2040", name: "Payroll Deductions Payable", type: "liability", parent: "2000", role: "payroll_deductions", description: "Other authorised deductions held from pay" },
  { code: "3000", name: "Equity", type: "equity", parent: null, isGroup: true },
  { code: "3010", name: "Owner Capital", type: "equity", parent: "3000", role: "owner_capital" },
  { code: "3020", name: "Retained Earnings", type: "equity", parent: "3000", role: "retained_earnings" },
  { code: "4000", name: "Revenue", type: "revenue", parent: null, isGroup: true },
  { code: "4010", name: "Sales Revenue", type: "revenue", parent: "4000", role: "sales_revenue" },
  { code: "4020", name: "Sales Discounts", type: "revenue", parent: "4000", contra: true, role: "sales_discounts" },
  { code: "4030", name: "Sales Returns & Allowances", type: "revenue", parent: "4000", contra: true, role: "sales_returns" },
  { code: "4040", name: "Delivery / Shipping Income", type: "revenue", parent: "4000", role: "delivery_income" },
  { code: "4050", name: "Other Income", type: "revenue", parent: "4000", role: "other_income", description: "Income that isn't a sale, such as commission or rent received" },
  { code: "5000", name: "Cost of Sales", type: "expense", parent: null, isGroup: true },
  { code: "5010", name: "Cost of Goods Sold", type: "expense", parent: "5000", role: "cogs" },
  { code: "5030", name: "Inventory Adjustments & Write-offs", type: "expense", parent: "5000", role: "inventory_adjustments", description: "Stock lost, damaged or found, count differences and cost revaluations" },
  { code: "5020", name: "Purchase Returns & Allowances", type: "expense", parent: "5000", contra: true, description: "Optional: for purchase adjustments you enter by hand" },
  { code: "6000", name: "Operating Expenses", type: "expense", parent: null, isGroup: true },
  { code: "6010", name: "General Operating Expenses", type: "expense", parent: "6000", role: "operating_expenses" },
  { code: "6020", name: "Salaries", type: "expense", parent: "6000", role: "salaries" },
];

/** Which account a payment method's money lands in. Mobile wallets go to a CLEARING account: a recorded wallet payment is not bank settlement. @param {string} method */
export const paymentRoleOf = (method) => (method === "bank_transfer" ? "bank" : method === "jazzcash" || method === "easypaisa" ? "wallet_clearing" : "cash");

/* ───────── Dates (Pakistan time, UTC+5) ───────── */

const PKT_OFFSET_MS = 5 * 3600000;
/** YYYY-MM-DD in Pakistan time. @param {Date} date */
export const pktDateKey = (date) => new Date(date.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
export const monthOf = (dateKey) => dateKey.slice(0, 7);
export const isDateKey = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects impossible dates like 2026-02-30
};
/** The day before a YYYY-MM-DD. */
export const dayBefore = (dateKey) => new Date(Date.parse(`${dateKey}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/* ───────── Journal checks ───────── */

/**
 * Check journal lines against an account index ({ code: { name, type, contra, active, isGroup, control } }).
 * Pure, so the server and the tests use exactly the same rules.
 * @param {{ accountCode: string, debit: number, credit: number, partyType?: string | null, partyId?: string | null }[]} lines
 * @param {Record<string, any>} index
 */
export function checkJournalLines(lines, index) {
  /** @type {string[]} */
  const errors = [];
  let totalDebit = 0;
  let totalCredit = 0;
  if (!Array.isArray(lines) || lines.length < 2) errors.push("A journal needs at least two lines");
  (lines ?? []).forEach((l, i) => {
    const n = i + 1;
    const a = index[l.accountCode];
    if (!a) errors.push(`Line ${n}: account ${l.accountCode} doesn't exist`);
    else {
      if (!a.active) errors.push(`Line ${n}: account ${l.accountCode} ${a.name} is switched off`);
      if (a.isGroup) errors.push(`Line ${n}: ${a.name} is a heading, not an account you can post to`);
    }
    const ok = (v) => Number.isSafeInteger(v) && v >= 0;
    if (!ok(l.debit) || !ok(l.credit)) errors.push(`Line ${n}: amounts must be whole paisa, not negative`);
    else if ((l.debit > 0) === (l.credit > 0)) errors.push(`Line ${n}: put the amount in debit OR credit, not both and not neither`);
    if (l.partyType) {
      if (!l.partyId) errors.push(`Line ${n}: a customer or supplier needs its id`);
      if (a && a.control !== (l.partyType === "customer" ? "receivable" : "payable")) errors.push(`Line ${n}: ${l.partyType}s can only be recorded on ${l.partyType === "customer" ? "receivable" : "payable"} accounts`);
    }
    totalDebit += ok(l.debit) ? l.debit : 0;
    totalCredit += ok(l.credit) ? l.credit : 0;
  });
  if (totalDebit !== totalCredit) errors.push(`Debits (${totalDebit}) don't equal credits (${totalCredit})`);
  if (totalDebit === 0 && !errors.length) errors.push("A journal can't be empty");
  return { ok: errors.length === 0, errors, totalDebit, totalCredit };
}
