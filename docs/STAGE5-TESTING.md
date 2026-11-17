# Stage 5 — Browser end-to-end, real-world and load testing (2026-11-17)

Not committed, pushed or deployed. Everything here ran against the **local Firebase emulators** with throw-away accounts and data; no real customer, supplier, employee or financial record was touched.

## How to run
- `npm run e2e` — starts the emulators, builds the app in the special **"e2e" mode**, seeds people and a tiny catalogue, serves the built bundle (with its `/api`) on `http://localhost:5183`, and runs `tests/e2e/*.e2e.js` in real Google Chrome through `playwright-core` (the only new dependency, a dev dependency; it uses the Chrome already installed, nothing is downloaded). Options: `--rebuild`, `--grep <word>`, `--load`.
- `npm run e2e -- --load` — the HTTP load/concurrency test (`scripts/loadtest.mjs`).
- The "e2e" build mode is the **only** build that talks to the emulators (`src/app/firebase.js`); a normal production build can never reach them, and the live site is not built that way. Screenshots land in the git-ignored `e2e-output/`.

## Browser E2E results — 17 tests, all passing (real Chrome)
| File | What it proves |
|---|---|
| `auth-permissions` (7) | wrong password refused; Owner signs in, sees ≥60 modules, stays signed in after reload; a cashier sees only the till and is refused when typing admin addresses by hand; a cashier's real token is refused (401/403) on `saveSettings`, `setStaffRoles`, `closePeriod`, `posReturn`, `reverseJournal`, `saveProduct` while the Owner's is not; a customer account cannot enter the admin; storefront and sign-in pages load with no script errors or failed requests; password reset requests a reset for a real account, nothing for an unknown one, and the page answers alike (no account enumeration) |
| `admin-routes` (3) | **all 72 admin screens** open and draw with no script error, failed request or error panel; 10 critical screens have no sideways scrolling at 375 px and the mobile menu opens |
| `pos-flow` (3) | a cashier opens a register, rings up 2 pairs for cash, the receipt builds with store, item, amount and cashier; stock, sale record, payment status and journal agree with the database; the Owner takes 1 pair back from the sale screen (bank refund): refund, stock, `returnedTotal` and the screen all agree; a cashier is not offered the refund |
| `offline-pos` (1) | with the register open, the connection is cut and the page **reloaded**: the shell and till come back, the offline banner shows, a cash sale is rung up, **nothing reaches the server while offline**, and when the connection returns it is sent **exactly once** (one sale, stock down by one, journal posted, marked as an offline sale); reloading afterwards does not send it again |
| `reports-and-products` (3) | the Owner adds a product through the form, then sizes/colour with price and cost; saved exactly as typed (price in paisa), a duplicate web address is refused; the trial balance balances and lists revenue, cost of goods and sales returns made in the till tests; the Reports screen shows stock; the shop shows a published product and not an unpublished one |

## Real defects found by these tests — all fixed and regression-tested
1. **Offline reload never worked** (Stage 4's service worker): the cached files were not matched because the server's `Vary: Origin` header made the browser treat the saved copies as different requests, so the app's script never loaded offline (the page sat on "Loading…"). Fixed in `scripts/sw.template.js` (`ignoreVary`). Covered by `offline-pos.e2e.js`.
2. **The offline fallback never triggered on a real network failure** (since Phase 7): the code looked for the error code `unavailable`, but the API layer raises `functions/unavailable`; the unit tests used the wrong value, so they passed. The till showed an error instead of its saved register, and the sync engine would have counted a dropped connection as a failed sale attempt. Fixed in `src/admin/views/pos.js`, `src/admin/offline.js`, `src/lib/offlineSync.js`; unit regression test added (`tests/unit/offlineSync.test.js`).
3. **The Reports screen's stock panel was broken since Phase 10**: two endpoints were both called `inventoryReport`, and the later one silently replaced the first. The older one is now `stockSummaryReport`, and the endpoint registry **refuses to start on a duplicate name** (`functions/registry.js`). Regression assertion in `security.test.js`.
4. Found in Stage 4's own review, kept for the record: an expired saved sign-in kept the admin on "Loading…" offline (`src/app/tokenClaims.js`).

## Load and concurrency test — what it does and does not show
Configuration: one Windows laptop running the test server, the Firestore **emulator** and the test script together; Node 24; 10 concurrent users for 8 s of mixed reads; 8 simultaneous sales for the last 5 pairs; 20 identical requests at once. Raw result: `e2e-output/load-result.json` (regenerate with `npm run e2e -- --load`; defaults are 25 users / 20 s / 40 sales).

| Check | Result |
|---|---|
| Mixed reads, 10 concurrent, 8 s, 75 requests (≈9 per second), **0 errors** | `posContext` p50 108 ms / p95 463; `posSearch` 294 / 3,502; `salesReport` 190 / 578; `inventoryDashboard` 334 / 6,962; **`trialBalance` 2,853 / 7,062** |
| 8 tills sell the **last 5 pairs at once** | exactly 5 sold, 3 refused (HTTP 400), stock ends at 0, 5 sales, 5 journals: **no overselling** |
| The same sale request sent 20 times at once | 20 replies, **1 sale** on the server |

**Bottlenecks identified (not fixed — they are performance, not correctness):**
1. **Hot documents serialise every sale.** Each sale updates the sale-number counter, the accounting journal counter, the register session and the product's stock document in one transaction; eight at once took a p50 of 8.3 s and p95 of 11.4 s here, and 40 at once did not finish in several minutes on the emulator. One shop with a few tills selling seconds apart will not feel this; a rush of simultaneous sales would queue. Remedy when needed: sharded counters, and moving journal numbering out of the sale transaction.
2. **Full-ledger reports are slow under load**: trial balance and the inventory dashboard recompute from the books on every call (p95 7 s at 10 users). Remedy: use the existing analytics cache stamps for them or paginate.
3. The emulator is slower than real Firestore and the numbers will differ in production. **No capacity (users, sales per minute) is claimed.** A staging Firebase project and a deployed staging site are required for a meaningful capacity figure; none exists.

## Not verified — and why
| Item | Status |
|---|---|
| Real email delivery for password reset and verification | **Unverified**: no email provider can be used from here; only the request to Firebase was verified (emulator). |
| Real receipt printer, thermal width, barcode scanner | **Unverified**: no hardware. The receipt document is built and its content checked; the browser's print dialog, paper width and scanner input were not exercised. |
| Image upload, logo upload, private HR/receipt documents in a browser | **Unverified**: they need the Blob stores, which are not connected. Server-side behaviour is covered by emulator tests. |
| Purchasing (PO → receive → supplier payment), stock adjustments/counts, HR attendance and payroll **through the browser** | **Not browser-tested** in this stage; covered by server tests (purchasing 26, inventory 34, HR 21, accounting). Their screens were opened by the all-routes test (no errors). |
| Live site, live Firebase and Vercel, real device browsers (Safari, Firefox, Android) | **Unverified**: only Chrome desktop and a 375 px Chrome viewport. |
| Staff sign-in older than an hour while offline | Display-only fallback tested in unit tests; a full offline day was not simulated. |
