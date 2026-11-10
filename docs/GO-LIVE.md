# Go-live checklist (Phase 10)

Nothing here has been done to the live project yet. Deploying, enabling billing and pushing code each need the owner's explicit say-so.

## Status at the end of Phase 10

| Area | Verified how |
| --- | --- |
| Shared rules, schemas, money, coupon logic | Unit tests (`npm test`) |
| Firestore security rules | Emulator tests (`npm run test:emulator`) |
| Orders, stock (no overselling), coupons, payments, refunds, reviews, content, reports | Emulator tests against real Firestore transactions |
| Storefront browsing, product page, bag, FAQ/policy pages, sign-in redirect | Opened in a browser against emulator data |
| **Signed-in checkout, review form, wishlist, every admin screen with real data** | **Not run in a browser.** Their backend is tested; the screens themselves have not been seen working, because test accounts are not created. Do the walkthrough below on the live site before announcing it. |
| Online payment gateways | Not built (Cash on Delivery only) |
| Link-preview (WhatsApp/Facebook) cards per product | Not supported: tags are set by JavaScript, which those bots don't run |
| Sitemap | Not generated |

## Before deploying

1. Firebase console steps in `docs/OWNER-SETUP.md` section 1 (Email/Password, enumeration protection, password policy, authorized domains, Firestore in asia-south1, Blaze plan + budget alert).
2. Google Cloud console items in `SECURITY.md` (restrict the web API key to your domains; App Check with reCAPTCHA Enterprise, then set `APP_CHECK_ENFORCE=true` in `functions/.env.italianshoes` and `VITE_APPCHECK_SITE_KEY` for the build).
3. Rotate the admin-SDK key that was shared in chat (delete it in Google Cloud → IAM → Service accounts → Keys, and delete the copy in Downloads), and change the owner password that was shared in chat.
4. `npm run check` and `npm run test:emulator` must both pass on the commit you deploy.
5. Follow `docs/VERCEL-SETUP.md`: server key and Vercel variables, Blob store, `firebase deploy --only firestore:rules,firestore:indexes`, redeploy. Wait until the indexes show "Enabled" in the Firebase console before opening the shop.
6. Claim ownership (`docs/OWNER-SETUP.md` section 3).

## Walkthrough on the live site (owner + developer, ~30 minutes)

1. Admin → fill in the first-time setup in `docs/OWNER-GUIDE.md`.
2. Add one real product with a photo, a size and stock. Publish it. Confirm the photo shows on the shop.
3. Create a customer account (not the owner's) and place an order with Cash on Delivery. Check: totals match the quote, the order number appears, stock dropped by one, the order shows in Admin → Orders, a notification arrived.
4. Add a coupon and place a second order with it; check the discount and that the same customer cannot exceed the per-customer limit.
5. Move the order to Delivered, record cash, then leave a review from the customer account, publish it in Admin → Reviews, and confirm it appears on the product page.
6. Cancel a different pending order from the customer account and confirm stock returns.
7. Suspend the test customer in Admin → Customers; confirm they can't order; re-enable.
8. Delete the test orders' data or mark them clearly before opening to the public.
9. On a phone, check shop, product, bag, checkout and the 3D hero.

## Rollback

In Vercel → Deployments, choose an earlier deployment → **Promote to Production** (instant rollback). Rules can be redeployed from the previous git commit. Orders and customers live in Firestore and are not affected by redeploying the site.

## Known limits (deliberate)

- A bag and checkout need an account (no guest checkout).
- One order = Cash on Delivery only.
- Unknown web addresses show a "page doesn't exist" screen but are served with a normal status (a "soft 404").
- The home-page hero copy is fixed in code (`src/ui/hero.js`); everything else is owner-editable.
