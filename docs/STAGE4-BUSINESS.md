# Stage 4 — Core business functionality (2026-11-17)

Not committed, pushed or deployed. Evidence per item is the test or observation named. Test totals are in the final report.

## 1. POS returns, refunds and exchanges — done, server-verified
- New: `functions/services/posReturns.js`, endpoints `posReturn` / `posReturnList` (permission `pos.return`, given to the POS Manager role and to the Owner; cashiers do not get it), `salesReturns` records numbered SR-000001…, screen: **Sales → a walk-in sale → "Return or exchange"** (`src/admin/views/sales.js`).
- One transaction, idempotent per key: checks each line against pairs sold minus pairs already returned; amounts come only from the sale's saved prices, discounts, tax and cost snapshot; resellable pairs go back to the warehouse the sale took them from, damaged pairs are written off; refund = only what the customer actually paid beyond what they still owe (the rest shrinks the unpaid balance); a cash refund is paid from the cashier's own open register, limited to the cash in it; one balanced journal (returns, discounts, tax, cost of goods, inventory or write-off, cash/bank/wallet, receivable); audit entry; sale, payment record and loyalty points updated.
- Tests (`posReturns.test.js`, 12): partial and full returns, books exactly reversed (to the paisa, including 10% tax on odd prices over three partial returns), damaged stock, part-paid sale, idempotent retry, over-return refused, closed sale refused, permissions, register rules, bank refund, exchange, every journal balanced.
- **Exchange** is a return flagged as an exchange, followed by an ordinary new sale; both are real records and the register ends with the net difference. It is not a single "net settlement" screen.
- **Known limits:** (a) sales-document reports (Sales Report, Analytics sales figures) subtract a return only when the whole sale is returned (status "returned"); a *partial* return shows correctly in the accounting reports and in the Returns list but the sale-based reports still count the full sale. (b) Online orders keep their own return flow (unchanged). (c) Loyalty-point reversal for a return uses the existing proportional rule; it is exercised by the CRM tests, not by a POS-return-specific test. (d) The new screen was not clicked through in a browser (Stage 5).

## 2. Offline POS in a browser — partly done
- Done: a service worker keeps the admin shell (`scripts/sw.template.js` → `dist/sw.js`, 102 files, versioned by content; registered by `src/admin/main.js` in production builds only). It never touches `/api`, Firebase or Blob, and never caches data.
- **Verified in real Chrome** (the in-app browser pane cannot register service workers at all): after one visit, the worker was active and 102 files were cached; with the preview server stopped, reloading `/admin` and `/admin/pos` still loaded the page and its script from the cache.
- Fixed a real blocker found on the way: with an expired saved token and no internet the admin stayed on "Loading…" forever. `src/app/session.js` now falls back to the saved token's claims for *display only* (`src/app/tokenClaims.js`, unit-tested).
- **Not verified:** a signed-in cashier ringing a sale offline after a reload, then syncing. That needs the emulator plus a scripted browser session (Stage 5). The queue and sync logic itself remains covered by the earlier unit and emulator tests.

## 3. Opening inventory balances — investigated, procedure proven on test data
- **Root cause (proved by `inventoryGoLive.test.js`):** stock typed on the Inventory screen (`adjustStock`: initial, damaged, found, adjustment) changes the shelf but posts **no journal**. Only goods received, approved Adjustments and Stock Counts post to the books. So the stock valuation and the inventory account differ by the value of that stock, and the first sale drives the inventory account **negative** (the −Rs 34,200 seen in the audit's emulator data). Those numbers were test data, not your shop.
- **Go-live procedure:** (1) count the shop; (2) enter the counted stock and cost prices; (3) read the valuation under Inventory → Reports → Valuation (it shows the books balance and the difference); (4) post **one** opening entry under Accounting → Opening Balances: debit Inventory, credit Owner Capital, for the valued amount, dated before the first sale; (5) the difference must now be zero and stays zero after sales (tested). Later stock corrections must use **Adjustments** or **Stock Counts** (journalled), not the quick Inventory screen.
- **Open decision for you:** shall the Inventory screen's quick adjust be switched to post journals as well, or be restricted to opening stock before go-live? I did not change it.
- Pairs without a cost price are valued at zero and listed; give them a cost before posting the opening entry.

## 4. Store logo upload — done
`setStoreLogo` / `removeStoreLogo`, upload token branch `logo/{uid}/…` (Owner settings permission), picture checked for real, shrunk to fit 600 × 600, WebP, metadata removed, stored in the **public** Blob store, old file deleted. Saving the settings form no longer wipes the logo (it would have: the form rewrote the whole public settings document). Screen: Settings → Store logo. Tests: `logo.test.js` (5). Needs the public Blob store token in Vercel (see `docs/OPERATIONS.md`). Not browser-tested.

## 5. Scheduler — done, depends on one variable
Vercel Cron calls `/api/cron` daily at 02:00 Pakistan time (`vercel.json`). It runs: recurring expenses (large ones still wait for an approver), loyalty expiry, scheduled report summaries. Each job is idempotent, one failure does not stop the others, and the result is kept in `system/cron`. The route refuses everyone unless `Authorization: Bearer <CRON_SECRET>` matches (constant-time compare; a missing or short secret disables it). **You must set `CRON_SECRET` (16+ random characters) in Vercel.** Tests: `cron.test.js` (3). The free plan allows daily crons only, which is what is used.

## 6. Bank reconciliation and period closing — done, server-verified
- **Reconciliation** (`bankReconciliation.js`, screen Accounting → Bank Reconciliation, permission `accounting.reconcile`): tick the ledger lines on the statement; it finishes only when cleared balance equals the statement balance to the paisa; lines are marked, never changed; the next statement continues from the last; only the latest reconciliation can be undone. Bank and wallet accounts only (cash is reconciled by the register count).
- **Period close** (`accountingPeriods.js`, screen Accounting → Period Close, permission `accounting.close`): refuses until the trial balance balances, no drafts are dated in the period and no automatic posting is waiting in Exceptions; afterwards the journal writer itself refuses any entry dated in the closed period (an automatic posting becomes an Exception instead of altering history); manual journals and finance entries/transfers are refused early with a clear message; reversals made today still work; reopening needs a reason and is recorded; history is kept.
- Tests: `bankPeriod.test.js` (8). Not tested: the finance entry/transfer early refusal; the two new screens in a browser.

## 7. HR statutory deductions and leave proration — reviewed, not implemented
- Already there: attendance-based deductions, unpaid leave, mid-month joiners and leavers (not-employed days), advances/loans, manual extra deductions.
- Missing and **needs your business/legal decision, so I did not invent figures:** income-tax withholding on salaries (FBR slabs change every budget), EOBI and provincial social-security contributions, provident fund, and leave carry-over / pro-rata entitlement for people who join mid-year (leave allowance is a fixed yearly number today). Tell me which apply to your staff and the rates, or whether your accountant handles them outside the system.

## 8. Settings audit — every visible setting checked against the code
Connected: store name, Urdu name, phone, email, address, hours, Instagram, announcement bar, store open/closed, order prefix, low-stock threshold, tax on/off and rate, new-order and low-stock notifications, currency (fixed PKR). **Were not connected and are now:** Facebook (now appears in the footer when set), store logo (new upload), search-engine title/description (now used on the home page when set). **Removed:** "Customers can create accounts" (Stage 3). No visible setting remains that changes nothing.

## 9. Payment gateways — unchanged
Cash on delivery only. No provider is approved, so nothing was built or simulated. This stays a pending business decision.

## Variables to set in Vercel (names only)
`CRON_SECRET` (new), `BLOB_PRIVATE_READ_WRITE_TOKEN` (Stage 3), `BLOB_READ_WRITE_TOKEN` (public store), plus the four already present.
