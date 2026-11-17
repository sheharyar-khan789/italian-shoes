# Physical-store POS (Phase 6)

## Flow
1. A cashier with `pos.register` opens a **register** (warehouse + opening cash). One open register per cashier (`registerLocks/{uid}`).
2. Sales: search by name, or scan/type a SKU (keyboard-wedge scanners work). Stock shown is the register warehouse's available stock.
3. Checkout (`posCheckout`): the server re-reads prices, stock and permissions, deducts stock through the inventory service (sourceType `pos_sale`, warehouse id, sale id), creates one central sale (`sales/sale__…`, channel `pos`) and posts its journal. Tenders are then recorded through `recordSalePayment` (idempotent keys), attributed to the register.
4. Cash in/out (`pos.cash`) with reason + note; cash out can't exceed expected cash. Posted to existing accounts (owner capital, bank, operating expenses).
5. Close: expected cash = opening + cash sales + cash in − cash out. A shortage/excess is saved on the session and posted as its own journal (operating expenses / cash). Posted journals are never edited.

## Permissions
`pos.access`, `pos.sell`, `pos.register`, `pos.cash`, `pos.override` (discounts, lowering a price), `pos.sessions.read`, `pos.reports`. The owner creates the Cashier and POS Manager roles with one button on *Register Sessions* (create-if-missing).

## Receipts
58 mm, 80 mm and standard page, printed through the browser print dialog (hidden iframe). Only saved data is printed; the app cannot detect a printer.

## Setup
Deploy `firestore.rules` and `firestore.indexes.json`; owner re-saves roles / creates POS roles; assign Cashier role to staff; have an active warehouse and initialised accounting (accounting off = sales still work, no journals).

## Limitations
No POS returns/voids, no offline mode. Barcode = SKU exact match. Name search = whole words. Tenders are recorded after the sale transaction (a failed tender leaves the sale part-paid with a "Take payment" action). Bank/wallet entries are records of a typed reference, not verified payments. Opening float has no journal. Variance is posted to the existing operating-expenses account.
