# Operations: deploy, roll back, back up, restore, monitor

Written in Stage 2 (2026-11-17). This replaces the deployment parts of `docs/GO-LIVE.md`, which stopped at an early phase and still mentions billing. **Nothing in this file has been executed against the live project except the read-only checks listed in section 1.**

## 1. What was verified on 2026-11-17 (read-only)

| Item | Result | How |
|---|---|---|
| Firebase project | `italianshoes` (`.firebaserc`); the site's server reads `FIREBASE_PROJECT_ID` | files + Vercel env list |
| Live site | `https://italian-shoes.vercel.app` → 200; `/api/healthCheck` → `{"ok":true,"firestore":"reachable"}` | HTTP GET |
| HTTPS and headers | HSTS (2 years), CSP, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP all present; `/admin` also `noindex` | HTTP response headers |
| Deployed code | Production = commit `92d0d61` (the old GitHub `main`); none of Phases 5–13 is live | Vercel deployment metadata |
| Vercel env names (Production) | present: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `OWNER_EMAIL` (all sensitive, values not read); `VITE_FIREBASE_TARGET=production` (Production + Preview) | Vercel API |
| **`BLOB_PRIVATE_READ_WRITE_TOKEN`** (new in Stage 3) | **Not present, and needed before receipts, supplier papers or employee documents/photos can be uploaded or opened.** Create a second Blob store with *private* access and connect it to the project with variable prefix `BLOB_PRIVATE` (Vercel → Storage). The public store (`BLOB_READ_WRITE_TOKEN`) stays for product photos and the logo. If your plan allows only one store, tell me before deploying. | Vercel API |
| **`BLOB_READ_WRITE_TOKEN`** | **NOT in the project's variable list.** Product, logo and document uploads need it. Check Vercel → Project → Storage: if no Blob store is connected, create/connect one (free) so the variable is added. | Vercel API (needs your confirmation in the dashboard) |
| Preview deployments | have no `FIREBASE_*` variables (Production only), so a preview site cannot reach the database; test on the emulator or after production deploy | Vercel API |
| Live Firestore indexes | **13 exist; the file now defines 46, so 33 are missing live (31 already in the file + the 2 added in this stage).** Live has nothing the file lacks, so deploying is purely additive | `firebase firestore:indexes` (read-only) vs `firestore.indexes.json` |
| Firestore rules | `firestore.rules` compiles (`firebase deploy --only firestore:rules --dry-run`). Live rules were not downloaded for comparison | CLI dry run |
| Firebase CLI | logged in on this PC (read access used only) | `firebase login:list` |

## 2. Indexes (static analysis, fixed in `firestore.indexes.json`)
The emulator does not enforce composite indexes, so a missing one only fails on the live database. I scanned every query in `functions/` that combines an equality filter with a range or ordering on another field:
- Two were missing from the file and have been **added**: `recurringExpenses (isActive, nextDate)` and `cashCounts (accountCode, date)`. Without them "run recurring expenses" and the cash-reconciliation report would fail live with `FAILED_PRECONDITION`.
- All others are covered by existing entries. Queries that equal-match only (e.g. `leaveRequests` by employee and status) need no composite index.
- Limit: this is pattern analysis, not proof. Queries assembled from variables across several lines may have been missed. After deploy, the browser console / Vercel logs show a link to create any index still missing; Stage 5 browser tests will exercise each report.

## 3. Owner permissions (verified)
- Claims are `{staff, roles, perms}`. Firebase allows 1,000 characters; the old Owner list was 1,219. Owner now carries `["*"]` (46 characters); the server, the rules (`'*' in perms`) and the browser expand it to all 71 permissions.
- Largest default role (inventory_manager) is 264 characters; every seeded role is under 300. A custom role mix over ~950 characters is refused with a clear message (`functions/services/staff.js:107`), not silently broken.
- Tests: `staff.test.js` and `rules.test.js` (Owner claim `["*"]`, wildcard reaches every rule, non-owners do not).
- After the new code goes live, the existing Owner's token still holds the old list. The Owner should open **Staff & Roles**, save their own Owner role once, then sign out and in. There is no server rule that blocks editing your own roles; if the screen refuses, tell me and I will add a safe one-time refresh.

## 4. Safe deployment order (needs your explicit approval; not executed)
1. **Code on GitHub, CI green** (Stage 1 commit plan, then PR). Do not skip: production currently runs commit `92d0d61`.
2. **Back up** the live database: `npm run backup -- --out "D:\Backups\italianshoes-<date>"` (section 5).
3. **Indexes first**: `npx firebase deploy --only firestore:indexes --project italianshoes`. Wait until every index shows *Enabled* in Firebase console → Firestore → Indexes. Additive only.
4. **Rules second**: `npx firebase deploy --only firestore:rules --project italianshoes`. The new rules accept both the old permission lists and `"*"`, so existing sessions keep working.
5. **Create/confirm the Blob store** and the four server variables (section 1).
6. **Code last**: merge to `main`; Vercel builds and promotes. Check `/api/healthCheck`, sign in as Owner, do the Owner refresh (section 3), open Dashboard, Staff & Roles, one report.
7. Keep the previous deployment available for rollback.

## 5. Backup and restore
**What exists:** `scripts/backup-firestore.mjs` (read-only export of every collection and sub-collection with SHA-256 checksums) and `scripts/restore-firestore.mjs`. Firebase's own scheduled backups and point-in-time recovery are not available on the current free plan, so they are not used.
- **Credentials without a key file:** on your own computer run `gcloud auth application-default login` with an account that can read Firestore, then set `FIREBASE_PROJECT_ID=italianshoes`. Do not create another key file.
- **Back up:** `npm run backup -- --out "<new folder>"`. It refuses any folder inside the project or inside OneDrive. The backup contains customer, CNIC, salary and financial data: store it on an encrypted drive.
- **Schedule:** run it **weekly** and before every deployment or migration. It is manual; nothing runs it automatically. Reads use the free daily quota (about one read per document).
- **Not included:** Firebase Auth accounts (people reset their password if lost) and Vercel Blob files (images and documents; copy them separately if needed).
- **Restore:** rehearse on the emulator first (`npm run restore -- --from <folder>` with `FIRESTORE_EMULATOR_HOST` set). A real restore needs `--production --confirm-project italianshoes` and the owner's decision. It never overwrites existing documents unless `--overwrite` is given, and it checks the checksums before writing anything.
- **Tested:** `tests/emulator/backup.test.js` (4 tests, passing) exports, wipes, restores and compares every document (paging over 400 documents, sub-collections, parent-less documents, timestamps, geo points, references, bytes, unicode, a field that imitates an internal tag), proves existing data is kept, proves a tampered or missing file is detected, and proves the CLI refuses unsafe targets.
- **Not tested:** a real export from the live project and a restore into it (needs your Google sign-in and your approval). Do one dry rehearsal: export live, restore into the emulator, compare totals with `manifest.json`.
- Known JSON limit: a whole-number decimal (5.0) restores as the integer 5; the app stores money as integer paisa.

## 6. Rollback
- **Site/server code:** Vercel → Deployments → pick the previous deployment → **Promote to Production** (instant).
- **Rules:** `git checkout <old-commit> -- firestore.rules` then `npx firebase deploy --only firestore:rules`.
- **Indexes:** leaving extra indexes is harmless; never delete one in a hurry.
- **Data:** only through a backup restore (section 5). Accounting data is never edited, only reversed.
- **Owner claim:** if someone is locked out, sign out/in refreshes the token; the Owner role cannot be removed by editing JSON by hand.

## 7. Monitoring and alerts (not set up; I cannot create accounts or alerts for you)
Free options, in order of value:
1. **Uptime check** on `https://italian-shoes.vercel.app/api/healthCheck` with an email alert (any free uptime monitor; the endpoint returns `ok:true` only when Firestore is reachable).
2. **Vercel**: Project → Settings → Notifications (failed deployments), and check Logs weekly for 5xx.
3. **Firebase console**: Usage tab weekly against the free quota (50,000 reads and 20,000 writes per day). Exports and large reports consume reads.
4. The server writes structured logs (`functions/lib/logger.js`); there is no error-tracking service. Add one only if you want it.

## 8. Open items for you
- Confirm/connect the Blob store (`BLOB_READ_WRITE_TOKEN` missing).
- Key rotation (Stage 1, section 6).
- Approve the deployment order in section 4 when the code is on GitHub and CI is green.
- Set up the uptime monitor and the weekly backup habit.
