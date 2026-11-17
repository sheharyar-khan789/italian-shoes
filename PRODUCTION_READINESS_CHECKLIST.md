# Production Readiness Checklist

Status as found in this audit. `[ ]` = not done / not verified, `[x]` = verified done.

## Source control & delivery
- [ ] All work committed and pushed (173 untracked + 44 modified files) — O-01
- [ ] CI green on the full code (lint, typecheck, unit, build, audit, emulator tests)
- [ ] Project moved out of OneDrive — C-03
- [x] Secrets scan in CI; service-account file git-ignored and not in history

## Security
- [ ] Service-account key revoked/rotated; local file deleted — S-01
- [ ] `zod`, `@vercel/blob` and transitive dependencies upgraded; `npm audit` clean — S-02
- [ ] Live session revocation on every staff endpoint — S-03
- [ ] CNIC/HR documents and receipts private, deleted with their records — S-04
- [ ] `registrationOpen` enforced or removed — S-05
- [ ] Firebase console: password policy, enumeration protection, authorised domains, API-key restriction, App Check — S-06
- [ ] Owner wildcard claim deployed and Owner re-saved — S-07
- [x] Deny-by-default Firestore rules, server-only writes (tested)
- [x] All endpoints authenticated, rate-limited, validated (code review)

## Deployment
- [ ] Deploy order: rules + indexes (wait until Enabled) → code — C-01
- [ ] `OWNER_EMAIL`, `FIREBASE_*`, `BLOB_READ_WRITE_TOKEN` set in Vercel and verified
- [ ] Custom domain + HTTPS verified
- [ ] Opening balances posted before go-live — B-10

## Operations
- [ ] Scheduled Firestore export + tested restore — C-02
- [ ] Uptime and error monitoring/alerts — C-02
- [ ] Scheduler for recurring expenses, loyalty expiry, report schedules — B-03/B-04
- [ ] Rollback procedure for code and data documented

## Verification
- [ ] Browser E2E for the ten core workflows on a staging project — T-01
- [ ] Load/concurrency test — T-02
- [ ] Real printer, barcode scanner, offline-cycle tests
- [ ] Email verification and password reset tested live

## Functional gaps to decide on
- [ ] POS returns/exchanges — B-01
- [ ] Offline app shell (service worker) — B-02
- [ ] Logo upload — B-05
- [ ] Online payment gateway (if wanted) — B-13
- [ ] Bank reconciliation / period close — B-14
- [ ] HR statutory deductions, leave proration — B-11
