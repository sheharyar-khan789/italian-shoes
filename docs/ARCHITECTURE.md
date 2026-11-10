# Architecture

Italian Shoes e-commerce platform. Vite + vanilla JavaScript in the browser, Firebase on the server
(Auth + Firestore on the free Spark plan; the website and server code on Vercel Hobby; photos in Vercel Blob).

> **Status (end of Phase 6):** Firebase foundation (2), accounts and staff roles (3), admin dashboard
> shell (4), the catalogue and stock (5), and orders (6): server-side order placement, status
> management, tracking, invoices, CSV export and customer order history. The storefront's own
> cart and checkout screens still run on the demo catalogue until Phase 9, when they are rewired
> to `quoteCheckout` / `placeOrder`. Items marked *(planned)* do not
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
| `src/app/session.js` | The browser's single gateway to Firebase Auth and the customer's own documents (sign-up, sign-in, reset, profile, addresses, claim ownership). |
| `src/views/account.js`, `src/ui/forms.js` | Account pages and shared form helpers. |
| `admin.html`, `src/admin/main.js` | Admin entry, built separately so customers never download admin code: staff sign-in, first-time Owner setup, then the dashboard. |
| `src/admin/shell.js`, `modules.js` | Dashboard frame (sidebar, top bar, notification count, `/admin/*` router) and the module list with the permission each needs. Unbuilt modules are shown as disabled "Soon" items. |
| `src/admin/ui/kit.js` | Shared admin UI: toast, confirm dialog, loading/empty/error states, stat card, paginated table. |
| `src/admin/data.js` | All admin reads/writes. Reads go to the server (never a stale cache) with a 12-second timeout. |
| `src/admin/views/` | Overview, notifications, activity log, store settings, categories & sizes, products (list + editor), inventory, orders (list + order page). |
| `src/views/accountOrders.js`, `src/app/ordersData.js` | Customer order history and order page (tracking, cancel), printable invoice (`src/ui/invoice.js`). |
| `src/admin/catalogData.js` | Admin reads for the catalogue and the `call()` helper for Cloud Functions; photo upload with progress. |
| `shared/` | Code used by **both** the browser and Cloud Functions. One copy of every business rule. |
| `shared/money.js` | Integer-paisa money helpers and PKR formatting. |
| `shared/phone.js` | Pakistani mobile number validation and normalisation. |
| `shared/orderStatus.js` | Allowed order and payment status changes. |
| `shared/permissions.js` | Permission keys and default staff roles. |
| `shared/schemas/` | Zod validation schemas (products, variants, stock adjustments, checkout, coupons, shipping, settings). |
| `api/` | Vercel entry points: `[fn].js` (every endpoint, POST `/api/<name>`) and `blobUpload.js` (photo-upload tokens). |
| `functions/` | Server code (name kept from the first design). Runs inside `api/`; no Cloud Functions are deployed. |
| `functions/registry.js`, `functions/handler.js` | Every endpoint by name, and the HTTP layer around it. |
| `functions/lib/` | Admin SDK setup, safe errors, secret-free logging, input validation, rate limiting, and **`callable.js` — the only way to create a callable function** (App Check, sign-in, permission, rate limit, validation, safe errors in one place). |
| `functions/migrations/` | Versioned, run-once data migrations and their runner. |
| `functions/scripts/` | `sync-shared.mjs` (copies `/shared` in before deploy) and `migrate.mjs`. |
| `functions/services/staff.js` | The only code that grants or removes staff access (custom claims + `staff/{uid}` + audit log). |
| `functions/callable/staff.js` | `claimOwner` (first-time setup) and `setStaffRoles` (Owner only). |
| `functions/services/settings.js`, `callable/settings.js` | `saveSettings`: validates, writes `settings/public` + `settings/private` in one transaction, logs a field-level diff, notifies the Owner. |
| `functions/services/catalog.js` | Categories, brands, colours, sizes: unique web addresses and names, one-level nesting, delete only when unused. |
| `functions/services/products.js` | Products and variants (id `{colorId}_{sizeId}` so duplicates are impossible), SKU registry (`skus/`), cost prices (`variantCosts/`, separate for permissions), publish checks (needs a photo and an active variant), and the product `summary` used for fast listing. |
| `functions/services/inventory.js` | The only code that changes stock: transactional, never below zero or below reserved, append-only `stockMovements`, low/out-of-stock notifications on crossing the line. |
| `functions/services/images.js` | Photo pipeline: the admin gets a one-time Vercel Blob upload token (`api/blobUpload.js`), uploads the original, then `addProductImage` checks the real file contents with sharp, makes 400/800/1600 px WebP, strips metadata, deletes the original and adds it to the product. |
| `functions/services/orders.js` | `quote`, `placeOrder` (one transaction: re-reads prices and stock, all-or-nothing, snapshots, COD payment left pending, idempotent), `updateOrderStatus` (allowed paths only, restocks on cancel/return, customers may cancel their own pending orders), notes, shipments, CSV export. |
| `functions/services/shipping.js` | Reads the owner's shipping methods and rates; never invents a charge. Orders are refused until delivery is configured (admin screens for it arrive in Phase 7). |
| `functions/callable/orders.js` | Customer: `quoteCheckout`, `placeOrder`, `cancelMyOrder`. Staff: `updateOrderStatus`, `addOrderNote`, `addShipment`, `exportOrders`. |
| `functions/callable/catalog.js` | The catalogue, product, photo and stock callables, each tied to `products.write` or `inventory.adjust`. |
| `functions/lib/notify.js`, `lib/audit.js` | Admin notifications (addressed to a permission) and the append-only activity log. |
| `functions/shared/` | **Generated** copy of `/shared`. Never edit; never commit. |
| `scripts/emulators.mjs` | Starts the emulators (or runs a command against them) with the right Java settings for this machine. |
| `scripts/check-secrets.mjs`, `.githooks/` | Secret scanner, run before every commit and in CI. |
| `.github/` | CI workflow (secrets, lint, typecheck, tests, build, audit, emulator tests) and Dependabot. |
| `vite.config.js` | Production build settings; `npm run preview` serves the build with the real security headers. |
| `SECURITY.md` | Everything security-related, including the owner's console checklist. |
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

## 4. Authentication flow

Firebase Auth (email + password) signs customers in; the browser holds Firebase's ID token. Staff are
ordinary Firebase users who additionally carry **custom claims** `{ staff: true, roles: [...], perms: [...] }`,
set only by `functions/services/staff.js`. Security rules use the `can(permission)` helper in
`firestore.rules`; `secureCallable` checks the same claims and, for staff actions, also checks live that
the account is enabled and its sessions weren't revoked. Public sign-up can never set claims.

First Owner: the account whose **verified** email equals `OWNER_EMAIL` (Functions environment) presses
"Claim ownership" on `/admin`; a transaction on `system/owner` makes this possible exactly once. After
that, only an Owner can grant roles. Removing any permission revokes that person's sessions. The last
Owner can't be removed. Step-by-step: `docs/OWNER-SETUP.md`.

Customer data: `users/{uid}` (name, email, phone) and `users/{uid}/addresses/*` are readable and
writable only by that customer; rules enforce the allowed fields and formats. Staff with
`customers.read` can read profiles but not addresses.

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
| `npm run secrets` | Secret scan |
| `npm run check` | secrets + lint + typecheck + unit tests + build |

## 9. Secrets

- The Firebase **web config** in `src/app/firebase-config.js` is public by design.
- **Service-account keys** (`*-firebase-adminsdk-*.json`) must never be placed in this project, the
  browser code, or any git repository. `.gitignore` blocks them. Nothing in this codebase reads one.
- Future secrets (payment gateway keys) go into Cloud Functions secrets (`firebase functions:secrets:set`),
  never into source files.
