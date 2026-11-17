# Unified sales

## What it is
One `sales/{id}` record per sale, whatever the channel (`online` now, `pos` later — no POS screen exists yet). An **online sale has the same id as its order** and is created in the very transaction that creates the order, takes the stock and writes the payment record. Creating the same id twice fails, and a retried order returns early through its idempotency record, so "exactly one sale per order" is enforced by the database. Order numbers, checkout, coupons, COD, history and notifications are unchanged; the order only gains `saleId` and `saleNumber`.

## What a sale holds (all integer paisa, validated by `saleSchema` before saving)
Sale number (SL-000001…), channel, order link, customer snapshot (or none for walk-in), warehouse(s), lines (product, SKU, colour, size, quantity, list price, price charged, sale-price discount, coupon share, line total, warehouses the pairs came from), gross sales, discounts, net sales, tax, delivery, total, payment method and status, paid / refunded / due, status, idempotency key, who and when.
`saleCosts/{id}` holds the **cost snapshot** (cost per pair at the moment of sale, cost of goods, gross profit). It is separate so staff who may see sales but not costs never receive it (`costs.read`). Later cost, price or name changes never alter a saved sale.

## Stock
The sale never touches stock. The stock service deducts once in the order transaction and restocks once on cancellation or return; the sale records where each pair came from.

## Payments
`payments/{id}` (+ append-only `transactions`) stays the payment record. Every change to it, to the order, or to the order's status updates the sale **in the same transaction**, so the three always agree. Methods: COD, cash, bank transfer, JazzCash, Easypaisa. Part-payments and several payments are supported (`pending → partially_paid → collected`); "Record cash collected" after an advance collects only what is still due. These are **records** of money received outside the system; nothing here is, or claims to be, a verified gateway payment.
Corrections never edit history: **Reverse** adds an opposite `reversal` entry that points at the original (one reversal per entry, refused once money was refunded or the sale is closed).

## Gross profit is not net profit
Gross profit = net sales − cost of goods (from each sale's cost snapshot). Delivery and tax are outside it, and so are expenses, salaries and rent (later phases). Sales with no recorded cost (all historical orders, or products with no cost) are left out of profit rather than guessed.

## Historical orders (not run automatically)
```bash
npm run migrate:sales                                                        # emulator, dry run
node functions/scripts/migrate-sales.mjs --production --project italianshoes                 # live dry run
node functions/scripts/migrate-sales.mjs --production --project italianshoes --apply --confirm italianshoes
```
Creates a sale for each older order from what the order already says, keeping its dates; only adds `saleId`/`saleNumber` to the order; invents no cost; skips (and reports) orders whose totals don't add up; reports sales without an order and disagreements. Idempotent. Run it right after deploying so older orders get their sale numbers first.

## Deploy checklist
`npx firebase deploy --only firestore:rules,firestore:indexes --project italianshoes`; the Owner re-saves their roles (new permission `sales.read`) and signs in again; then, after reading the dry run, apply the backfill.
