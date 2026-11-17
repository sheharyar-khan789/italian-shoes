# Advanced inventory & warehouse management (Phase 10)

Built on the existing inventory (`inventory/{pid__vid}` with `byWarehouse`, `stockMovements`, `variantCosts`), warehouses, transfers
and the Phase 5 accounting engine. No second inventory or accounting system was created.

## Architecture
- **One stock writer**: every quantity change still goes through `services/inventory.js` (`writeStockChange`): per-warehouse, atomic, refuses
  negative stock or stock below what is reserved, and writes a movement (`warehouseId`, `sourceType`, `sourceId`, before/after).
- **Costing**: weighted (moving) average cost, kept per variant in `variantCosts.costPrice` by goods receipts (unchanged). Valuation = pairs × average cost.
- **New records** (written only by the server; rules: read = `inventory.read`):
  `stockAdjustments`, `stockCounts` (+ `stockCountLocks`, server only), `stockPolicies` (min / reorder / max / shelf per warehouse),
  `barcodes/{code}` (code = document id, so unique), `settings/inventory` (alert and approval thresholds); transfers gain `requested`, `partially_received`
  and per-line `receivedQty / damagedQty / missingQty`.
- New permissions: `inventory.count`, `inventory.approve`, `inventory.manage` (plus existing `inventory.read`, `inventory.adjust`, `transfers.manage`).

## Adjustments (`ADJ-…`)
A recorded change: previous quantity, change, new quantity, reason (correction, damaged, lost, missing, found, internal use, other), description, who/when, history.
`seenOnHand` makes a stale screen fail instead of overwriting newer movements. Units/value above the limits in `settings/inventory`, entered without `inventory.approve`,
wait as *pending*; another person approves (stock re-checked at that moment) or rejects.

## Transfers
`draft → requested → dispatched (in_transit) → partially_received → received` (or cancelled before dispatch). Dispatch takes the pairs out of the source; each receipt (`receiveTransferLines`,
idempotent per key) puts the pairs that arrived into the destination and writes off damaged/missing pairs at cost (they had already left the source). Nothing is duplicated: pairs are in a warehouse,
on a transfer, or written off. Moving stock between warehouses posts **no** journal.

## Physical counts (`CNT-…`)
One open count per warehouse. Each counted line stores the system quantity **at the moment it was counted**; applying changes stock by (counted − that quantity), so sales/receipts after the count are kept.
`counting → submitted → approved → applied` (or rejected / cancelled). Applying is batched and idempotent per line; a line that would take stock below zero/reserved is flagged for a person.
An approver who also ran the count may approve (recorded as `selfApproved`).

## Accounting
New role/account **5030 Inventory Adjustments & Write-offs** (`inventory_adjustments`; existing charts: add the account / set the role in Chart of Accounts).
Loss (damaged, lost, missing, internal use, short count, transfer shortfall): Dr 5030 / Cr Inventory at average cost. Gain: Dr Inventory / Cr 5030. Cost revaluation (approvers): the difference
× pairs on hand, same two accounts, kept in `variantCostHistory`. Journal ids come from the source (`stockadjustment__{id}`, `costrevaluation__{id}`), so they post once and are never edited. A variant with no
recorded cost still adjusts; the write-off is flagged "no cost" and not posted.

## Valuation & reconciliation
Detailed valuation of stock now (by product, variant, warehouse) with the inventory account balance now and at a chosen date from the ledger; the difference is shown. It is zero when all stock came in through
goods receipts and all changes through the services above; opening balances not yet posted, or stock without a cost, explain a difference.

## Alerts
Out of stock, low (global threshold or the variant's own minimum), reorder level, overstock (> maximum), slow-moving (stock but no sale in N days), dead stock (no movement in M days). Thresholds are configurable.
Expiry alerts are **not** implemented: products have no expiry data.

## Barcodes
Per-variant barcode: a code you already have (8–14 digits; 13 digits must be a valid EAN-13) or a generated in-store EAN-13 (200 range). Unique across variants. Lookup by scan (barcode or SKU); the POS and the offline POS catalogue
find a scanned barcode (SKU scanning is unchanged). Labels (name, size/colour, SKU, price, EAN-13 barcode) print through the browser.

## Screens
Inventory Dashboard, Stock Levels & Barcodes, Stock Adjustments, Stock Counts, Inventory Reports (12 reports with dates, warehouse filter, CSV and print/PDF), and the existing Stock Transfers with request / partial receive.

## Setup
Deploy `firestore.rules`. Owner: add account 5030 / set the "Inventory adjustments & write-offs" role if the chart already existed; give staff the new permissions; set alert thresholds on the dashboard.

## Limitations
- Permission-based access only: there is no per-warehouse restriction for individual staff.
- Dashboard, alerts and valuation scan up to 2,000 size/colour variants (they say so beyond that); each load reads roughly 5 documents per variant (mind the Spark daily read limit).
- Historical valuation by date comes from the ledger (posted journals); per-variant quantities and costs at a past date are not reconstructed.
- "Damaged stock" is damaged pairs *written off* (adjustments + transfers); there is no separate quarantine bucket. "Returned" is pairs returned to suppliers.
- Slow/dead checks read up to 5,000 recent movements; beyond that they are skipped with a note.
- Counts list at most 300 variants automatically; others can be added by hand.
- Label printing is browser printing (no printer detection); barcodes are EAN-13 only.
