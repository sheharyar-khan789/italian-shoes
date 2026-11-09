# Security

How the Italian Shoes platform is protected, what each future phase adds, and the settings the
owner must switch on in the Firebase / Google Cloud / GitHub consoles (code can't do those).

---

## 1. In place now

### Website (browser)

| Protection | Where | What it stops |
| --- | --- | --- |
| **Strict Content Security Policy** — scripts only from this site; no inline scripts, no `eval`, no plugins; images, fonts and API calls only from listed origins | `firebase.json` (hosting headers) | Cross-site scripting (XSS) and injected third-party code |
| No inline scripts or `on…=` handlers anywhere | `public/js-flag.js`, `src/ui/illustration.js` | Required for the CSP to work |
| **HSTS** (`max-age` 2 years) | `firebase.json` | Downgrade to insecure http |
| `X-Frame-Options: DENY` + `frame-ancestors 'none'` | `firebase.json` | Clickjacking (site shown inside another site's frame) |
| `X-Content-Type-Options: nosniff` | `firebase.json` | MIME-type confusion attacks |
| `Referrer-Policy: strict-origin-when-cross-origin` | `firebase.json` | Leaking page URLs to other sites |
| `Permissions-Policy` (camera, microphone, location, payment, USB off) | `firebase.json` | Abuse of device features |
| `Cross-Origin-Opener-Policy: same-origin` | `firebase.json` | Cross-window attacks |
| External links use `rel="noopener noreferrer"` | `src/` | Reverse tab-nabbing |
| All dynamic text is HTML-escaped before display | `src/lib/format.js` (`esc`), used throughout | XSS through product names, search terms, form input |
| No source maps in production | `vite.config.js` | Publishing readable source code |
| Google Analytics **off** until there's a consent banner | `src/app/firebase-config.js` | Tracking without consent |
| Bag stores only product ids and quantities; checkout details never stored | `src/lib/cart.js` | Personal data left in the browser |

`npm run build && npm run preview` serves the production build **with these exact headers** (from
`firebase.json`) on http://localhost:5182, so the policy is tested before every deploy.

### Database and server

| Protection | Where |
| --- | --- |
| Firestore and Storage rules **deny everything by default**; each feature opens only what it needs | `firestore.rules`, `storage.rules` |
| Prices, stock, orders, payments and roles can be written **only** by Cloud Functions | rules + plan |
| Every callable function goes through `secureCallable`: App Check → sign-in → permission → rate limit → input validation → safe errors | `functions/lib/callable.js` |
| Staff permission checks also verify **live** that the account isn't disabled and its sessions weren't revoked | `functions/lib/callable.js` |
| Accounts: Firebase Auth (Google hashes passwords, throttles sign-in), 10+ character password rule, email verification | `src/app/session.js`, `shared/schemas/account.js` |
| Sign-in and password-reset messages never reveal whether an email has an account | `src/app/authErrors.js`, `session.requestPasswordReset` |
| Post-login redirects only to this site (no open redirect) | `src/app/safeNext.js` |
| Customers can read/write only their own profile and addresses, with field and format checks | `firestore.rules`, `tests/emulator/rules.test.js` |
| Staff roles only via `services/staff.js`; owner claimable once by the verified `OWNER_EMAIL`; last Owner can't be removed; downgrades revoke sessions; every change audit-logged | `functions/services/staff.js` |
| Auth SDK set up without iframes, so the CSP keeps `frame-src 'none'` | `src/app/firebase.js` |
| Admin page is `noindex` and a separate bundle | `admin.html`, `firebase.json` |
| Products, variants, prices, stock and SKUs are written only by Cloud Functions; shoppers read only published products | `firestore.rules`, `tests/emulator/rules.test.js` |
| Cost prices live in a separate collection readable only with `costs.read`; saves from staff without it ignore cost | `functions/services/products.js` |
| Stock can't go negative, even with parallel changes (transactions); every change logged with who and why; sales can't be entered by hand | `functions/services/inventory.js`, `tests/emulator/catalog.test.js` |
| Orders are created and changed only by Cloud Functions. The server re-reads every price, stock level and delivery charge (browser-sent totals don't exist). One transaction per order: all-or-nothing, no overselling under parallel checkouts, no duplicates on retry | `functions/services/orders.js`, `tests/emulator/orders.test.js` |
| Customers read only their own orders, history and tracking; internal staff notes and payment records are never readable by customers; another customer's order id looks the same as an unknown one | `firestore.rules`, `tests/emulator/rules.test.js` |
| Orders keep a permanent snapshot of names, variants and prices; Cash on Delivery is never marked paid automatically; coupons are refused until they exist | `functions/services/orders.js` |
| CSV exports neutralise spreadsheet formulas and every export is logged; invoices escape all customer text | `functions/lib/csv.js`, `src/ui/invoice.js` |
| Photo uploads: staff only, JPEG/PNG/WebP only (no SVG), 8 MB limit, uploader recorded; then the real file contents are verified, resized, metadata (camera, GPS) stripped, original deleted | `storage.rules`, `functions/services/images.js` |
| Rate limiting shared across all server instances, using transactions; IPs stored only as hashes | `functions/lib/rateLimit.js` |
| Input validation with shared Zod schemas; unknown fields (like a forged `price`) are dropped | `shared/schemas/`, `functions/lib/validate.js` |
| Internal errors never reach the browser | `functions/lib/errors.js` |
| Logs strip passwords, tokens, keys and cookies at any depth | `functions/lib/logger.js` |
| Money is whole paisa only; fractional or overflowing amounts are rejected | `shared/money.js` |
| Order and payment status can only move along allowed paths | `shared/orderStatus.js` |
| Owner-only permissions (staff, settings, audit log) can never be granted to another role | `shared/permissions.js` |
| `maxInstances: 10` caps how far an attack or traffic spike can run up the bill | `functions/index.js` |
| Emulators use a `demo-` project id, so development can never touch live data | `scripts/emulators.mjs` |
| No service-account key is used anywhere; Cloud Functions use Google's built-in identity | `functions/lib/admin.js` |

### Code and supply chain

| Protection | Where |
| --- | --- |
| **Secret scanner** blocks private keys, service-account files, `.env` files and tokens | `scripts/check-secrets.mjs` |
| Runs automatically before every commit (git hook) | `.githooks/pre-commit` |
| Runs on every push in CI, with lint, type check, tests, build and `npm audit` | `.github/workflows/ci.yml` |
| `.gitignore` blocks key files, `.env` files and generated folders | `.gitignore` |
| Dependabot opens update PRs for security fixes weekly | `.github/dependabot.yml` |
| Dependencies pinned to exact versions; npm blocks install scripts by default | `package.json`, `functions/package.json` |
| Patched gRPC forced inside the Firebase browser SDK (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4) | `package.json` `overrides` |

**Known, accepted:** 6 *moderate* advisories in `functions/` come from Google's own `firebase-admin →
google-gax → rimraf → glob → minimatch` chain (pattern-matching slowdown with attacker-supplied glob
patterns, which this code never passes). Waiting for Google's update via Dependabot; CI fails only on high.
| Security regression tests: fail if the CSP, headers, rules or permission checks are weakened | `tests/unit/security.test.js`, `tests/emulator/` |

After cloning, run `git config core.hooksPath .githooks` once to enable the pre-commit hook.

---

## 2. Added with each feature (planned)

| Phase | Security added |
| --- | --- |
| 5 — Products | Image uploads: type and size checked in Storage rules **and** re-checked by a Cloud Function (real file signature), re-encoded to strip metadata; cost prices in a separate restricted collection |
| 6 — Orders | Server recalculates every price, discount and delivery charge; stock locked in transactions (no overselling); idempotency keys (no duplicate orders); customers see only their own orders; internal notes hidden from customers |
| 7 — Payments | COD never marked paid automatically; online gateways verified server-side by signed webhooks; gateway secrets in Cloud Functions secrets, never in code |
| 8 — Admin | Audit log of every sensitive staff action (secrets removed); Owner-only staff management |

---

## 3. Owner checklist — console settings (do these before going live)

**Urgent**

- [ ] **Delete the exposed admin key.** Google Cloud Console → IAM & Admin → Service Accounts →
      `firebase-adminsdk-fbsvc@italianshoes…` → Keys → delete key `d8d1b2ab…`. It was shared in a chat.
      This project never needs a key file.
- [ ] **Move the downloaded key file** out of `C:\Users\sheharyar\Downloads` (that folder is inside a git
      repository that pushes to GitHub and doesn't ignore it), or delete it.
- [ ] Turn on **2-step verification** for the Google account that owns the Firebase project and for GitHub.

**Firebase / Google Cloud**

- [ ] **Restrict the web API key**: Google Cloud Console → APIs & Services → Credentials → the browser key →
      Application restrictions: *Websites* → add `italianshoes.web.app/*`, `italianshoes.firebaseapp.com/*`,
      your own domain, and `localhost` for development.
- [ ] **Authentication → Settings**: turn on *Email enumeration protection*; set a *Password policy*
      (at least 10 characters); keep *Authorized domains* to your real domains only.
- [ ] **App Check** (bot protection): create a reCAPTCHA Enterprise key, register the web app in
      Firebase → App Check, then:
      1. put the site key in `.env.local` / build env as `VITE_APPCHECK_SITE_KEY`;
      2. add to the CSP in `firebase.json`: `script-src https://www.google.com https://www.gstatic.com`,
         `frame-src https://www.google.com`, and `https://www.google.com` in `connect-src`;
      3. after a few days of monitoring, enforce App Check for Firestore, Storage and Functions, and set
         `APP_CHECK_ENFORCE=true` in `functions/.env.italianshoes`.
- [ ] **Firestore TTL**: Firestore → TTL policies → collection group `_rateLimits`, field `expireAt`.
- [ ] **Backups**: enable Firestore point-in-time recovery and a daily scheduled backup.
- [ ] **Budget alert**: Google Cloud → Billing → Budgets & alerts (e.g. alert at Rs. 1,000 / month).
- [ ] When staff accounts exist: consider **multi-factor sign-in** for the Owner and staff (needs the free
      Identity Platform upgrade in Firebase Authentication).

**GitHub** (`sheharyar-khan789/italian-shoes`)

- [ ] Settings → Code security: enable **Secret scanning** and **Push protection**, **Dependabot alerts** and
      security updates.
- [ ] Settings → Branches: protect `main` (require the CI checks to pass; no force pushes).
- [ ] Consider making the repository **private**. Nothing secret is in it, but the business code needn't be public.

---

## 4. Reporting a problem

Contact for security reports: *to be confirmed by the owner.* Once there is one, add it here and in
`public/.well-known/security.txt`.
