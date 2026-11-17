# Double-entry accounting

## Switching it on (owner)
1. Deploy the rules and indexes: `npx firebase deploy --only firestore:rules,firestore:indexes --project italianshoes`.
2. Re-save your own roles (Staff & Roles → Change roles → Save) and sign in again, so your sign-in carries the new `accounting.*` permissions (Owner only by default).
3. Admin → Accounting → **Create the chart of accounts**. This creates accounts only — **no balances** — and turns automatic posting on. Until you do, nothing is posted and the business runs exactly as before.
4. Opening Balances: enter what you already had (cash, bank, stock value, owed to suppliers, owner's capital). Preview, then post. Nothing is entered for you.
5. Optional: run the historical backfill (below) so earlier sales and purchases are in the books.

## Chart of accounts
Assets 1000 (Cash in Hand 1010, Bank 1020 › Main Bank 1021, JazzCash/Easypaisa Clearing 1030, COD/Courier Receivable 1100, Accounts Receivable 1110, Inventory 1200) · Liabilities 2000 (Accounts Payable 2010, Sales Tax Payable 2020) · Equity 3000 (Owner Capital 3010, Retained Earnings 3020) · Revenue 4000 (Sales Revenue 4010, Sales Discounts 4020 contra, Sales Returns 4030 contra, Delivery Income 4040) · Cost of Sales 5000 (COGS 5010, Purchase Returns & Allowances 5020 contra) · Operating Expenses 6000 (General 6010, Salaries 6020). Add accounts and sub-accounts (e.g. one per bank account); codes are unique and fixed; an account ever posted to can be switched off, never deleted. Each automatic job (cash, bank, wallet clearing, COGS …) can be pointed at another account of the right type.

## What posts (inside the business event's own transaction)
| Event | Journal |
|---|---|
| Online sale | Dr COD receivable (customer) total; Dr Sales discounts (markdown + coupon); Cr Sales revenue (list prices); Cr Delivery income; Cr Sales tax; and, only if every line's cost was recorded, Dr COGS / Cr Inventory |
| Customer payment / COD cash collected | Dr Cash, Bank, or **Wallet clearing**; Cr receivable |
| Refund | Dr receivable; Cr Cash |
| Cancelled / returned order | the sale's journal **reversed** |
| Payment entry reversed | that payment's journal reversed |
| Goods received (accepted) | Dr Inventory; Cr Accounts payable (supplier) |
| Supplier payment | Dr Accounts payable; Cr Cash/Bank/Wallet clearing |
| Purchase return | Dr Accounts payable; Cr Inventory |

COD is a **receivable** until cash is recorded as collected. Mobile-wallet payments go to a **clearing** account because a recorded wallet payment is not bank settlement. A sale with no recorded cost posts revenue only and is flagged ("costMissing"); profit reports say so.
Journal ids come from the source (`sale__{id}` …), so a source posts once; reversals are `reversal__{journalId}`, so a journal reverses once. Posted journals are never edited or deleted. If an account is switched off, the event still goes through and a **failed posting** is recorded (Journal Entries → retry), never dropped silently.

## Reports and reconciliation
Trial balance, P&L, balance sheet, cash flow, general ledger, receivables and payables come from posted journals via month/day totals (`accountMonths`, `accountDays`), not line scans. Reconciliation (Accounting Reports → Reconciliation) reports missing journals, amount mismatches, unbalanced entries, missing ledger lines and supplier-ledger differences. It repairs nothing.
Known limits: supplier opening balances are not posted automatically (enter them per supplier in Opening Balances); no year-end closing (current earnings are shown as one line); purchase returns credit inventory at the receipt's value, not the current average cost.

## Historical backfill (never automatic)
```bash
npm run migrate:accounting                                                                   # emulator, dry run
node functions/scripts/migrate-accounting.mjs --production --project italianshoes            # live dry run
node functions/scripts/migrate-accounting.mjs --production --project italianshoes --apply --confirm italianshoes
```
Posts journals for earlier sales (and their reversals), customer payments/refunds, goods received, supplier payments and purchase returns, dated on the day they happened, with the same rules as live postings. Nothing is invented: no cost → revenue only; a payment with no sale, or amounts that don't add up → skipped and listed. Idempotent; needs the chart to exist; changes no stock, sale, payment or supplier record.
