# Production certification — Italian Shoes Management System

Date: 2026-11-17/18 · Release candidate: branch `recovery/phases-5-13`, commit `91fb564` (code) — a documentation-only commit follows it.
Nothing has been deployed to production, and no production setting was changed. Production still runs the old commit `92d0d61`.

## Verdict: **CONDITIONALLY READY** — and **NOT READY to switch on** until gates G1–G6 below are closed
The software passes everything that can be tested without the live accounts: unit, emulator, browser and CI checks all pass on the release commit. What stands between it and real customers is not missing code but **owner actions and an approved deployment**: a service-account key whose rotation I could not confirm, security rules and 33 database indexes that are not deployed, two storage stores and a scheduler secret that are not configured, no running backup, and unverified Firebase console hardening. If any of G1–G6 is skipped, the verdict is NOT READY.

## Scores (from evidence, not from the number of prompts executed)
| Dimension | Weight | Implemented | Verified working | Production-ready |
|---|---:|---:|---:|---:|
| Frontend | 10 | 90 | 65 | 55 |
| Backend | 12 | 95 | 92 | 70 |
| Database integration | 10 | 95 | 88 | 60 |
| Real functionality (no dummy) | 8 | 95 | 85 | 70 |
| Business workflows | 20 | 85 | 72 | 50 |
| Accounting integration | 10 | 95 | 90 | 70 |
| Security | 15 | 88 | 78 | 55 |
| Automated testing | 8 | 88 | 88 | 70 |
| Reporting | 7 | 92 | 80 | 65 |
| **Weighted total** | 100 | **≈ 91 %** | **≈ 81 %** | **≈ 61 %** |

Before the six stages the same method gave 83 / 68 / 46. "Verified" counts only what a test or an observed run exercised (browser tests cover login, permissions, product creation, POS sale, receipt, return, offline sale and sync, and all 72 screens opening; purchasing, stock counts and payroll are verified at server level only). "Production-ready" additionally requires the thing to be deployed, configured and operable, which it is not yet. The gap between 91 and 61 is the point of this report.

## Test evidence (exact counts)
| Check | Result |
|---|---|
| ESLint, TypeScript, production build, secrets scan | clean, also from a **fresh clone of the pushed branch** with `npm ci` |
| Unit tests | **188 / 188** pass |
| Firebase emulator suite (security rules, every module, security regression, POS returns, bank/period, logo, cron, backup/restore) | **338 / 338** pass, 0 failed, 0 skipped |
| Browser end-to-end (real Chrome, 17 tests) | **17 / 17** pass locally (Windows) **and on GitHub Actions (Linux)** |
| Dependency audit (`--audit-level=high`, production) | root and `functions/`: **0 high or critical** (a nested `zod` was pinned by an override). 6 *moderate* advisories remain in transitive Firebase/Google libraries; the CI gate does not fail on them |
| Load/concurrency (local laptop + emulator) | 8 tills racing for 5 pairs: exactly 5 sold, none oversold, every sale booked; 20 identical requests: 1 sale. Latency numbers and bottlenecks in `docs/STAGE5-TESTING.md`. **No capacity figure is claimed** |

## CI and deployment evidence
- GitHub Actions run `44150067721` on commit `91fb564`: **checks, emulator-tests and browser-tests all succeeded.** (The run was triggered by adding the branch to the workflow's push trigger.)
- Vercel built a **preview** of that commit successfully (`READY`; not production, not tested through its URL).
- **Firestore rules and indexes are NOT deployed.** The live project has 13 indexes; the repository defines 46 (33 missing). Rules compile (dry run) but the new rules are not live. The new code must not be deployed before indexes and rules (order in `docs/OPERATIONS.md`).
- **Vercel production variables present:** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `OWNER_EMAIL`, `VITE_FIREBASE_TARGET`. **Missing:** `BLOB_READ_WRITE_TOKEN`, `BLOB_PRIVATE_READ_WRITE_TOKEN`, `CRON_SECRET`.
- Live site: HTTPS, security headers, `/api/healthCheck` → Firestore reachable (checked in Stage 2).

## Backup and restore
Scripts exist (`npm run backup`, `npm run restore`) and the round trip is **tested on the emulator** (4 tests: every document and value comes back identical; existing data is never overwritten; damaged backups are refused; unsafe targets are refused). **No backup of the live project has been taken and no restore into it rehearsed** (needs your Google sign-in and approval). No scheduled backup and no uptime/error monitoring exist; both are manual setups listed in `docs/OPERATIONS.md`.

## Security findings and closure
| ID | Finding | Status |
|---|---|---|
| S-01 | Service-account key file on disk (OneDrive folder) | **OPEN, High — rotation unverified.** Only you can rotate it (steps in `docs/STAGE1-RECOVERY.md`) |
| S-02 | Vulnerable production dependencies (4 high) | **Closed** for high/critical (override + CI gate passes); 6 moderate remain |
| S-03 | 24 endpoints skipped the live disabled/revoked-account check | **Closed** (all 231+ endpoints tested; test fails without the fix) |
| S-04 | CNIC/HR documents and receipts public | **Closed in code**; needs the private Blob store before use. No sensitive public file is known to exist (HR and finance are not live) |
| S-05 | `registrationOpen` did nothing | **Closed** (setting removed; the real switch is a Firebase console toggle) |
| S-06 | Console hardening | **Partly open:** the web API key is **not restricted** (accepted from a foreign origin); password policy, authorized domains, sign-up switch and App Check **unverified/not enabled** |
| S-07 | Owner claim over Firebase's size limit | **Closed in code** (wildcard claim); takes effect only after deployment, then the Owner re-saves their role once |
| New | Duplicate endpoint names silently replaced each other | **Closed** (registry now refuses to start) |
| New | **The GitHub repository is public**, so the pushed branch (including the audit and security reports) is readable by anyone | **OPEN, Medium — your decision.** Consider making the repository private, or removing the audit/security files from the branch before it is merged or left public. Earlier history was already public. |

No critical or high finding is silently ignored; S-01 is the only high one still open.

## Completed vs remaining
**Completed and verified:** authentication and roles (Owner wildcard, staff, cashier, HR, employee); catalogue and stock per warehouse; online COD orders; walk-in POS (sale, split/part payment, receipts, register, **returns/refunds/exchanges**, offline sale and sync); double-entry accounting with reports that reconcile; income/expenses; purchasing and supplier ledgers; advanced inventory; CRM and loyalty; analytics (29 reports); HR and payroll; **bank reconciliation, period closing, store logo, daily scheduler**; private document storage (code); backup/restore tools; offline shell.
**Remaining / not done:** online payment gateway (no provider approved; COD only); HR statutory deductions and leave carry-over (needs your rates); partial POS returns are not subtracted in the *sales-document* reports (accounting reports are exact); quick Inventory-screen adjustments post no journal (documented opening-balance procedure instead); hot-document contention under bursts of simultaneous sales; full-ledger reports slow under load; purchasing/stock-count/payroll **not browser-tested**; hardware (printer, scanner) untested; no monitoring or running backup.

## Gates before go-live (all must be closed)
- **G1** Rotate the service-account key (S-01) and confirm to me.
- **G2** Your explicit approval to deploy, in this order: indexes (wait until all show *Enabled*) → rules → code. Rollback steps are in `docs/OPERATIONS.md`.
- **G3** In Vercel: connect the public Blob store, create and connect the private one (prefix `BLOB_PRIVATE`), set `CRON_SECRET`.
- **G4** Restrict the Firebase web API key; check password policy and authorized domains; decide on App Check.
- **G5** Take a first backup of the live database, rehearse a restore on the emulator, set up an uptime monitor.
- **G6** Make the repository private (or remove the audit files), then merge the branch.
- **After deploy:** the Owner re-saves their role and signs in again; post opening balances (`docs/STAGE4-BUSINESS.md`); walk the ten workflows once on the live site.

## Could not be verified
Live Firebase console settings and App Check; whether the old key was rotated; real email delivery (reset/verification); real printer and barcode scanner; Safari, Firefox and phones other than a Chrome viewport; the deployed preview's behaviour; production capacity and concurrency; Blob upload and download against real stores; the live data; a full offline working day; Vercel Cron actually firing (needs the secret and a deployment).
