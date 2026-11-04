import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePkMobile,
  normalizeWhatsAppNumber,
  validateCheckout,
  createOrderRef,
  buildOrderMessage,
  buildWhatsAppUrl,
} from "../../src/lib/order.js";
import { formatPKR } from "../../src/lib/format.js";

const validForm = {
  name: "Ayesha Khan",
  phone: "0300-1234567",
  whatsapp: "",
  city: "Lahore",
  area: "DHA Phase 5",
  address: "House 12, Street 4\nNear the park",
  instructions: "",
  notes: "",
};

const items = [
  { name: "Studio Low-Top", id: "DEMO-SN-001", size: 41, color: "Beach Rose", qty: 2, unitPrice: 12500, lineTotal: 25000 },
  { name: "Leather Slide", id: "DEMO-SA-002", size: 40, color: "Brown", qty: 1, unitPrice: 4900, lineTotal: 4900 },
];

test("PKR formatting", () => {
  assert.equal(formatPKR(12500), "Rs. 12,500");
  assert.equal(formatPKR(0), "Rs. 0");
  assert.equal(formatPKR(1234567), "Rs. 1,234,567");
});

test("Pakistani mobile numbers normalise; others are rejected", () => {
  for (const v of ["03001234567", "0300 1234567", "0300-1234567", "+923001234567", "923001234567", "00923001234567"]) {
    assert.equal(normalizePkMobile(v), "+92 300 1234567", v);
  }
  for (const v of ["", "12345", "0421234567", "+9230012345678", "abc"]) assert.equal(normalizePkMobile(v), null, v);
});

test("store WhatsApp number must be digits-only international format", () => {
  assert.equal(normalizeWhatsAppNumber("923001234567"), "923001234567");
  assert.equal(normalizeWhatsAppNumber(""), null);
  assert.equal(normalizeWhatsAppNumber("+923001234567"), null);
  assert.equal(normalizeWhatsAppNumber("0300 1234567"), null);
  assert.equal(normalizeWhatsAppNumber("03001234567"), null, "leading zero is local format");
});

test("validation: valid form passes", () => {
  assert.deepEqual(validateCheckout(validForm), {});
});

test("validation: each required field reports a helpful error", () => {
  const errors = validateCheckout({ ...validForm, name: " ", phone: "123", city: "", area: "", address: "short" });
  assert.deepEqual(Object.keys(errors).sort(), ["address", "area", "city", "name", "phone"]);
  assert.match(errors.phone, /0300 1234567/);
});

test("validation: optional WhatsApp must be valid when supplied", () => {
  assert.ok(validateCheckout({ ...validForm, whatsapp: "999" }).whatsapp);
  assert.equal(validateCheckout({ ...validForm, whatsapp: "0321 7654321" }).whatsapp, undefined);
});

test("order reference format", () => {
  const ref = createOrderRef(new Date(2026, 9, 20));
  assert.match(ref, /^ORD-261020-[A-HJ-NP-Z2-9]{5}$/);
  assert.notEqual(createOrderRef(), createOrderRef());
});

test("message contains every required detail, with delivery pending", () => {
  const msg = buildOrderMessage({
    ref: "ORD-261020-ABCDE",
    form: { ...validForm, whatsapp: "0321 7654321", instructions: "Call before arriving", notes: "Gift wrap if possible" },
    items,
    totals: { itemCount: 3, subtotal: 29900, delivery: null, total: null },
  });
  for (const expected of [
    "*NEW FOOTWEAR ORDER*",
    "Order Reference: ORD-261020-ABCDE",
    "Name: Ayesha Khan",
    "Phone: +92 300 1234567",
    "WhatsApp: +92 321 7654321",
    "City: Lahore",
    "Area: DHA Phase 5",
    "Address: House 12, Street 4, Near the park",
    "Delivery Instructions: Call before arriving",
    "1. Studio Low-Top",
    "   Product ID: DEMO-SN-001",
    "   Size: EU 41",
    "   Color: Beach Rose",
    "   Quantity: 2",
    "   Unit Price: Rs. 12,500",
    "   Subtotal: Rs. 25,000",
    "2. Leather Slide",
    "Items: 3",
    "Subtotal: Rs. 29,900",
    "Delivery: To be confirmed by the store",
    "Total: Rs. 29,900 + delivery (to be confirmed)",
    "Customer Notes: Gift wrap if possible",
    "Please confirm product availability, delivery charges, and order acceptance.",
  ]) {
    assert.ok(msg.includes(expected), `missing: ${expected}`);
  }
});

test("message omits WhatsApp when same as phone, and shows confirmed delivery", () => {
  const msg = buildOrderMessage({
    ref: "R",
    form: { ...validForm, whatsapp: "+92 300 1234567" },
    items,
    totals: { itemCount: 3, subtotal: 29900, delivery: 250, total: 30150 },
  });
  assert.ok(!msg.includes("WhatsApp:"));
  assert.ok(msg.includes("Delivery: Rs. 250"));
  assert.ok(msg.includes("Total: Rs. 30,150"));
  assert.ok(!msg.includes("Customer Notes"));
});

test("WhatsApp URL is wa.me with a fully encoded message that round-trips", () => {
  const message = buildOrderMessage({
    ref: "ORD-1",
    form: { ...validForm, address: "Flat #3 & 4, Block B?\nStreet 7 — 100% sure", notes: "Size 41/42 + extra laces" },
    items,
    totals: { itemCount: 3, subtotal: 29900, delivery: null, total: null },
  });
  const url = buildWhatsAppUrl("923001234567", message);
  assert.ok(url.startsWith("https://wa.me/923001234567?text="));
  const encoded = url.split("?text=")[1];
  assert.ok(!/[\s#&?+]/.test(encoded), "reserved characters must be encoded");
  assert.equal(decodeURIComponent(encoded), message);
  assert.equal(new URL(url).searchParams.get("text"), message);
});

test("no URL is produced when the store number is missing or invalid", () => {
  assert.equal(buildWhatsAppUrl("", "hi"), null);
  assert.equal(buildWhatsAppUrl("+92 300 1234567", "hi"), null);
});
