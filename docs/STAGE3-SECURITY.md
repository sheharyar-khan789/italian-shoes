# Stage 3 — Security closure report (2026-11-17)

Not committed, pushed or deployed. Evidence for each line is the test or observation named.

## Closure table

| ID | Finding | Status | Evidence / what remains |
|---|---|---|---|
| S-03 | 24 endpoints (reports, HR self-service, checkout…) skipped the live "account disabled / sessions revoked" check | **Closed in code** | `functions/lib/callable.js`: any request carrying staff claims now gets the live check, whether the endpoint has a static permission or not. `tests/emulator/security.test.js` calls **all 231 endpoints** as a disabled, a revoked and a deleted staff account: every one is refused (403 / 401 / 401). Mutation check: with the new line removed the test fails. |
| — | Every staff endpoint enforces auth, role and permission | **Verified** | Same test file: all 231 endpoints refuse signed-out callers (401); every permission-protected endpoint refuses customers and staff without that permission (403); each default role (owner, inventory, order, content, cashier, POS manager, HR manager, payroll accountant, employee) reaches exactly the endpoints its permissions name, and no non-owner role holds an owner-only permission. The 24 endpoints that decide permission inside their handler are covered by their own module tests (HR, analytics, orders), not by this sweep. |
| S-04 | CNIC scans, HR documents, employee photos and receipts were public Blob files | **Closed in code; storage not yet connected** | Receipts, supplier papers, employee documents and photos now go to a **private** Blob store and are opened only through `/api/privateFile` (`api/privateFile.js`, `functions/services/privateFiles.js`). Rules: receipts → finance/accounting/purchasing readers; CNIC and documents → `hr.sensitive` only; photos → `hr.read`/`hr.write` or the employee's own photo; customers never; live session required; every opening of an HR document is written to the audit log. Records store a path (`hr/<uid>/<file>`), never a link; public links are refused by the schemas. Tests: security.test.js (path validation, schemas, all permission cases, own-photo rule, audit entry, headers, upload permissions). **Not verified:** a real upload and download against Vercel Blob (no private store exists yet) and the browser screens (Stage 5). |
| — | Files already public | **None known** | Production runs the old commit that has no HR or finance screens, and the Blob token is absent, so no sensitive file can exist there. Before go-live run in Firestore (read-only): `financeEntries` / `suppliers` / `purchaseOrders` attachments and `employeeDocs`, `employees.photoUrl`: any value starting with `https://` is a legacy public link. If found, migrate by copying into the private store, repoint the record, and only then delete the public copy. Nothing was deleted by me. |
| — | Removing a record does not delete its file | **Decision for you** | A removed employee document or attachment leaves the private file in the store (kept for audit and to avoid accidental loss of a CNIC copy). Tell me if you want deletion on removal. |
| S-05 | `registrationOpen` was never enforced | **Closed (setting removed)** | The toggle and its schema field are gone (`src/admin/views/settings.js`, `shared/schemas/commerce.js`) so the screen no longer promises something it cannot do. Customer sign-up goes straight to Firebase Auth from the browser; on the free plan the server cannot intercept it. The real switch is the Firebase console (below). |
| S-06 | Firebase / Google console hardening | **Partly verified; your action needed** | See the next section. |
| S-07 | Owner claim size | Closed in Stage 2 | — |
| S-01, S-02 | Service-account key; vulnerable dependencies | Open | Stage 1 plan; the zod/@vercel/blob override is still to do. |

## Firebase / Google console (what I could and could not check)
I could not read the Authentication settings (the CLI session could not be used for that API), so these are checked by behaviour or left to you.

| Item | Result |
|---|---|
| Email-enumeration protection | **Behaviour consistent with ON:** a sign-in with an address that does not exist returns the same generic `INVALID_LOGIN_CREDENTIALS` as a wrong password (probed once with a made-up `.invalid` address). Please confirm the toggle in Authentication → Settings. |
| **Web API key restriction** | **NOT restricted (finding, medium).** The key in `src/app/firebase-config.js` was accepted from a foreign origin and with no origin at all. The key is public by design, but unrestricted it can be used to hit your quotas from anywhere. **You:** Google Cloud Console → APIs & Services → Credentials → the browser key → *Application restrictions: Websites* → `https://italian-shoes.vercel.app/*` (add your own domain later and `http://localhost:5181/*` for development) → *API restrictions* → Identity Toolkit API, Token Service API, Firebase Installations API, Cloud Firestore API. Then tell me and I will re-probe. |
| Password policy | Not readable. **You:** Authentication → Settings → Password policy (suggest minimum 8, require upper/lower case and a number). The site's own form already requires a password of reasonable length; the console policy is the server-side enforcement. |
| Authorized domains | Not readable. **You:** Authentication → Settings → Authorized domains: keep only `italian-shoes.vercel.app` (and your own domain later); remove anything unused. |
| Sign-up on/off | **You:** Authentication → Settings → User actions → *Enable create (sign-up)* is the real "customers can register" switch. |
| App Check | **Not enabled** (`VITE_APPCHECK_SITE_KEY` is empty; `SECURITY.md` describes the setup with reCAPTCHA Enterprise and the CSP change). Optional hardening: turn on in *monitor* mode first, enforce later. |

## What changed in code (for the commit plan)
`functions/lib/callable.js` · `functions/services/privateFiles.js` (new) · `functions/services/images.js` · `api/privateFile.js` (new) · `api/blobUpload.js` · `shared/privateFiles.js` (new) · `shared/finance.js` · `shared/schemas/hr.js` · `shared/schemas/commerce.js` · `src/admin/privateFileUi.js` (new) · `src/admin/financeUi.js` · `src/admin/hrUi.js` · `src/admin/views/{financeEntries,purchaseOrders,suppliers,hrEmployees,hrSelf,settings}.js` · tests: `tests/emulator/security.test.js` (new, 11 tests; full emulator suite 306/306 pass, 0 fail, 0 skipped), existing finance/HR/purchasing tests moved from public links to private paths · `.env.example` · `docs/OPERATIONS.md`.

## New server variable
`BLOB_PRIVATE_READ_WRITE_TOKEN` — a second Vercel Blob store created with **private** access, connected with prefix `BLOB_PRIVATE`. Until it exists, uploads of receipts, documents and photos answer a clear "private file storage isn't connected" message (HTTP 503); nothing falls back to a public store.
