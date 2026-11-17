# Test Results (audit run, 2026-11-17)

All runs were against the local Firebase emulators (project `demo-italianshoes`). Nothing touched production.

| Check | Result |
|---|---|
| ESLint | Clean (0 errors) |
| TypeScript check (`tsc`, JS with JSDoc) | Clean |
| Secrets scan (CI script) | Clean |
| Production build (Vite) | Succeeds; warning for chunk > 500 kB |
| Unit tests (`tests/unit`) | **185 / 185 pass** |
| Emulator test files | 23 files (rules 33, warehouses 21, hr 21, accounting 21, pos 19, analytics 19, crm 15, sales 14, purchasing 14, finance 14, inventoryAdvanced 13, purchasingPhase9 12, orders 11, posOffline 9, payments 8, api 8, coupons 7, catalog 7, staff 6, images 5, functions 5, engage 5, settings 4 = 268 tests) |
| Full emulator suite, run alone, in order | **291 / 291 pass, 0 fail, 0 skipped** (duration about 38 minutes). The per-file counts listed above sum to 268; the runner's real total is 291, so those per-file counts are approximate. |
| Earlier complete full-suite run (Phase 12, before HR) | 268 / 268 pass (that count did not include the Phase 13 additions) |
| Phase 13 files run singly | hr 21/21, analytics 19/19, crm 15/15, staff + rules 39/39 pass |
| `npm audit --omit=dev` | **Fails the repository's own gate:** 10 vulnerabilities in the root (4 high, 6 moderate), 6 moderate in `functions/` (S-02) |

## Not covered by any automated test
- Browser end-to-end flows (no Playwright/Cypress) — T-01.
- HTTP-level load/concurrency against a deployed site — T-02.
- Real printers, barcode scanners, a real offline browser cycle, email delivery.
- Live Firebase/Vercel configuration.

## Known test weaknesses
- Some tests depend on the current date (T-03).
- Emulator tests share one database, so they must run one at a time; running them in parallel corrupts results.
- The 185 unit tests include fake-store tests of the offline queue; they do not prove IndexedDB behaviour in a real browser.
