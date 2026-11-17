# Offline POS & reconnection sync (Phase 7)

## How it works
1. **Catalogue cache** – while online the POS downloads the products, variants, prices and the register warehouse's stock (`posCatalog`, 40 products per page) into IndexedDB (`italian-shoes-pos`). Refreshed when older than 12 h or on "Update catalogue".
2. **Offline sale** – the till searches/scans the cache, applies quantities, discount (only with `pos.override`) and a walk-in name, takes **cash paid in full**, and writes the sale to the IndexedDB queue (the write counts only once the transaction has committed). It gets one id, used forever as both `offlineId` and the checkout idempotency key, and the original timestamp. An offline receipt (`OFFLINE-XXXXXX`) is printed; the real sale number arrives on sync. Stock shown offline = cached stock minus sales still unsent.
3. **Sync** – `online` event, a 20 s timer and "Send now" trigger the engine (`src/lib/offlineSync.js`). One sync at a time (in-tab single-flight + Web Locks across tabs), oldest first, one sale per request to `posSyncSale`. Network/5xx trouble keeps the sale pending with exponential backoff + jitter (2 s … 15 min; a network outage never turns into "failed"; server errors fail after 12 tries). Refusals the cashier can't fix by resending are kept with the server's reason.
4. **Server (`syncOfflineSale`)** – runs the *same* `posCheckout` as an online sale: server prices, stock per warehouse, no negative stock, register ownership, discount permission, journals in the sale transaction, payments through `recordSalePayment`. The idempotency key makes retries / tabs / devices produce exactly one sale. Outcomes are stored in `posOfflineSyncs/{uid}__{offlineId}` (synced / conflict / failed / discarded) and audited (`pos.offline_sale`, `pos.offline_discard`).

## Conflicts (nothing is forced through)
| Conflict | Cause | Resolution |
|---|---|---|
| `stock` | server has fewer pairs than were sold offline | restock then **Retry**; or manager **Discard** |
| `price_changed` | server total ≠ total shown on the till | manager **Accept server price** (only if the cash taken covers it; difference audited) or Discard |
| `register` | register closed / not available | manager Discard (the register must be closed only after sync – the UI blocks closing while sales are unsent) |
| `unavailable` | product archived/inactive | Discard |
Statuses: pending → syncing → synced / conflict / failed / discarded. A sale the server already holds can't be discarded.

## Screens
POS (offline banner, offline catalogue note, cash-only tender, receipt), **Offline Sync** (`/admin/pos-sync`: pending / synced / attention counts, last sync, retry, details, accept price, discard; managers also see the server record of all tills).

## Setup
Deploy `firestore.rules` + `firestore.indexes.json` (new `posOfflineSyncs` rule and index). No migration.

## Limitations
- Since Stage 4 a **service worker** (`/sw.js`, built by `scripts/make-sw.mjs`) keeps the admin pages and scripts, so the admin can be reloaded or reopened while offline. Verified in real Chrome: the page and its scripts load from the saved copy with the server stopped. **Not yet verified:** a signed-in cashier completing an offline sale after such a reload (needs the Stage 5 browser test). A sign-in older than an hour cannot renew its token offline; the screen is drawn from the saved token's claims (display only) and every server call is checked afresh once online.
- Cash only, paid in full, walk-in customers only; opening/closing registers, cash in/out, customer lookup and bank/wallet payments need a connection.
- The queue lives in one browser profile on one computer; clearing site data deletes unsent sales (the browser is asked to make storage persistent).
- Offline totals use the cached price; the server's price wins and a difference holds the sale.
- Sales are sent for the signed-in cashier only; the sync engine runs while an admin page is open.
- No automatic merge of conflicting stock; a person decides.
