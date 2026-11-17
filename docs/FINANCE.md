# Income, expenses & cash management (Phase 8)

Built on the Phase 5 double-entry engine; there is no second accounting system. Every money movement is posted by
`services/finance.js` through `postInTx`/`reverseInTx` **in the same Firestore transaction** that saves the record.
Accounting must be set up first (otherwise saving is refused with a clear message).

## Data
| Collection | What |
|---|---|
| `financeEntries/{id}` | income / expense / transfer / adjustment: number `FN-000001`, version, status (posted, pending, rejected, void), date, integer paisa amount, category, method, account, reference, vendor, attachments, history |
| `financeCategories/{id}` | income & expense categories (name, optional specific chart account, else an account **role**) |
| `recurringExpenses/{id}` | recurring templates (weekly / monthly, next date) |
| `cashCounts/{id}` | reconciliation records: expected (from the books), counted, difference, result |
| `settings/finance` | approval limit |
| `counters/finance` | entry numbers |
All written only by the server (rules: read = `finance.read`, write = false). New: role `other_income` + default account **4050 Other Income** (existing charts: add the account / set the role in the Chart of Accounts).

## Posting rules
- Income: Dr cash/bank/wallet clearing, Cr category income account. Expense: Dr category expense account, Cr cash/bank/wallet. Transfer: Dr receiving account, Cr paying account (**not income or expense**). Cash-count difference (authorised): shortage Dr Operating expenses / Cr account; excess opposite.
- Journal id `finance__{entry}__v{n}`: one journal per entry version, so a retry can never double-post. **Edit** = reverse v(n) (on the entry's own date) + post v(n+1). **Delete** = reverse + status `void` (record kept). Posted journals are never changed.
- Duplicate submissions: idempotency keys (`idempotency/finance__{uid}__{key}`); recurring entries use `rec_{id}_{date}`.
- Wallet money goes to the clearing account (not the bank); settle with a transfer.

## Permissions
`finance.read`, `finance.write`, `finance.void`, `finance.approve`, `finance.adjust`, `finance.manage`. Expenses at/over the approval limit entered by someone without `finance.approve` wait as *pending* (no journal); another person approves (maker-checker) or rejects. Differences found at a cash count are recorded by `finance.write` but only posted with `finance.adjust`.

## Screens
Financial Dashboard (presets + custom range), Income, Expenses (receipts, history, approve), Cash & Bank Management (balances, transfers, counts, daily cash summary, add bank account), Financial Reports (9 reports, CSV, print/PDF), Finance Settings (categories, approval limit, recurring).
Dashboard figures come from the books (P&L, balances); income is recognised when a sale is recorded.

## Setup
Deploy `firestore.rules` + `firestore.indexes.json`. Owner: open Finance Settings → "Add suggested categories"; give staff the finance permissions. Receipts need the Vercel Blob store (`BLOB_READ_WRITE_TOKEN`).

## Limitations
- Receipts/invoices are stored in the same **public** Blob store as product photos under an unguessable URL (anyone holding the link can open it).
- Receipt upload needs a connected Blob store and was not exercised against the real store here.
- Recurring expenses have no background scheduler: press "Create due expenses".
- Cash balance checks on transfers are made just before posting (not locked), so two simultaneous transfers could both pass.
- Owner drawings / capital injections are not separate entry types (use a manual journal); reports for POS register cash-outs are in the POS reports.
- Daily / cash register / bank reports cover ≤ ~3 months; category and ledger reports ≤ 5,000 entries.
- Expenses categories report covers entered expenses only (supplier payments and register expenses have their own reports).
