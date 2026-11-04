# Phase 1 — Audit and Architecture Plan (Firebase)

Project: Italian Shoes storefront (`Desktop\Footwear Hero`)
Date: 2026-11-04
Status: **Plan approved in principle (Firebase chosen). Waiting for go-ahead to start Phase 2.** No application code has changed in this phase.

Owner decisions so far:

- **Backend: Firebase** (Auth, Firestore, Cloud Functions, Storage, Hosting).
- **Git:** no dedicated repository for now. See risk 1 in section 11.

---

## 1. What exists today (audit)

### 1.1 Stack

| Area | Today |
| --- | --- |
| Frontend | Vanilla JavaScript ES modules, no framework. Vite 6 dev server/bundler. |
| 3D hero | Three.js 0.170 (`src/scene.js`), loads a CC BY sample sneaker model from the jsDelivr CDN. |
| Routing | Hand-written History-API router (`src/app/router.js`), single `index.html`. |
| Styling | `src/style.css` (hero + header, 822 lines) and `src/store.css` (everything else, 2,241 lines). |
| Data | Hard-coded demo catalogue in `src/data/catalog.js` (17 sample products with invented prices and stock). |
| State | Bag and recently viewed products in `localStorage`. Checkout details in memory only. |
| Backend / database / auth / admin | **None.** |
| Orders | Not stored. Checkout builds a WhatsApp message (number not configured, so nothing is ever sent). |
| Tests | 30 unit tests with Node's built-in runner, all passing. |
| Lint / types | **None configured.** |
| Version control | **None of its own.** The folder sits untracked inside a git repository rooted at `C:\Users\sheharyar` (your whole user folder). |
| Local tooling | Node 24, JDK 17 and JDK 25 installed (Firebase emulators need Java). No Firebase project yet. |

### 1.2 File map (≈7,000 lines)

| Path | Purpose | Plan |
| --- | --- | --- |
| `src/scene.js` | Approved 3D hero stage. | **Keep unchanged.** |
| `src/ui/hero.js` | Approved hero markup and mounting. | **Keep.** Its words become editable from the admin; the design stays fixed. |
| `src/style.css` | Hero + header styles. | Keep. Remove two unused rules (`.next`, `.credit`). |
| `src/store.css` | All other storefront styles. | Keep the design; split into per-area files. |
| `src/app/router.js` | Client router. | Keep; add route guards for account and admin pages. |
| `src/app/state.js` | Loads the demo catalogue, bag, recently viewed. | Rewrite to read Firestore and call Cloud Functions. |
| `src/lib/cart.js`, `shop.js`, `format.js` | Pure logic. | Reuse for display. Authoritative pricing moves into Cloud Functions. |
| `src/lib/order.js` | Checkout validation + WhatsApp message. | Keep the validation (shared with Functions). **Remove** WhatsApp. |
| `src/data/catalog.js` | Demo products. | **Remove** (no sample products under the new policy). |
| `src/ui/*`, `src/views/*` | Storefront pages and components. | Keep the design; switch data sources. |
| `src/ui/illustration.js` | Drawn shoe placeholders. | Keep only as the "no photo yet" fallback. |
| `src/config.js` | Business settings in code. | Replace with Store Settings in Firestore. |

### 1.3 Problems found

1. **No backend exists.** Accounts, orders, admin, stock and payments all need to be built; this is the core of the work.
2. **Demo data is baked in** (17 products, prices, stock, two demo sale prices). Must be removed.
3. **WhatsApp checkout** is referenced in 10 files. Must be removed and replaced with real order placement.
4. **Prices are trusted from the browser** (unavoidable without a server). The new checkout recalculates everything in Cloud Functions.
5. **SEO is weak:** one `index.html` serves every page, so product pages share one title and description for crawlers.
6. **The hero depends on an external sample model** (Shopify's CC BY shoe). Fine for now; swap when the store has its own product model or photography.
7. **`store.css` (2,241 lines) and `ui/layout.js`** mix many concerns. Split before they grow.
8. **No lint or type checking.**
9. **No project-level version control.**
10. **Leftovers:** unused CSS classes `.next` and `.credit`.

---

## 2. Technical approach on Firebase

### 2.1 Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Storefront | **Keep Vite + vanilla JS.** Add the Firebase JS SDK. | Preserves the approved hero and current pages. |
| Admin dashboard | Second Vite entry (`admin.html`) sharing components and styles. | Separate bundle, so customers never download admin code. |
| Auth | **Firebase Authentication** (email + password). | Secure password hashing, sessions, password-reset emails and sign-in rate limiting are handled by Firebase. No SMTP needed for password reset. |
| Database | **Cloud Firestore.** | Real-time, managed. Transactions for stock and orders. |
| Server logic | **Cloud Functions for Firebase (2nd gen, Node 22).** | Everything that must be trusted: order placement, price and coupon calculation, stock changes, status changes, role assignment, image processing, audit logs. |
| Access control | **Firestore and Storage security rules** + **custom claims** for staff roles. | Customers can read only their own data; clients can never write prices, stock, orders or payments directly. |
| Images | **Cloud Storage for Firebase**. A Function validates each upload (real file type, size) and creates resized WebP versions with `sharp`. | Optimised product images. |
| Hosting | **Firebase Hosting** for the built site, with a rewrite to a Function that adds per-product SEO meta tags. | Fixes problem 5. |
| Validation | **Zod** schemas in `shared/`, used by browser forms and Functions. | One source of truth for rules. |
| Local development | **Firebase Emulator Suite** (Auth, Firestore, Functions, Storage). | Full system runs locally without a cloud project. |
| Types / lint | JSDoc types checked with `tsc --checkJs`, plus ESLint. | Type checking without converting to TypeScript. |
| Tests | Node's built-in runner for logic; `@firebase/rules-unit-testing` for security rules; Function tests against the emulators. | |

New dependencies: `firebase` (browser SDK), `firebase-admin` and `firebase-functions` (Functions), `zod`, `sharp` (Functions only), dev: `@firebase/rules-unit-testing`, `typescript`, `eslint`. `firebase-tools` runs via `npx` with a pinned version.

### 2.2 What Firebase changes compared with the original SQL brief

The brief described tables, foreign keys and migrations. On Firestore:

| Brief asks for | Firebase equivalent |
| --- | --- |
| Foreign keys, constraints | Enforced in Cloud Functions (every write that matters goes through one) and in security rules. Firestore itself has no foreign keys. |
| Migrations | Versioned migration scripts in `functions/migrations/` that run once (tracked in a `_migrations` collection), plus `firestore.indexes.json` and rules files under version control. |
| `CHECK (stock >= 0)` | Stock is only changed inside Firestore transactions in Functions, which refuse to go below zero. Clients cannot write stock at all (rules). |
| SQL reports and analytics | Daily rollup documents updated by Functions when orders change, plus Firestore `count()` / `sum()` aggregation queries. |
| Full-text search | Lower-cased keyword arrays on each product. Fine for a single-store catalogue; a search service can be added later if the catalogue grows to thousands of products. |

### 2.3 Cost and account requirements (important)

- **Cloud Functions require the Blaze (pay-as-you-go) plan**, which needs a billing card on the Firebase project. Without Functions, prices, stock and orders cannot be protected properly, so **Blaze is required for this design**.
- A small shop's traffic usually stays within Blaze's free monthly allowances, but this is not guaranteed. Set a budget alert in Google Cloud when creating the project.
- Everything can be built and tested locally on the emulators before the project exists.

---

## 3. Target folder structure

```
Footwear Hero/
├─ index.html                  storefront entry
├─ admin.html                  admin dashboard entry
├─ firebase.json               hosting, emulators, functions config
├─ .firebaserc                 project alias (added when the project exists)
├─ firestore.rules             database security rules
├─ firestore.indexes.json      composite indexes
├─ storage.rules               image upload rules
├─ shared/                     used by browser AND Functions
│  ├─ schemas/                 Zod schemas: product, variant, address, checkout, coupon…
│  ├─ money.js                 integer-paisa helpers, PKR formatting
│  ├─ orderStatus.js           allowed status transitions
│  └─ permissions.js           permission keys and role defaults
├─ src/                        browser code
│  ├─ app/                     router, Firebase init, auth state, API (callable Functions) client
│  ├─ storefront/
│  │  ├─ views/                home, shop, product, cart, checkout, confirmation, account/*, info pages
│  │  ├─ ui/                   cards, drawers, gallery, hero.js
│  │  └─ styles/               split from store.css
│  ├─ admin/
│  │  ├─ views/                one module per admin section
│  │  ├─ ui/                   table, filters, form fields, dialog, toast, chart
│  │  └─ styles/
│  └─ scene.js                 approved 3D hero (unchanged)
├─ functions/                  Cloud Functions (deployed separately)
│  ├─ index.js                 exports every function
│  ├─ lib/                     Admin SDK init, auth/permission guards, errors, audit, notifications
│  ├─ services/                business logic: orders, inventory, pricing, coupons, shipping, payments, staff, content
│  ├─ callable/                functions the browser calls (placeOrder, adjustStock, updateOrderStatus…)
│  ├─ triggers/                Firestore/Storage triggers (image processing, rollups, low-stock alerts)
│  ├─ scheduled/               timed jobs (release expired reservations, daily stats)
│  ├─ http/                    SEO page renderer, future payment-gateway webhooks
│  └─ migrations/              one-off data migrations
├─ scripts/                    create-owner.js (grants the first Owner role), emulator helpers
├─ tests/
│  ├─ unit/                    existing tests + new pure-logic tests
│  ├─ rules/                   security-rules tests (emulator)
│  └─ functions/               Function tests (emulator)
└─ docs/                       ARCHITECTURE.md, configuration guide, owner guide
```

Rule of thumb: **views** never contain business rules, **callable functions** only check permissions and input then call a **service**, and services are the only code that writes protected data.

---

## 4. Data model (Firestore)

Money is stored as **integer paisa** (Rs. 12,500 = `1250000`). Every document has `createdAt` / `updatedAt` (server timestamps). Fields marked 🔒 are written only by Cloud Functions; security rules deny all client writes to them.

### 4.1 People and access

| Collection | Fields | Who can read / write |
| --- | --- | --- |
| `users/{uid}` | name, phone, email, status (`active`/`disabled`), marketing consent | Customer reads/edits own name and phone; status 🔒. Staff with `customers.read` can read. |
| `users/{uid}/addresses/{id}` | label, name, phone, city, area, line1, isDefault | Owner of the account only. |
| `users/{uid}/wishlist/{productId}` | addedAt | Owner of the account only. |
| `carts/{uid}` | items: [{variantId, qty}] | Owner of the account. Guests keep the bag locally; it merges into `carts/{uid}` on sign-in. |
| `staff/{uid}` 🔒 | name, email, roles[], status, invitedBy | Owner only. Roles are mirrored into Firebase Auth **custom claims** so rules and Functions can check them. |
| `roles/{roleKey}` | name, permissions[] | Owner edits; seeded with Owner, Inventory Manager, Order Manager, Content Manager. |

Public signup creates a plain customer. Staff roles can only be granted by a Function called by the Owner. The first Owner is created with `scripts/create-owner.js` from the command line.

### 4.2 Catalogue and inventory

| Collection | Fields | Notes |
| --- | --- | --- |
| `categories/{id}` | name, slug, parentId, description, imagePath, sortOrder, isActive | Subcategories supported. |
| `brands/{id}`, `colors/{id}`, `sizes/{id}` | name / hex / system + value + sortOrder | Store-wide lists the admin manages. |
| `products/{id}` | name, slug, description, categoryId, brandId, sku, status (`draft`/`published`/`archived`), isFeatured, isNewArrival, seoTitle, seoDescription, images: [{path, alt, isPrimary, order}], **summary 🔒** (minPrice, maxPrice, onSale, inStock, colorIds, sizeIds, keywords) | Public can read only `published`. The summary is recalculated by a Function whenever variants or stock change, so listings and filters need one query. |
| `products/{id}/variants/{variantId}` | colorId, sizeId, sku, price, salePrice, isActive | Staff with `products.write`. |
| `variantCosts/{variantId}` | costPrice | Separate collection, readable only with `costs.read`. (Firestore rules can't hide single fields, so cost prices live apart.) |
| `inventory/{variantId}` 🔒 | productId, onHand, reserved, lowStockThreshold | Never written by clients. Changed only in transactions that refuse negative stock and overselling. |
| `stockMovements/{id}` 🔒 | variantId, change, reason (`initial`, `adjustment`, `sale`, `cancellation`, `return`, `correction`), note, actorUid, orderId | Append-only history with who made each change. |
| `reservations/{id}` 🔒 | variantId, qty, orderId, expiresAt, releasedAt | Used for online payments (not COD). |

"Best sellers" is calculated from real order items, not a manual flag.

### 4.3 Orders

| Collection | Fields | Notes |
| --- | --- | --- |
| `orders/{orderId}` 🔒 | number (`IS-2026-000123`), userId, status, paymentStatus, customer {name, phone, email}, address snapshot, items: [{productId, variantId, productName, variantLabel, sku, unitPrice, qty, lineTotal, imagePath}], subtotal, discountTotal, shippingTotal, grandTotal, coupon, shippingMethod snapshot, paymentMethod, idempotencyKey | Customer reads own orders; staff with `orders.read`. Item names, variants and prices are snapshots, so later product edits never change past orders. |
| `orders/{id}/history/{id}` 🔒 | from, to, note, actorUid, at | Every status change. |
| `orders/{id}/internalNotes/{id}` | text, authorUid | Staff only. Customers can't read this subcollection. |
| `orders/{id}/shipments/{id}` | courier, trackingNumber, trackingUrl, dispatchedAt, deliveredAt | Customer can read for tracking. |
| `counters/orders` 🔒 | next | Sequential order numbers, incremented in the order transaction. |
| `idempotency/{key}` 🔒 | orderId, uid, createdAt | Same checkout submitted twice returns the same order. |

Status flow (enforced in `shared/orderStatus.js` and the order service):

```
pending → confirmed → processing → dispatched → delivered → returned → refunded
   └────────┴────────────┴──→ cancelled   (only before dispatch; stock is restored)
```

### 4.4 Payments, shipping, coupons

| Collection | Fields | Notes |
| --- | --- | --- |
| `paymentMethods/{key}` | name, isEnabled, configStatus | COD can be switched on/off. A gateway can't be enabled until its credentials pass a server-side check. |
| `payments/{id}` 🔒 | orderId, method, amount, status (`pending`, `collected`, `paid`, `failed`, `refunded`, `partially_refunded`) | COD starts `pending` (not collected). Staff with `payments.update` mark it collected. |
| `payments/{id}/transactions/{id}` 🔒 | type (`charge`, `collection`, `refund`), amount, providerRef, status, actorUid | |
| `shippingMethods/{id}` | name, description, isActive, estimateText (owner-written) | |
| `shippingRates/{id}` | methodId, city (or `*` for all other cities), charge, freeOver | **No rates exist until the owner adds them.** Checkout explains that delivery isn't set up yet and won't place orders until a rate exists. |
| `coupons/{CODE}` | type (`percent`/`fixed`), value, minOrder, maxDiscount, startsAt, endsAt, usageLimit, perCustomerLimit, productIds, categoryIds, isActive, usedCount 🔒 | Validated only in Functions. |
| `couponRedemptions/{id}` 🔒 | code, orderId, uid | Counted inside the order transaction, so limits hold under parallel checkouts. |

### 4.5 Content, settings, reviews, logs

| Collection | Contents |
| --- | --- |
| `settings/public` | Store name, logo path, contact details, address, social links, currency (PKR), store open/closed, registration on/off, SEO defaults. Readable by everyone, editable by the Owner. |
| `settings/private` | Order number prefix, low-stock threshold, tax settings, notification preferences. Staff only. |
| `content/{key}` | Hero text, announcement bar, homepage sections, footer text. Content Managers edit. |
| `banners/{id}` | Title, image, link, placement, schedule, order, isActive. |
| `pages/{slug}` | About, privacy, terms, shipping, returns. Unpublished until the owner writes them. |
| `faqs/{id}` | Question, answer, order, isPublished. |
| `reviews/{id}` | productId, uid, orderId, rating, title, body, status (`pending`/`approved`/`rejected`). Only customers with a delivered order for that product can submit; approved before display. |
| `notifications/{id}` 🔒 | type (new order, status change, low stock, out of stock, cancellation, refund, payment change, important admin change), title, data, audience (permission), readBy[] |
| `auditLogs/{id}` 🔒 | actorUid, action, entityType, entityId, changes (secrets removed), at. Append-only; passwords, tokens and keys are never logged. |
| `stats/daily/{yyyy-mm-dd}` 🔒 | orders, revenue, by-status counts, items sold per product. Built from real orders only. |

### 4.6 Indexes

Composite indexes (in `firestore.indexes.json`): products by status + category + createdAt / minPrice; orders by userId + createdAt; orders by status + createdAt; stockMovements by variantId + createdAt; reviews by productId + status; auditLogs by entityType + entityId + at.

---

## 5. Critical flows

### 5.1 Placing an order (Cloud Function `placeOrder`)

1. The browser sends only: variant IDs + quantities, address, shipping method, coupon code, payment method (`cod`), terms accepted, and an **idempotency key** created once per checkout attempt.
2. The Function checks the signed-in user (or guest details), validates input with the shared Zod schema, then in **one Firestore transaction**:
   - reads every variant's `inventory` document and refuses the whole order if any line has `onHand − reserved < qty`;
   - recalculates prices from the variants, the coupon (dates, limits, targets, per-customer use) and shipping from the configured rates;
   - increments the order counter, writes the order with item snapshots, the payment record (`pending` for COD), the first history entry and the coupon redemption;
   - decrements `onHand` and writes a `sale` stock movement for each line.
3. Firestore transactions retry automatically if another checkout changed the same stock at the same moment, so the last pair can only be sold once.
4. A repeated idempotency key returns the existing order instead of creating another.
5. Afterwards: a notification for staff, an audit log entry, and the daily stats update.
6. Cancelling before dispatch restores stock (`cancellation`); an approved return restores it (`return`).

For COD, stock is committed when the order is placed. A future online gateway would **reserve** stock for 15 minutes while payment is pending; a scheduled Function releases expired reservations.

### 5.2 Authentication

- Signup and login use Firebase Auth. Firebase hashes passwords and throttles repeated failed sign-ins.
- Password reset uses Firebase's reset email (with the store name configured in the Firebase console).
- The session is Firebase's ID token. Callable Functions verify it automatically; rules check `request.auth.uid`.
- Customers can only read their own `users`, `addresses`, `carts` and `orders` documents (rules + tests).
- Disabling a customer or staff member revokes their sessions.

### 5.3 Admin actions

```
admin.html → callable Function (e.g. adjustStock)
           → requirePermission('inventory.adjust')   ← checked from custom claims on the server
           → service: validate → transaction → audit log → notification
           → Firestore
```

Simple content edits (FAQs, pages, banners) may write Firestore directly, but only where security rules check the editor's role claim. Hiding a button is never the protection.

### 5.4 Storefront data

The storefront reads `published` products, categories, settings and content directly from Firestore (fast, cached). With an empty database every listing shows a proper empty state (for example, "New styles are on their way"), never sample products.

---

## 6. Cloud Functions outline

**Customer:** `placeOrder`, `quoteCheckout` (server-calculated totals before placing), `validateCoupon`, `cancelMyOrder` (if still pending), `submitReview`, `mergeGuestCart`.

**Admin (permission-checked):** products and variants save/archive, `adjustStock`, `updateOrderStatus`, `addShipment`, `recordCodCollection`, `recordRefund`, `exportOrders` (CSV), `invoice` (printable HTML/PDF), `saveCoupon`, `saveShippingRates`, `inviteStaff` / `setStaffRoles` / `disableStaff` (Owner only), `saveSettings`, `moderateReview`, overview metrics.

**Triggers / scheduled:** `onImageUploaded` (validate + resize), `onVariantOrStockChange` (refresh product summary, low/out-of-stock notifications), `onOrderWrite` (daily stats), `releaseExpiredReservations` (every 5 minutes, used once a gateway exists).

**HTTP:** `seoPage` (adds title/description/Open Graph tags for product and category URLs), future payment webhooks.

---

## 7. Roles and permissions

| Area | Owner | Inventory manager | Order manager | Content manager |
| --- | :-: | :-: | :-: | :-: |
| Products, categories, images | ✓ | ✓ | view | view |
| Cost prices | ✓ | ✓ | – | – |
| Stock adjustments | ✓ | ✓ | – | – |
| Orders, status, invoices, export | ✓ | view | ✓ | – |
| COD collection, refunds | ✓ | – | ✓ | – |
| Customers | ✓ | – | ✓ | – |
| Coupons, shipping | ✓ | – | ✓ | – |
| Content, banners, pages, FAQs, reviews | ✓ | – | – | ✓ |
| Analytics | ✓ | inventory | orders | – |
| Staff, roles, settings, audit log | ✓ | – | – | – |

The Owner can change which permissions each role has.

---

## 8. What I will NOT invent

No products, prices, sizes, colours, stock, delivery charges or times, taxes, policies, reviews, customers, orders or statistics. The database starts empty apart from the four roles.

**Testing without fake accounts:** following your rule from Sabor con Amor, no test users or fake sign-ins are created anywhere. Security-rules and Function tests create their own temporary fixtures inside the emulator test run and discard them. Signed-in browser checks wait until the real Firebase project exists and you create the owner account.

The demo catalogue, demo sale prices and WhatsApp checkout are removed in Phase 9, when the storefront switches to Firestore. Until then the current preview keeps working.

---

## 9. External configuration required

| Item | Needed for | Without it |
| --- | --- | --- |
| **Firebase project on the Blaze plan** (you create it; billing card required) | Everything in production; Cloud Functions | Runs on local emulators only. |
| Firebase web app config (API key etc. — public by design) | Connecting the site to the project | Emulator only. |
| Authorized domain + email template sender name (Firebase console) | Password-reset emails | Reset emails use Firebase's default template. |
| Owner's email for `create-owner` | First admin login | No one can sign in to the admin. |
| Payment gateway merchant account (e.g. JazzCash, Easypaisa, Safepay) | Online payments | COD only; gateways show "Not configured". |
| Custom domain (optional) | Going live on your own address | Uses the free `*.web.app` address. |
| Business details: logo, contact, shipping rates, policies, products | Store content | Fields show as not set; checkout waits for shipping rates. |

No deployment happens without your explicit approval.

---

## 10. Phases (each ends with tests + a working build, then stops for your approval)

| Phase | Delivers |
| --- | --- |
| 1 | This audit and plan ✔ |
| 2 | Firebase setup (`firebase.json`, emulators, rules and index files), `shared/` schemas and money helpers, Functions skeleton with error handling, migrations runner, lint + type check, `ARCHITECTURE.md` |
| 3 | Customer signup/login/logout/password reset, account route guards, staff custom claims, permission guards, `create-owner` script, admin sign-in, rules tests for data isolation |
| 4 | Admin shell (sidebar, top bar, table, filters, dialogs, toasts), overview with real metrics and empty states, notifications, settings |
| 5 | Products, variants, cost prices, images (upload, validation, resize), categories, brands, colours, sizes, inventory adjustments and history, low-stock alerts |
| 6 | Server cart, `quoteCheckout`, `placeOrder` (transactions, idempotency), confirmation page, customer order history, admin order management, invoices, CSV export |
| 7 | COD payment tracking, refunds, payment gateway interface (inactive until configured), shipping methods and city rates |
| 8 | Customers, coupons, reviews, content management, analytics and reports, staff management, audit log |
| 9 | Storefront switched to Firestore; demo data and WhatsApp removed; account pages, wishlist, order tracking; per-page SEO |
| 10 | Full QA: rules and concurrency tests, security review, performance, accessibility, production build, owner guide |

Each phase is likely several working sessions.

---

## 11. Risks

1. **No version control.** You chose not to create a dedicated git repository for now. Large changes across many files can't be rolled back if something goes wrong. **Recommendation:** at least copy the folder (or zip it) before Phase 2 starts; a git repository can be added at any time later.
2. **Blaze billing.** Required for Cloud Functions. Set a budget alert.
3. **Firestore's data model.** Integrity relies on all important writes going through Functions and on well-tested rules. Rules tests are part of every phase.
4. **Emulator setup on this machine** needs JDK 25 first on `PATH` (your notes from Sabor con Amor). The project will include a helper script for this.
5. **Vanilla JS admin.** Sixteen modules means a lot of hand-written UI. A small shared kit (table, form, dialog) comes first to keep it consistent.
6. **Payment gateways** in Pakistan need merchant onboarding and sandbox credentials before any integration can be tested.

---

## 12. Next step

Your approval to start **Phase 2** (Firebase foundation). Before it starts, I recommend you make a copy or zip of the `Footwear Hero` folder, since there's no git repository.
