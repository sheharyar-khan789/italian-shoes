# Warehouses, transfers and the stock migration

## What changed
- Stock is kept **per warehouse** inside the existing `inventory/{productId}__{variantId}` document (`byWarehouse`). `onHand`/`reserved`/`available` at the top stay the **online-eligible** totals, so the shop and checkout read exactly what they read before. `totalOnHand` is every warehouse added together.
- A document without `byWarehouse` is read as "all in the default warehouse (`main`)". The website therefore works unchanged before, during and after the migration.
- Admin: **Warehouses**, **Stock Transfers**, and a paged, warehouse-aware **Inventory & Stock**.
- New permissions: `warehouses.manage`, `transfers.manage` (Owner and Inventory Manager). Existing role documents are not rewritten; the server adds the new permissions when it reads the roles. **After deploying, the Owner opens Staff & Roles → Change roles on their own account → Save**, then signs out and in, so their sign-in carries the new permissions.

## Migration (optional but recommended; never runs by itself)
It gives every old inventory document its `byWarehouse` breakdown (all stock in `main`), creates the default warehouse document if missing, and changes **no quantity**. Nothing is deleted. It is not part of `npm run migrate`.

```bash
# 1. Dry run (writes nothing): emulator
npm run migrate:warehouses
# 2. Dry run on the live database (needs Google application-default login on this computer)
node functions/scripts/migrate-warehouses.mjs --production --project italianshoes
# 3. Only after reading the report and approving: apply
node functions/scripts/migrate-warehouses.mjs --production --project italianshoes --apply --confirm italianshoes
```
The report lists duplicate, orphan, missing and inconsistent documents. Those are **left untouched** for a person to review. After applying, every document is re-read and compared with what it held before (`verification.mismatches` must be empty). Running it again changes nothing.
Old stock movements have no `warehouseId`; screens treat that as the default warehouse.

## Transfers
`draft → send → receive`, or cancel a draft. **Send** removes the pairs from the source (refused if it doesn't hold them); they are then "on the transfer", in no warehouse. **Receive** adds them to the destination, once. Each step is one transaction, so nothing is half-applied. A sent transfer can't be cancelled. Receiving is all-or-nothing; a shortage found on arrival is corrected afterwards with a stock adjustment (reason: damaged / correction).

## Spark reads (what Phase 2 reduces)
- `/api/catalog` is served from `catalogSnapshot` (1 + a few reads) and rebuilt only after a change that customers can see (or after 30 minutes as a safety net).
- Orders update the product's stock summary inside the same transaction (no re-reading of products afterwards).
- A delivery quote reads the methods and rates once.
- Inventory lists load 25 rows per page, filtered by the database.
