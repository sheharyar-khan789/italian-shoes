# Owner guide — running the store day to day

Everything customers see (products, prices, stock, delivery charges, policies, banners) is entered by
you in the admin panel at **/admin**. Nothing is pre-filled: until you add it, the website simply shows
nothing for it, or says "not published yet".

## First-time setup order

Do these once, in this order. Customers **cannot check out** until step 5 is done.

1. **Store settings** → store name, phone, address, hours, Instagram, announcement bar, order prefix (e.g. `IS`), low-stock level. Switch "Store is open" on.
2. **Categories & Sizes** → add your categories, colours and sizes (e.g. EU 40, 41, 42 …).
3. **Products** → add a product, add at least one photo, then create its colour × size options with prices. Add stock in **Inventory & Stock**. A product can be **published** only when it has a photo and one active option.
4. **Shipping** → add a delivery method (e.g. "Standard delivery"), then a charge for each city. Use "All other cities" for a flat charge. Optionally set "free delivery from" an order amount.
5. **Payments** → Cash on Delivery is on by default. Online payment methods show as "Not connected" until a merchant account is set up.
6. **Website content** → write your About, Shipping, Returns, Privacy and Terms pages (they stay hidden until you tick *Published*), add FAQs, banners and choose home-page sections.

## Orders (every day)

- **Orders** lists new orders (you also get a notification). Open one to see the customer, address, items and history.
- Move it forward: *Pending → Confirmed → Processing → Dispatched → Delivered*. Add the courier name and tracking number when you dispatch; the customer sees it.
- **Cancel** before dispatch: stock goes back automatically and any coupon use is returned. A **returned** order also puts stock back.
- **Cash on Delivery:** after the order is dispatched or delivered, press *Record cash collected*. It can be recorded once, for the full amount. If you refund, record it under **Payments / the order**; you can refund up to what was collected.
- **Export** gives a CSV of orders for your accounts.
- Customers can cancel their own order only while it is still *Pending*.

## Stock

- Stock is taken automatically when an order is placed, so the last pair can only be sold once.
- Use **Inventory & Stock** to add received stock or correct a count. Every change needs a reason and is logged.
- You get a notification when a size runs low (at your low-stock level) or sells out.

## Coupons

**Coupons & offers** → code, percent or fixed amount, optional minimum order, largest discount, start/end dates, total uses, uses per customer, and optional category/product limits. A customer must be signed in to use a code. The server checks every rule again when the order is placed.

## Reviews

Only customers whose order was **delivered** can review that product. New reviews wait in **Reviews** until you *Publish* or *Hide* them. You can add a public reply.

## Customers and staff

- **Customers** lists accounts; open one to see their details and orders. *Suspend* signs them out and stops them signing in or ordering until you re-enable them.
- **Staff & Roles** (Owner only): the person creates a normal account on the website first, then you enter their email and tick a role.
  - *Owner*: everything. The store always keeps at least one Owner.
  - *Inventory Manager*: products, stock, reports on stock.
  - *Order Manager*: orders, payments, customers, shipping, coupons.
  - *Content Manager*: website content and reviews.
- Removing a permission signs that person out immediately.

## Reports

**Analytics & reports** shows orders, sales, average order, pairs sold, customers, cash collected, best sellers, orders by status and per day, for any date range (up to a year), plus current stock position. Cancelled orders are left out of sales; returned orders are left out of best sellers. Days are Pakistan time.

## Activity log and notifications

The **Activity log** (Owner) records who changed what, and cannot be edited. **Notifications** shows new orders, status changes, refunds, low stock, new reviews and staff changes for the permissions you hold.

## Good habits

- Use a long, unique password and keep your email account secure; whoever controls it can reset your admin password.
- Give staff only the role they need, and remove access when someone leaves.
- Check **Orders** and **Reviews** daily; check **Inventory** after receiving stock.
- Take a note of your Firebase billing budget alert; if a huge spike appears, tell your developer.
