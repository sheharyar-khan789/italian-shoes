# Footwear storefront — client demo

A luxury footwear storefront built around the approved "Studio Edition" 3D hero, with a working bag and WhatsApp click-to-chat checkout.

Vanilla JavaScript + Vite, Three.js for the hero only. No backend; no payment gateway; no customer accounts.

## Run it

```bash
npm install
npm run dev        # http://localhost:5181
npm test           # unit tests (Node's built-in runner — no extra dependency)
npm run build      # production build → dist/
```

## What the owner needs to supply

Everything business-specific is in **`src/config.js`**. Until filled in, the site shows neutral placeholders or "To be confirmed".

| Setting | Where | Current state |
| --- | --- | --- |
| **WhatsApp order number** | `.env.local` → `VITE_WHATSAPP_BUSINESS_NUMBER=92XXXXXXXXXX` (or `WHATSAPP_BUSINESS_NUMBER` in `src/config.js`) | **Not set** — ordering is disabled and customers see a notice; they can still preview the message |
| Brand name / logo | `STORE.name`, `STORE.logo` (put the file in `public/brand/`) | "Italian Shoes" wordmark (from Instagram); no logo file yet |
| Delivery charge | `STORE.deliveryFee` (number in PKR, `0` = free) | `null` → "To be confirmed" |
| Contact details | `STORE.contact` | Phone 0342-7530608, Main GT Road Sarai Alamgir, Instagram — from @italianshoesofficial. Email and hours not supplied |
| Policies | wording in `src/views/pages.js`, then `STORE.policiesConfirmed = true` | Placeholder templates with a visible notice |
| Store story | `src/views/pages.js` (About) and the homepage story section in `src/views/home.js` | Placeholder |
| **Catalogue** | `src/data/catalog.js` | **Demo data** — sample names, prices and stock |
| Product photos | add URLs to each colour's `images: []` in the catalogue (files in `public/products/`) | Stylised illustrations stand in |

The WhatsApp number must be international format, digits only — e.g. `0300 1234567` → `923001234567`.

## How the order flow works

1. Customer picks colour + size (required) and quantity; the bag merges identical variants and keeps different sizes/colours as separate lines. Quantities are capped by stock.
2. The bag (product id, colour, size, qty only) is saved in `localStorage`; prices and names are always re-read from the catalogue.
3. Checkout collects name, phone, city, area, address (required) and WhatsApp number, delivery instructions, notes (optional). These live in memory only — never in browser storage.
4. On submit the form is validated (Pakistani mobile numbers), an order reference is generated (`ORD-YYMMDD-XXXXX`), and the message is built by `buildOrderMessage()` in `src/lib/order.js`.
5. `https://wa.me/<number>?text=<encodeURIComponent(message)>` opens in a new tab. The bag is **not** cleared and nothing is marked confirmed — the page explains the customer must press Send in WhatsApp, offers a fallback link and a copy button, and lets the customer empty their bag themselves once sent.

## Hosting note

This is a single-page app using real URLs (`/shop`, `/product/...`). Static hosts need a rewrite of all paths to `index.html` (Netlify `_redirects`: `/* /index.html 200`; Vercel: a rewrite in `vercel.json`). `npm run dev` and `vite preview` already handle this.

## Credits

Hero 3D model: "Materials Variants Shoe" © Shopify, CC BY 4.0 — a placeholder, loaded from the jsDelivr CDN. Replace with the store's own product model or photography before launch.
