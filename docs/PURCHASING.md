# Suppliers and purchasing

## Flow
Supplier → **Purchase order** (draft → approved/ordered) → **Goods received note** (GRN, partial or full) → stock + supplier balance → **Payments** and **Returns**.
Only a GRN adds stock, and only for the *accepted* pairs. Damaged or rejected pairs are recorded on the GRN, are not stocked and are not owed for.

## Money (integer paisa everywhere; `shared/purchase.js`)
- line = cost × qty − line discount; subtotal = Σ lines; total = subtotal − order discount.
- The order discount is shared over the lines in proportion to their amount (largest remainder), so the lines always add up to the total exactly.
- A line received in several parts is valued cumulatively, so the parts add up to the line amount with no rounding drift.
- The server recalculates everything; totals sent by the browser are never used.

## Cost (moving average)
When a GRN accepts `q` pairs worth `V`:
`new cost = (pairs on hand in all warehouses × current cost + V) ÷ (pairs on hand + q)` (rounded half up to a paisa).
With no stock, or no cost on file, the new purchase's own cost is the cost. `variantCosts.costPrice` holds the current cost (so the product page shows it); an owner's manual cost is respected as the baseline for the next purchase. Every purchase is kept forever in `variantCostHistory` (qty, value, unit cost, stock before, cost before/after), and each GRN line keeps its own cost snapshot, so later cost changes never rewrite history. A purchase return leaves the average unchanged.

## Supplier ledger (a payable account)
credit = owed more (opening balance, goods received); debit = owed less (payment, return). `balanceAfter` is the running balance; positive = the store owes the supplier. Each ledger line is written in the same transaction as the event, together with the supplier's `balance`.

## Payments
Cash, bank transfer, JazzCash, Easypaisa. These **record** a payment made outside the system; nothing is sent or charged and no gateway is connected. Bank/wallet payments need a reference. A payment can't exceed what the supplier is owed or (when tied to an order) what that order still owes after returns and earlier payments. Several part-payments are allowed. There is no payment reversal yet; a mistaken entry needs a correcting entry in a later phase.

## Safety
Receiving, paying and returning use idempotency keys (`idempotency/grn__…`, `pay__…`, `ret__…`) and one transaction each. A repeated or simultaneous request returns the first result. Quantities can't exceed what is pending (receiving) or returnable (returns). All writes are server-side; rules allow reads only with `purchases.read` (`costs.read` for cost history).

## Permissions (Owner and Inventory Manager get them; payments are Owner-only by default)
`purchases.read`, `suppliers.manage`, `purchases.manage`, `suppliers.pay`. After deploying, the Owner re-saves their roles (Staff & Roles → Change roles → Save) and signs in again so their sign-in carries them. Deploy the new indexes: `npx firebase deploy --only firestore:rules,firestore:indexes --project italianshoes`.

## Phase 9 additions
- **Supplier**: WhatsApp, tax number (NTN/STRN) and uploaded documents (same receipt uploader and public Blob store as Phase 8: `receipts/{uid}/…`, PDF/image ≤ 5 MB, allowed for `purchases.manage` / `suppliers.manage` / `finance.write`). Totals purchased / returned / paid / refunded and the balance come from the ledger writer.
- **Purchase order**: purchase date, supplier reference, tax % (on the order after discount, half-up) and up to five additional charges (freight, packing…), attachments. Tax and charges are shared over the lines (largest remainder) and **added to the cost of the goods** (landed cost), so GRN values, inventory cost and accounts payable all include them and the lines add up to the order total exactly. There is no separate input-tax account: tax is not reclaimed.
- **GRN**: rejected pairs carry a kind — damaged, missing or wrong size/item — plus a reason; only accepted pairs add stock and are owed for.
- **Advance payments**: `suppliers.adjust` permission + an explicit "advance" tick; allowed only when the amount exceeds what is owed (or the supplier is owed nothing) and not tied to an order. The supplier balance goes negative (a credit held with us); later goods received use it up. Journal is the normal supplier payment (Dr Accounts payable / Cr cash, bank or wallet clearing).
- **Refund from supplier** (`SR-…`, `suppliers.adjust`): only up to the credit held; Dr cash/bank/wallet clearing, Cr Accounts payable; ledger type "refund".
- **Balance adjustment** (`SA-…`, `suppliers.adjust`): increase or decrease, reason required, the other side posted to an account the person chooses (never payables or a receivable control account; e.g. 5020 Purchase Returns & Allowances); ledger type "adjustment".
- **Credit notes**: a purchase return (`PRT-…`) is the supplier credit note; the supplier's own credit-note number is kept in its reference.
- **Dashboard & reports** (`/admin/purchase-dashboard`): purchases (goods received), pending / partially received orders, payables, payments, returns, recent purchases; reports: purchase register, supplier-wise, product-wise, returns, supplier outstanding, supplier ledger (opening → running balance → closing), goods receiving (with damaged / missing detail); date filters, CSV and print/PDF.
- Opening balances entered on a supplier are a ledger line only; they reach the accounting books through Accounting → Opening balances, so the payables account equals the sum of supplier balances **less unposted opening balances**.
- New collections: `supplierRefunds`, `supplierAdjustments` (read `purchases.read`, never written from a browser). New permission `suppliers.adjust`.
