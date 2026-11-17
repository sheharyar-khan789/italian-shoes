# Advanced CRM, customers & loyalty (Phase 11)

Built on the existing customers (`users`), sales (`sales`, `payments/{saleId}/transactions`), the POS checkout (`posCheckout`), the offline POS sync and the
Phase 5 accounting engine. **No second CRM, sales or accounting system was created**: a CRM profile is a layer keyed to the ids that already exist.

## Architecture
- `crmCustomers/{id}` – the profile. For a customer with an online account the id **is** the account uid; walk-in customers get a random id. `reference` is
  `CUST-000001…` from `counters/crmCustomers`. Details, tags, optional date of birth, consent flags and a **statistics snapshot** (`stats`, `segments`, `tier`, `statsAt`).
- `crmKeys/{phone_…|email_…}` – a server-only registry that makes phone and email unique **inside the same transaction** as the profile write (duplicates are refused with the
  existing customer's name and reference; editing moves the keys).
- `crmNotes` – notes, calls, WhatsApp chats, feedback (rating), complaints (status + required resolution), follow-ups (date), warranty text.
- `crmSettings/main` – customer types, group thresholds, membership tiers and loyalty rules. `CRM_DEFAULTS` (`shared/crm.js`) are only the values shown before the owner saves; the loyalty programme is **off** until enabled.
- `loyaltyAccounts`, `loyaltyLots` (earned points with an expiry, spent oldest-expiry first), `loyaltyTransactions` (earn / redeem / reversal / expire / adjust).
- `crmDiscounts`, `crmDiscountUses` – customer discounts and their usage.
- Pure rules are in `shared/crm.js` (`computeSegments`, `tierFor`, `pointsForSale`, `redeemCheck`, `maxRedeemable`, `evaluateDiscount`, `bestDiscount`) and run on the server; the browser never decides an amount.
- Services: `functions/services/{crm,loyalty,crmDiscounts,crmInsights}.js`; endpoints `functions/callable/crm.js`; screens `src/admin/views/crm*.js`.
- Statistics are **snapshots** refreshed after a sale / refund / payment, when a profile is opened, and by "Recalculate all customers". Lists and the dashboard read the snapshots, so they stay cheap.

## Permissions (all server-checked; rules: read = `crm.read`, no browser writes)
`crm.read` (view customers incl. contact details, reports), `crm.write` (create/edit customers, notes, complaints, create at the POS), `crm.manage` (settings, tiers, loyalty rules, discounts, archive, expire points, recalculate), `crm.loyalty` (manual point adjustments). The owner holds all. POS lookup/quote need `pos.sell`.

## Customer groups and tiers
Groups (New, Returning, Regular, VIP, High-value, Inactive) are computed from real purchases with the owner's thresholds (`segments`); a customer can be in several. A tier is the highest whose **minimum spend in the last 12 months** is met; tier changes are audited. One tier must start at Rs 0.

## Loyalty calculation
- **Earning**: only when the sale is **fully paid** (`amountDue = 0`); points = `floor(eligibleAmount × pointsPer100 × tierMultiplier / 10,000)` where `eligibleAmount` = Σ(line total − coupon share) of lines not in an excluded category/product (so redeemed points and discounts do not earn points). Idempotent: the transaction id is `earn__{saleId}`; a retried request, a re-run hook or an offline re-sync cannot earn twice. A part-paid sale earns when the last payment lands.
- **Redeeming** (POS, inside the checkout transaction): checked against the balance, the minimum, the per-sale maximum and `maxRedeemPercent` of the payable amount; value = points × `redeemValuePerPoint`; points are taken oldest-expiry first; booked as an **additional sale discount** (account 4020 Sales Discounts). Only for customers with a profile, never for walk-ins or offline sales.
- **Refund reversal**: after a refund, the points earned on that sale are reversed in proportion to the refunded share (`reversal__{saleId}__{refundedTotal}`), computed as a delta against `reversedPoints` so repeating the hook is harmless; never below zero. Points already spent can't be recovered; the shortfall is recorded as `unrecovered`.
- **Expiry**: each lot has `expiresAt` (`expiryDays`, 0 = never). `expireLoyaltyPoints` (crm.manage) writes expiry transactions; balances ignore expired lots even before it is run.
- **Adjustments**: `loyaltyAdjust` (crm.loyalty) needs a reason, an idempotency key and is audited.

## Customer discounts
Customer-specific, tier, group (segment) or everyone; percent or fixed; minimum purchase; validity dates; total and per-customer usage limits; category/product restrictions. Applied only when the cashier ticks "Apply this customer's discount"; the **server** picks the **single best** eligible discount (a tier's own discount % counts as a candidate), never stacks two, and **refuses** it together with a manual discount. Usage is counted in the same transaction as the sale. `posCrmQuote` gives the till a no-write preview that uses the same functions.

## POS integration
Look up by name / phone / email / `CUST-` reference (`posCustomerLookup` → `crmLookup`; an account holder gets a profile on first lookup, deduplicated by phone); create a customer (`crmQuickCreate`, consent only if ticked); loyalty balance and tier shown; discount and points boxes; the till shows `posCrmQuote` and the checkout result decides. Offline mode keeps selling to walk-ins only (customer features need a connection); offline syncs call the same `posCheckout`, so no duplicate customers or loyalty transactions are created.

## Accounting
No new engine. Receivables (`partyBalances/customer__{id}`), part payments, refunds and journals are the existing ones; customer discounts and redeemed points are part of the sale's `discountTotal` and post to 4020 Sales Discounts in the sale's immutable journal (idempotent, keyed by the sale). Loyalty points carry **no liability accrual** (see limitations).

## Communication and privacy
Consent flags (`marketing`, `whatsapp`, `sms`, `email`) are stored per customer and default to false. The "Open WhatsApp chat" button (a `wa.me` link, opened by a person) appears only when the customer agreed to WhatsApp messages. **Nothing is sent automatically and there is no bulk messaging.** Date of birth is optional; birthday reports list only customers who volunteered it. Only the fields needed are collected. Every customer change, tier change, loyalty adjustment and discount change is audited.

## Reports (date filters, CSV and print/PDF)
Directory, Purchases, Top customers, Retention, Lifetime value, Segmentation, Loyalty points, Discount usage, Inactive customers, Customer returns, plus Birthdays and Follow-ups. All from real records (`crmReport`).

## Limits
Customer scans are bounded at 2,000 profiles and 5,000 sales per report/recalculation (a clear error beyond that). Walk-in sales are matched to a profile only by normalised phone. See the completion report for the full list.
