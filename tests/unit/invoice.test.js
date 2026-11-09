import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceHtml } from "../../src/ui/invoice.js";
import { formatWhen } from "../../src/lib/when.js";
import { STATUS_LABEL, CUSTOMER_STATUS_TEXT } from "../../src/ui/orderLabels.js";
import { ORDER_STATUSES } from "../../shared/orderStatus.js";

const order = {
  number: "IS-2026-000007",
  status: "confirmed",
  paymentMethod: "cod",
  paymentStatus: "pending",
  createdAt: new Date("2026-11-05T10:30:00Z"),
  customer: { name: '<img src=x onerror="alert(1)">', phone: "+92 300 1234567" },
  address: { line1: "House 1 <script>x()</script>", area: "Gulberg", city: "Lahore" },
  deliveryInstructions: "Call first",
  notes: "",
  shippingMethod: { name: "Standard", estimateText: "" },
  items: [{ productName: "Cap-Toe Oxford", variantLabel: "Black / EU 42", sku: "IS-FO-1-BLK-42", qty: 2, unitPrice: 1950000, lineTotal: 3900000 }],
  subtotal: 3900000,
  discountTotal: 0,
  taxTotal: 0,
  shippingTotal: 20000,
  grandTotal: 3920000,
};

test("invoice shows the saved snapshot with exact PKR totals", () => {
  const html = invoiceHtml(order, { storeName: "Italian Shoes", address: "Main GT Road, Sarai Alamgir" });
  for (const text of ["IS-2026-000007", "Cap-Toe Oxford", "Black / EU 42", "Rs. 19,500", "Rs. 39,000", "Rs. 200", "Rs. 39,200", "Cash on Delivery", "Payment due on delivery", "Italian Shoes"]) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.ok(!html.includes("Discount") && !html.includes("Tax"), "no zero discount/tax rows");
});

test("invoice escapes hostile customer text", () => {
  const html = invoiceHtml(order, { storeName: "<b>Shop</b>" });
  assert.ok(!html.includes("<img src=x"), "customer name is escaped");
  assert.ok(!html.includes("<script>"), "address is escaped");
  assert.ok(!html.includes("<b>Shop</b>"), "store name is escaped");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("every order status has words for staff and for customers; dates are in Pakistan time", () => {
  for (const s of ORDER_STATUSES) {
    assert.ok(STATUS_LABEL[s], s);
    assert.ok(CUSTOMER_STATUS_TEXT[s], s);
  }
  assert.match(formatWhen(new Date("2026-11-05T19:30:00Z")), /6 Nov 2026/, "00:30 next day in Karachi");
  assert.equal(formatWhen(null), "—");
});
