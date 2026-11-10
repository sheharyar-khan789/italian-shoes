# Italian Shoes — online store

The online store and admin panel for **Italian Shoes** (Main GT Road, Sarai Alamgir). A customer-facing storefront with the approved 3D hero, plus an admin panel for the owner and staff. Everything the shop sells, charges and says comes from the database; nothing is hard-coded.

Vanilla JavaScript + Vite (Three.js for the hero only) · Firebase (Auth + Firestore, free Spark plan) · Vercel (website + server code in `api/`, free Hobby plan) · Vercel Blob (product photos).

## Run it locally (no real data is touched)

```bash
npm install
npm run emulators   # Firebase emulators (needs Java 21+); UI at http://localhost:4000
npm run dev         # storefront http://localhost:5181 · admin http://localhost:5181/admin
npm run check       # secret scan, lint, type-check, unit tests, production build
npm run test:emulator   # security rules, server logic and API tests against the emulators
```

`npm run dev` talks to the emulators, never to the live project.

## How ordering works

1. The shop reads **published** products, categories, colours, sizes, store settings and owner-written content from Firestore. An empty database shows an empty shop with a clear message (never sample products).
2. The bag stores only product, colour, size and quantity in the browser. Prices and stock are always re-read.
3. Checkout requires an account. After the customer enters a city, `quoteCheckout` returns the exact delivery options, discount and total from the server.
4. `placeOrder` re-prices everything on the server in one transaction (no overselling), takes the stock, applies any coupon, records Cash on Delivery as *pending*, and returns the order number. The browser can't send or change a price, a discount or a delivery charge.
5. The customer follows the order under **Account → Orders**; staff manage it in the admin.

There is no WhatsApp ordering and no online payment gateway; payment is cash on delivery.

## What the owner sets up (in the admin, not in code)

Store settings, delivery methods and charges, categories/colours/sizes, products with photos and stock, coupons, banners, FAQs and policy pages (About, Shipping, Returns, Privacy, Terms). Until delivery is set up, customers can't check out, and policy pages say "not published yet" rather than showing made-up text.

## Documentation

- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/OWNER-SETUP.md` — first-time owner setup and go-live steps
- `SECURITY.md` — security design and the Google Cloud checklist

## Credits

Hero 3D model: "Materials Variants Shoe" © Shopify, CC BY 4.0 — a placeholder, loaded from the jsDelivr CDN. Replace with the store's own product model or photography before launch.
