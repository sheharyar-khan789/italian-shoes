# Italian Shoes Management System — Production Readiness Audit

**Audit type:** audit only. No application code, schema, setting or data was changed; nothing was committed, pushed or deployed. Only the report files listed at the end were created.
**Date of audit:** 2026-11-17 · **Repository:** `Footwear Hero` (remote `sheharyar-khan789/italian-shoes`, branch `main`)
**What was executed:** read-only inspection (git, grep, registry enumeration, `npm audit`), `eslint`, `tsc`, the production build, the 185 unit tests, the Firestore emulator test suite (see `TEST_RESULTS.md`), and manual browser checks against **throw-away emulator data only** (no production access of any kind).

> **Evidence rule used throughout:** a feature is called *verified* only where an automated test or an observed run exercised it. A screen that exists is not counted as working. Everything I could not verify is listed in section 9 of this summary and in every section where it matters.

---

## 1. Executive Summary

The server side is strong and unusually well tested: 231 authenticated, rate-limited, schema-validated endpoints; deny-by-default Firestore rules with server-only writes; a double-entry accounting engine whose reports reconcile with the books in tests; idempotent money operations; and hand-checked payroll and analytics figures. There is **no fake data in the production code paths**: no demo users, no hard-coded dashboard numbers, no mocked APIs, no simulated payments.

The system is **not yet ready to run a real business**, for reasons that are mostly about *delivery and operations*, not about missing code:

1. **Almost everything built after the online shop is not in version control** — 173 untracked and 44 modified files. Only 15 of 49 services, 16 of 73 admin screens and 11 of 23 emulator test files are committed. The accounting engine, POS, finance, purchasing, advanced inventory, CRM, analytics and HR exist only in one OneDrive folder. CI has never run on them and production cannot contain them.
2. **A live service-account private key file is on disk** in that same OneDrive folder (git-ignored and never committed, but rotation was never confirmed).
3. **Production dependencies carry 4 high vulnerabilities** (including `zod`, which validates every request) — the repository's own CI audit step would fail.
4. **No backups, monitoring or restore plan exist.**
5. **No browser end-to-end tests exist**; the 73 admin screens were only exercised by hand.
6. **Functional gaps:** no returns/exchanges for POS sales; offline POS cannot reload while offline; recurring expenses and report schedules are not automatic; a few settings are saved but not connected.
7. A **real defect found in this audit:** the Owner's sign-in claim had outgrown Firebase's 1,000-character limit (fixed in the working copy only), and 25 endpoints skip the live "account disabled / sessions revoked" check.

**Verdict: PARTIALLY READY** (details in section 16 of this report and the scoring below).

## 2. Overall Website Completion Percentage — **Implemented ≈ 83 %**
## 3. Verified Working Percentage — **≈ 68 %**
## 4. Production Readiness Percentage — **≈ 46 %**

| Dimension | Weight | Implemented | Verified working | Production-ready |
|---|---:|---:|---:|---:|
| Frontend | 10 | 85 | 40 | 30 |
| Backend | 12 | 90 | 85 | 55 |
| Database integration | 10 | 95 | 85 | 55 |
| Real functionality (no dummy) | 8 | 93 | 70 | 60 |
| Business workflows | 20 | 70 | 55 | 35 |
| Accounting integration | 10 | 90 | 85 | 60 |
| Security | 15 | 80 | 65 | 40 |
| Automated testing | 8 | 72 | 70 | 45 |
| Reporting | 7 | 90 | 70 | 55 |
| **Weighted overall** | 100 | **83.3** | **68.1** | **46.4** |

*Method.* **Implemented** = code and screens exist and are connected. **Verified working** = an automated test or an observed run exercised it (unverified features never score 100). **Production-ready** = verified *and* committed, deployable, safe, operable (backups, monitoring), with no known critical gap. Business workflows carry the largest weight because the goal is a working business. The scores are judgement calls on the evidence in this report, not a measurement; the three columns are kept apart on purpose — a high implemented figure with a much lower production-ready figure is exactly the situation here.

## 5. Complete Technology Architecture

| Layer | What is actually used (evidence) |
|---|---|
| Website | Vanilla JavaScript, Vite 6 multi-page build: `index.html` (shop) and `admin.html` (admin). ~36,000 lines of source in `src/ functions/ shared/ api/`; 9,850 lines of tests. No UI framework. Three.js for a placeholder 3D hero. |
| Server | Vercel serverless: `api/call.js` (all endpoints, `/api/<name>` → `handleApi`) and `api/blobUpload.js`. Business logic in `functions/services/*` (49 files), endpoints in `functions/callable/*` (231 endpoints), registry `functions/registry.js`. Hobby-plan friendly (2 functions). |
| Auth | Firebase Authentication (email/password); staff roles → custom claims `{staff, roles, perms}` set by `services/staff.js`; owner claim by `OWNER_EMAIL`. **Owner perms are now the wildcard claim `"*"`** (uncommitted change). |
| Database | Cloud Firestore (project `italianshoes`, region documented as asia-south1). 102 rule blocks, 46 composite indexes in the repository (+5 newer ones uncommitted). |
| Files | Vercel Blob (public objects) — **there is no Firebase Storage and no `storage.rules`** although `docs/ARCHITECTURE.md` mentions one. Images processed with `sharp`. |
| Shared code | `shared/*` (money in integer paisa, permissions, schemas with Zod 4, accounting/HR/CRM/analytics rules, `xlsx.js` writer) copied to `functions/shared` by `functions/scripts/sync-shared.mjs` (generated, git-ignored). |
| Hosting/config | `vercel.json` (SPA rewrites, CSP and security headers), `firebase.json` (hosting headers only), `.firebaserc` project `italianshoes`. |
| CI | `.github/workflows/ci.yml`: secret scan, lint, typecheck, unit tests, build, `npm audit --audit-level=high`, and an emulator job. Dependabot weekly. |
| Background jobs | **None.** No cron, scheduler or queue (`vercel.json` has no crons). |
| External services | Firebase Auth/Firestore, Vercel Blob. WhatsApp is only a `wa.me` link. No payment gateway, SMS, email provider, analytics or error tracker. |

## 6. Complete Module Inventory

**Storefront (10 view files):** home, shop, product, cart, checkout, search, account (profile, addresses, orders, wishlist), info pages, 404.
**Admin (70 registered modules in `src/admin/modules.js`, all loaded and reachable; none marked "soon"):** Overview · Products · Categories & Sizes · Orders · Sales · Sales Report · Payments · Shipping · Customers · Coupons · Reviews · Analytics & Reports · Website Content · Inventory (Stock levels, Adjustments, Counts, Reports, Dashboard, Warehouses, Transfers) · Purchasing (Suppliers, POs, Goods Received, Supplier Payments, Returns, Ledger, Dashboard, Reports) · POS (Point of Sale, Offline Sync, Register Sessions, POS Reports) · Finance (Dashboard, Income, Expenses, Cash & Bank, Reports, Settings) · Accounting (Overview, Chart, Journals, Ledger, Trial Balance, Receivables, Payables, Cash & Bank, Reports, Opening Balances) · CRM (Dashboard, Customers, Reports, Settings) · Business Dashboard / Report Builder / Financial Analytics / Report Inbox · HR (Dashboard, Employees, Attendance, Leave, Payroll, Advances & Loans, Reports, Settings, My HR) · Staff & Roles · Notifications · Activity Log · Store Settings.
**Endpoints by file:** hr 57 · inventory 21 · finance 20 · accounting 20 · crm 19 · pos 16 · purchasing 14 · engage 12 · analytics 12 · catalog 11 · warehouses 8 · payments 5 · orders 5 · sales 3 · coupons 2 · plus staff/settings (total 231).
**Permissions:** 71, grouped in 60 buckets; roles: owner, inventory_manager, order_manager, content_manager (seeded), cashier/pos_manager (created on demand), hr_manager/payroll_accountant/employee (created on demand).
**Unused / abandoned code:** a scan found **no** orphaned admin view, service or shared module (every file is imported somewhere). Placeholder-only code: the 3D sneaker model and sample-picture cards on the storefront (section 9).

## 7. Complete Feature Inventory & 8. Feature-by-Feature Verification

The full table (66 features, each with evidence, how it was verified and the gap) is in **`FEATURE_VERIFICATION.csv`**. Summary of verdicts:

| Verdict | Count |
|---|---:|
| Verified (automated and/or observed) | 41 |
| Verified at server level only (no browser run) | 12 |
| Partially verified / partial | 9 |
| Not implemented / missing | 4 (online gateways, POS returns/exchanges, bank reconciliation/closing, scheduled jobs/backups) |

## 9. Real vs Dummy Functionality Analysis

I searched every production file for TODO/FIXME/MOCK/DUMMY/SAMPLE/PLACEHOLDER/HARDCODED/DEMO, `console.log`, `setTimeout` fake operations, static responses, hard-coded credentials/IDs, simulated payments and empty handlers.

| Class | Result |
|---|---|
| Test-only dummy data | `tests/**` use fake tokens, fake product names and `demo-italianshoes`. Correctly confined to tests. |
| Development-only | `src/app/firebase-config.js` — the emulator is chosen only when `import.meta.env.DEV` is true; **production builds never connect to the emulator** (`src/app/firebase.js:11`). |
| Production-accessible dummy data | **Low:** `src/ui/components.js:161-177` shows "Sample picture / Coming soon" cards and `src/scene.js:5` a placeholder 3D sneaker, only while the catalogue is empty (both labelled). |
| Hard-coded business logic | Starting values only, all editable: `CRM_DEFAULTS`, `HR_DEFAULTS` (leave 14/8/10 days), alert thresholds. Fixed assumptions: Pakistan time (+5, no DST), default 6-day week when an employee has no shift (`functions/services/hrAttendance.js`, `hrPayroll.js`). |
| Mocked integrations | None. Payment gateways are explicitly not connected (`shared/paymentGateways.js`) and the UI does not pretend otherwise. |
| Fake functionality | None found: no hard-coded dashboard statistic, no static chart data, no simulated success. Charts are drawn only from data the server returns (`src/admin/ui/charts.js`). |
| Real functionality | Everything else. |
| Settings that look functional but are not | `registrationOpen` (never enforced), `facebook` (never shown), store logo (no way to set; code reads `logoUrl`). See B-05, B-06, S-05. |
| Stale statements | `functions/services/salesReports.js:86` ("the POS is not built"), `src/admin/views/settings.js:96` ("Logo upload arrives…in Phase 5"), `docs/ARCHITECTURE.md` (storage.rules, "services planned"), `docs/GO-LIVE.md` (frozen at Phase 10, recommends Blaze). |

## 10. Demo Account and Credential Findings
- **No demo user, test user, hard-coded administrator or bypass exists in application code.** Admin access comes only from the real Firebase user whose verified email matches the server variable `OWNER_EMAIL` (`functions/services/staff.js` `claimOwner`), once.
- **Real credential on disk:** `italianshoes-firebase-adminsdk-fbsvc-d8d1b2abaf.json` (service account, project `italianshoes`). Git-ignored (`.gitignore:8`), never in git history (empty `git log --all -- file`), but present in an OneDrive-synced folder; `docs/GO-LIVE.md` says it must be rotated — no evidence it was. **S-01, High.**
- The Firebase web API key and app id in `src/app/firebase-config.js` are public by design; restriction to your domains cannot be verified here.
- Test credentials used for the browser checks live outside the repository (session scratch space) and only in the emulator.

## 11. Hardcoded Data Findings
`src/config.js` `STORE_DEFAULTS` (name, phone 0342-7530608, address, Instagram) — offered as defaults in the settings form only until the owner saves (Low). `CITY_SUGGESTIONS` — checkout suggestions, not data. No hard-coded balances, customers, suppliers, employees, products or transactions in production code.

## 12. Non-Functional Buttons and Pages
A heuristic scan of all 264 distinct `data-*` button hooks in `src/**` found **0 dead buttons** (3 flagged hooks were handled elsewhere); no `href="#"`, no empty click handlers, no "coming soon" admin modules. Observed-in-browser behaviour: sign-in, CRM, POS, analytics (29 reports), HR happy path all worked. *Limits:* this is a static heuristic plus partial manual runs, not a click-through of every control. Missing capabilities (not dead buttons): POS return/exchange (B-01), logo upload (B-05).

## 13. Missing Backend Integrations
Online payment gateways (B-13); a scheduler for recurring expenses, loyalty expiry and report schedules (B-03, B-04); backup/monitoring services (C-02); bank-statement reconciliation (B-14); messaging provider (B-12); statutory payroll deductions (B-11). All 231 endpoints that exist have frontends or are internal; no orphaned endpoint was found.

## 14. Database and Data Integrity Audit
- Rules: deny-by-default, writes server-only everywhere (102 blocks); employee/pay/attendance/payroll, CRM keys, analytics caches have `read, write: if false`. Verified by 33 rule tests including these collections and the `"*"` claim.
- Integrity design: deterministic document ids for idempotency (`earn__{saleId}`, `salarypay__…`, `attendance/{emp__date}`); counters inside transactions; unique keys for phone/email/CNIC; reads-before-writes transactions; money as integer paisa.
- Risks: unbounded-read caps (B-09); composite indexes must be deployed before the new screens work (C-01); analytics cache stamps rely on `updatedAt` (a direct edit without it is not noticed — services always set it).

## 15. Accounting Accuracy Audit
Verified by tests (accounting 21 + unit 10, analytics reconciliation, HR, purchasing): every automatic journal balances; ids derive from the source so a retry cannot double-post; posted journals are never edited (reversal journals only); an accounting failure on an HR change rolls the whole change back; Executive/Analytics revenue, COGS, gross/net profit, cash, bank, receivable and payable **equal** the accounting engine's own P&L/balances; monthly profit adds up to the P&L; balance sheet balances; trial balance debits = credits; cash flow reconciles; payroll accrual `Dr Salaries = Cr Payable + Advances + Deductions` always balances; paying, voiding, reversing and re-approving leave all accounts at the expected balances. **Caveat:** inventory *book* value and *physical valuation* differ until opening balances are posted (B-10); I observed −Rs 34,200 vs Rs 174,600 on seeded data. No bank reconciliation or period close exists (B-14).

## 16. Inventory Accuracy Audit
Stock is changed only inside transactions per warehouse (`functions/services/inventory.js`); tests cover no negative stock, simultaneous last-pair sales (exactly one succeeds), concurrent receiving never over-receives, offline sale never takes stock below zero or from another warehouse, transfers/adjustments/counts with approval. Not verified: behaviour under real multi-user load on the live service (T-02).

## 17. End-to-End Workflow Results
*"Server-verified" = proven by an automated emulator test that runs the whole chain through the real endpoints; "browser" = I observed it in the browser on emulator data. No workflow was run on the live site.*

| # | Workflow | Result |
|---|---|---|
| 1 | Login → auth → dashboard → permissions | **Works** (server + browser). Revocation gap on 25 endpoints (S-03). Live Firebase settings unverified. |
| 2 | Product → variants → stock → availability → POS sale → stock deduction | **Works** server-verified; browser: product seeded, POS search/add/checkout observed. Product *creation form* not run in this audit. |
| 3 | Supplier → PO → receiving → stock ↑ → payable → payment → journals | **Works** server-verified (purchasing 26 tests). Browser not run in this audit. |
| 4 | Customer → POS purchase → payment → receipt → history → loyalty | **Works** (server + browser: sale with discount, 135 points earned, profile showed purchase). Receipt printed to a dialog only; printer not tested. |
| 5 | Sale → part payment → balance → customer payment → ledger | **Works** server-verified (POS part payment, `posRecordPayment`, receivable ageing reconciles). Browser not run. |
| 6 | Expense → cash/bank → journal → financial dashboard | **Works** server-verified (finance tests). Browser not run in this audit. |
| 7 | Stock count → discrepancy → approval → adjustment → accounting | **Works** server-verified (inventoryAdvanced tests). Browser not run. |
| 8 | Offline sale → local persistence → reconnect → sync → stock → journal | **Partially verified:** server sync, idempotency, conflicts and accounting verified; the queue/engine logic by unit tests with a fake store. **Not run in a real browser offline cycle.** Cannot reload offline (no service worker). |
| 9 | Employee → attendance → leave → payroll → payslip → payment → journal | **Works** (server hand-checked figures + browser happy path: bulk attendance, leave approval, generate, approve, pay, payslip). Advances/commission verified server-only. |
| 10 | Transactions → reports → dashboard → statement reconciliation | **Works** server-verified: executive dashboard, 29 reports and statements reconcile to the journals in tests; reports rendered in a browser. |
| — | POS return / exchange | **Not implemented.** |

## 18. Security Audit
Full list with evidence in **`SECURITY_FINDINGS.csv`**. Highlights:
- **Critical:** none confirmed.
- **High:** S-01 service-account key on disk (rotation unverified); S-02 production dependency vulnerabilities (zod DoS and @vercel/blob chain); S-04 CNIC scans and receipts stored as public blobs.
- **Medium:** S-03 revoked/disabled staff keep access up to an hour on 25 endpoints; S-05 `registrationOpen` not enforced; S-06 console hardening/App Check unverified; S-07 Owner claim over the Firebase size limit (fixed only in the uncommitted working copy).
- **Low/Info:** S-08 export is an audit control not a data control; S-09 CSP `unsafe-inline` styles; S-10/S-11 rules and endpoint hygiene verified.
- Checked and found good: deny-by-default rules, server-only writes, all endpoints authenticated + rate-limited + validated, error messages hide internals, CSV/Excel formula injection neutralised, `script-src 'self'`, HTML escaping (no unescaped user field found by pattern scan; not a proof), idempotency on money operations, session revocation on permission endpoints, file upload type/size/path rules, audit log writes for sensitive actions.
- Not tested (by instruction): any active exploitation, penetration testing, brute-force or load against a live system; CSRF/IDOR beyond code and rule/test review (all calls use bearer tokens, not cookies, so classic CSRF does not apply).

## 19. Performance and Scalability Audit
Reads are bounded (5,000 sales per report, 2,000 customers, 150 payroll employees, 40 salary payments per action) with clear errors beyond (B-09). Reports run one bounded query per source; lists page; analytics has a stamp-invalidated cache; Firestore `getAll` batches avoid N+1. The `build` emits a >500 kB chunk warning. A 1,200-sale analytics run completed within seconds in the emulator. **No load test was run, so no concurrent-user claim is made** (T-02). The emulator suite itself became very slow during this audit (individual tests 25–55 s versus 1–13 s earlier) — likely local machine/emulator load, not evidence about production.

## 20. Automated Test Results
See **`TEST_RESULTS.md`**. In short: lint clean; typecheck clean; build succeeds (chunk-size warning); unit tests 185/185; emulator suite — see that file for the final state of the run.

## 21. Phase 1–13 Completion Analysis
Full table in **`PHASE_COMPLETION.csv`**. Summary (implemented / verified / production-ready %):

| Phase | Area | Impl. | Verified | Ready |
|---|---|---:|---:|---:|
| 1 | Foundation & architecture | 90 | 80 | 60 |
| 2 | Authentication & users | 85 | 70 | 50 |
| 3 | Product & inventory foundation | 90 | 75 | 60 |
| 4 | Sales & business operations | 85 | 75 | 55 |
| 5 | Double-entry accounting | 90 | 85 | 60 |
| 6 | Physical shop POS | 85 | 75 | 50 |
| 7 | Offline POS & sync | 75 | 60 | 35 |
| 8 | Income, expenses, cash | 85 | 75 | 55 |
| 9 | Purchase & supplier | 90 | 80 | 60 |
| 10 | Advanced inventory | 85 | 75 | 55 |
| 11 | CRM & loyalty | 85 | 80 | 55 |
| 12 | Analytics & BI | 80 | 75 | 50 |
| 13 | HR & payroll | 80 | 72 | 45 |

Phases 1–4 were established from the repository (the committed code and `docs/PHASE-1-AUDIT-AND-PLAN.md`), not from the phase titles.

## 22. Missing Features
POS returns/exchanges (B-01) · online payment gateways (B-13) · bank reconciliation and period closing (B-14) · automatic scheduler (B-03/B-04) · backups/monitoring (C-02) · offline app shell (B-02) · logo upload (B-05) · camera barcode scanning · messaging provider (B-12) · statutory payroll deductions and leave proration (B-11) · browser E2E tests (T-01).

## 23. Broken Features
No feature was found *broken* in the paths exercised. Settings that do nothing: `registrationOpen`, `facebook` (S-05, B-06). Reports/exports that cannot show a logo (B-05).

## 24. Critical Bugs / Blockers (P0)
O-01 uncommitted work · S-01 key on disk · S-02 vulnerable dependencies · C-01 rules/indexes/code deploy ordering · (S-07 must travel with the deploy).

## 25. High-Priority Issues (P1)
S-03 live-revocation gap · S-04 public sensitive documents · S-06 console/App Check · S-07 owner claim · B-01 POS returns · C-02 backups/monitoring · T-01 no browser E2E.

## 26. Medium- and Low-Priority Issues (P2/P3)
S-05, S-08, S-09, B-02 … B-14, T-02, T-03, C-03, C-04 — see `AUDIT_FINDINGS.csv` for every row with evidence, affected files, dependencies, fix, complexity and the verification test.

## 27. Production Configuration Issues
Rules and indexes (46 + 5 new) are not deployed with the uncommitted code (C-01); Firebase console items pending per `docs/GO-LIVE.md` (password policy, enumeration protection, authorised domains, API-key restriction, App Check); `OWNER_EMAIL`, `FIREBASE_*` and `BLOB_READ_WRITE_TOKEN` Vercel variables not verifiable; project folder inside OneDrive (C-03).

## 28. Backup and Recovery Readiness
**Not ready.** No Firestore export schedule, no point-in-time recovery plan, no restore drill, no documented procedure (searched all docs). The source code itself is not safely backed up (O-01). Rollback: `docs/GO-LIVE.md` has a rollback section for the site; data rollback does not exist.

## 29. Complete Remaining Work List
Every row of `AUDIT_FINDINGS.csv` (33 items) plus the checklist in `PRODUCTION_READINESS_CHECKLIST.md`.

## 30. Recommended Fixing Roadmap

**P0 — before anything else (order matters)**
1. **O-01** Commit the work on a branch in logical groups, push, let CI run (nothing else is safe until the code exists off this machine).
2. **S-01** Revoke the service-account key; create a new one only in Vercel; delete the local file; move the repo out of OneDrive (C-03).
3. **S-02** Upgrade `zod` and `@vercel/blob` (and refresh transitive deps) → re-run all tests → CI green. *Depends on 1.*
4. **S-07 + C-01** Plan one deployment: deploy rules + indexes first (wait for "Enabled"), then code including the owner-claim change; re-save the Owner roles. *Depends on 1–3.*
5. **C-02** Start Firestore exports and uptime/error alerts; document and rehearse a restore.

**P1**
6. **S-03** Run the live-session check for every staff call. 7. **S-04** Make sensitive documents private (server-mediated download) and delete blobs with their records. 8. **S-06/C-04** Complete the Firebase/Google console checklist with evidence. 9. **T-01** Add browser E2E for sign-in, product → POS sale → stock, purchase receipt, expense, payroll — in CI. 10. **B-01** Build POS returns/exchanges. 11. **B-10** Add "post opening balances" as a mandatory go-live step.

**P2**
12. **B-03/B-04** One scheduler for recurring expenses, loyalty expiry, report schedules. 13. **B-02** Offline app shell + real offline test. 14. **S-05** Enforce or remove `registrationOpen`. 15. **T-02** Load test against a staging project. 16. **B-05** Logo upload. 17. **B-13** Payment gateway if online payment is wanted. 18. **B-09** Aggregates/counters before the data grows.

**P3**
19. **B-11/B-12/B-14** HR statutory deductions, messaging provider, bank reconciliation/closing. 20. **B-06/B-07/B-08/T-03/S-08/S-09** wording, docs, placeholders, date-independent tests.

## What could not be independently verified
The live Firebase project (console settings, password policy, enumeration protection, App Check, API-key restrictions, indexes actually enabled, deployed rules); the live Vercel deployment and its environment variables; real email delivery (verification/reset); real device barcode scanners and printers; a true offline browser cycle; behaviour under real concurrency and load; browser behaviour for most admin screens and the whole customer checkout; time-zone behaviour in production; the content of production data (none was accessed); whether the exposed service-account key was already rotated.

## Verdict — **PARTIALLY READY**
Core business logic is correct and well tested at the server level, and nothing in the production code is fake. But it cannot be called ready for real customers and employees until the P0 items are done — the code is not in version control, a live credential is on disk, known high-severity dependency issues are unpatched, there are no backups or monitoring, and the browser-level workflows have not been verified by automation. Reaching **CONDITIONALLY READY** needs P0 + the P1 security items + a browser walkthrough of the ten workflows on a staging project.

---
### Files produced by this audit
`AUDIT_REPORT.md` · `AUDIT_REPORT.html` · `AUDIT_FINDINGS.csv` · `FEATURE_VERIFICATION.csv` · `SECURITY_FINDINGS.csv` · `PHASE_COMPLETION.csv` · `TEST_RESULTS.md` · `PRODUCTION_READINESS_CHECKLIST.md`
