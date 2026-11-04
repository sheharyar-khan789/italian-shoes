# Architecture

Italian Shoes e-commerce platform. Vite + vanilla JavaScript in the browser, Firebase on the server
(Auth, Firestore, Cloud Functions, Storage, Hosting).

> **Status (end of Phase 2):** the Firebase foundation is in place — configuration, security rules,
> shared validation and money code, the Cloud Functions skeleton, migrations and tests. The
> storefront still runs on its old demo catalogue until Phase 9. Items marked *(planned)* do not
> exist yet; see `docs/PHASE-1-AUDIT-AND-PLAN.md` for when each arrives.

---

## 1. Folder structure

| Path | What lives here |
| --- | --- |
| `index.html` | Storefront entry page. |
| `src/` | Browser code. |
| `src/app/` | Router, app state, and **`firebase.js`** (lazy SDK setup; points at the emulators in development). `firebase-config.js` holds the public web config. |
| `src/views/`, `src/ui/`, `src/lib/` | Current storefront pages, components and display logic. Moved into `src/storefront/` when rewired *(Phase 9)*. |
| `src/scene.js`, `src/ui/hero.js` | The approved 3D hero. **Do not change the design.** |
| `src/admin/` *(planned, Phase 4)* | Admin dashboard, built as a separate entry (`admin.html`) so customers never download admin code. |
| `shared/` | Code used by **both** the browser and Cloud Functions. One copy of every business rule. |
| `shared/money.js` | Integer-paisa money helpers and PKR formatting. |
| `shared/phone.js` | Pakistani mobile number validation and normalisation. |
| `shared/orderStatus.js` | Allowed order and payment status changes. |
| `shared/permissions.js` | Permission keys and default staff roles. |
| `shared/schemas/` | Zod validation schemas (products, variants, stock adjustments, checkout, coupons, shipping, settings). |
| `functions/` | Cloud Functions. Deployed separately; only this folder is uploaded. |
| `functions/index.js` | Exports every function; sets region (`asia-south1`) and instance limits. |
| `functions/lib/` | Admin SDK setup, safe errors, secret-free logging, input validation. |
| `functions/http/` | HTTP endpoints (currently `healthCheck`). |
| `functions/migrations/` | Versioned, run-once data migrations and their runner. |
| `functions/scripts/` | `sync-shared.mjs` (copies `/shared` in before deploy) and `migrate.mjs`. |
| `functions/services/`, `callable/`, `triggers/`, `scheduled/` *(planned, Phase 3+)* | Business logic and the functions that call it. |
| `functions/shared/` | **Generated** copy of `/shared`. Never edit; never commit. |
| `scripts/emulators.mjs` | Starts the emulators (or runs a command against them) with the right Java settings for this machine. |
| `firebase.json`, `.firebaserc` | Hosting, functions, rules, emulator configuration; default project `italianshoes`. |
| `firestore.rules`, `storage.rules` | Security rules. Deny by default. |
| `firestore.indexes.json` | Composite indexes, added with each feature that needs one. |
| `tests/unit/` | Fast tests with no emulator (`npm test`). |
| `tests/emulator/` | Security-rules and Cloud Functions tests against the emulators (`npm run test:emulator`). |
| `docs/` | This file, the Phase 1 plan, and later the owner and configuration guides. |

## 2. Layering rules

1. **Views** (browser) display data and collect input. They contain no business rules.
2. **Callable functions** *(planned)* check who the caller is and validate input with a `shared/schemas` schema, then call a service.
3. **Services** *(planned)* hold the business rules and are the only code that writes protected data (prices, stock, orders, payments, roles). Multi-document changes run in Firestore transactions.
4. **Security rules** decide what a browser may read or write directly. Anything a customer must not be able to forge is written only by services through the Admin SDK.
5. **`shared/`** is the single source for validation, money and status rules; the browser uses it for instant feedback and the server uses the same code to enforce.

`shared/` must not import from `src/` or `functions/`. `functions/` must not import from `src/`.

## 3. Request flow

```
Browser view ──(Firebase SDK)──► Firestore             reads allowed by firestore.rules
     │
     └──(httpsCallable)──► Cloud Function ──► service ──► Firestore transaction
                              │                  │
                     auth + permission     audit log, notification,
                     + schema validation   stats update (planned)
```

Errors: services throw `AppError(code, safeMessage)`. `safeHandler`/`toHttpsError` passes those to the
browser unchanged and turns anything unexpected into a generic "Something went wrong" while logging
the full error server-side through `log`, which strips passwords, tokens and keys.

## 4. Authentication flow *(Phase 3)*

Firebase Auth (email + password) signs customers in; the browser holds Firebase's ID token. Staff are
ordinary Firebase users who additionally carry **custom claims** `{ staff: true, roles: [...], perms: [...] }`,
set only by an Owner-only Cloud Function. Security rules use the `can(permission)` helper in
`firestore.rules`; functions check the same claims. Public signup can never set claims. The first Owner
is created from the command line.

## 5. Data model

Collections, fields and who may access them are specified in `docs/PHASE-1-AUDIT-AND-PLAN.md`
section 4. Conventions:

- **Money**: integer paisa (`1250000` = Rs. 12,500). Use `shared/money.js`; never floating rupees.
- **Timestamps**: `createdAt`, `updatedAt` as server timestamps.
- **Snapshots**: orders copy product name, variant, SKU and unit price at the time of purchase.
- **Append-only**: `stockMovements`, `orders/{id}/history`, `auditLogs`.
- Collections in use today: `roles` (seeded by migration 001) and `_migrations` (migration bookkeeping).

## 6. Migrations

`functions/migrations/index.js` lists migrations in order. `runner.js` claims each one by creating
`_migrations/{id}` (fails if it already exists, so two runs can't apply it twice), runs it, and marks
it `done` or `failed`. Never edit a migration that has run in production; add a new one.

```
npm run migrate                          # emulators must be running
node functions/scripts/migrate.mjs --production --project italianshoes   # live database, explicit only
```

| ID | Effect |
| --- | --- |
| `001-seed-roles` | Creates the four staff roles from `shared/permissions.js`. Leaves existing roles untouched. |

## 7. Environments

| | Development | Production |
| --- | --- | --- |
| Frontend | `npm run dev` (Vite, port 5181) | `npm run build` → `dist/` on Firebase Hosting |
| Firebase | Emulators, project `demo-italianshoes` (cannot reach real services) | Project `italianshoes` |
| Switch | Default. `VITE_FIREBASE_TARGET=production` in `.env.local` points dev at the live project. | Always live. |
| Credentials | None needed | Functions use Google's built-in service identity. **No key files.** |

Functions region: `asia-south1` (Mumbai). It should match the Firestore database location chosen in the
Firebase console; change `FUNCTIONS_REGION` in `functions/index.js` and `src/app/firebase-config.js`
together if it doesn't.

## 8. Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Storefront dev server on http://localhost:5181 |
| `npm run emulators` | Firebase emulators + UI on http://localhost:4000 |
| `npm test` | Unit tests |
| `npm run test:emulator` | Rules + Functions tests (starts and stops emulators itself) |
| `npm run typecheck` | JSDoc type checking (`tsc`) |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run check` | lint + typecheck + unit tests + build |

## 9. Secrets

- The Firebase **web config** in `src/app/firebase-config.js` is public by design.
- **Service-account keys** (`*-firebase-adminsdk-*.json`) must never be placed in this project, the
  browser code, or any git repository. `.gitignore` blocks them. Nothing in this codebase reads one.
- Future secrets (payment gateway keys) go into Cloud Functions secrets (`firebase functions:secrets:set`),
  never into source files.
