/**
 * Checkout validation, order message and WhatsApp click-to-chat link.
 * Pure functions — no DOM, no config imports — so they can be unit-tested in Node.
 */
import { formatPKR } from "./format.js";

/* ───────── Phone numbers ───────── */

// Single implementation shared with Cloud Functions.
export { normalizePkMobile } from "../../shared/phone.js";
import { normalizePkMobile } from "../../shared/phone.js";

/**
 * The store's WhatsApp number for wa.me: digits only, international format, no leading "+".
 * Returns null if it is missing or malformed (the UI then disables WhatsApp ordering).
 */
export function normalizeWhatsAppNumber(value) {
  const digits = String(value ?? "").trim();
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

/* ───────── Checkout form ───────── */

export const CHECKOUT_FIELDS = ["name", "phone", "whatsapp", "city", "area", "address", "instructions", "notes"];

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanBlock = (v, max) =>
  String(v ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .slice(0, max);

/** Trim and length-limit every field. Never mutates the input. */
export function cleanCheckout(form) {
  return {
    name: clean(form.name, 80),
    phone: clean(form.phone, 20),
    whatsapp: clean(form.whatsapp, 20),
    city: clean(form.city, 60),
    area: clean(form.area, 80),
    address: cleanBlock(form.address, 300),
    instructions: cleanBlock(form.instructions, 300),
    notes: cleanBlock(form.notes, 500),
  };
}

/** Returns { field: message } — empty object when valid. */
export function validateCheckout(form) {
  const f = cleanCheckout(form);
  const errors = {};
  if (f.name.length < 3) errors.name = "Please enter your full name.";
  else if (!/\p{L}/u.test(f.name)) errors.name = "Please enter a valid name.";

  if (!f.phone) errors.phone = "Please enter a contact number.";
  else if (!normalizePkMobile(f.phone)) errors.phone = "Enter a Pakistani mobile number, e.g. 0300 1234567.";

  if (f.whatsapp && !normalizePkMobile(f.whatsapp)) errors.whatsapp = "Enter a valid WhatsApp number, or leave this blank.";

  if (f.city.length < 2) errors.city = "Please enter your city.";
  if (f.area.length < 2) errors.area = "Please enter your area or locality.";
  if (f.address.length < 10) errors.address = "Please enter your complete address — house, street and nearby landmark.";
  return errors;
}

/* ───────── Order reference ───────── */

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreading

/** e.g. "ORD-261020-7KQ4M" — date (YYMMDD) + 5 random characters. */
export function createOrderRef(date = new Date(), random = globalThis.crypto) {
  const ymd = [date.getFullYear() % 100, date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("");
  const bytes = new Uint8Array(5);
  random.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
  return `ORD-${ymd}-${suffix}`;
}

/* ───────── WhatsApp message ───────── */

/**
 * items: [{ name, id, size, color, qty, unitPrice, lineTotal }]
 * totals: { itemCount, subtotal, delivery (number|null), total (number|null) }
 */
export function buildOrderMessage({ ref, form, items, totals }) {
  const f = cleanCheckout(form);
  const phone = normalizePkMobile(f.phone) ?? f.phone;
  const whatsapp = f.whatsapp ? normalizePkMobile(f.whatsapp) ?? f.whatsapp : "";
  const showWhatsapp = whatsapp && whatsapp !== phone;

  const out = [];
  out.push("*NEW FOOTWEAR ORDER*", "", `Order Reference: ${ref}`, "");

  out.push("*CUSTOMER DETAILS*", `Name: ${f.name}`, `Phone: ${phone}`);
  if (showWhatsapp) out.push(`WhatsApp: ${whatsapp}`);
  out.push("");

  out.push("*DELIVERY ADDRESS*", `City: ${f.city}`, `Area: ${f.area}`, `Address: ${f.address}`);
  if (f.instructions) out.push(`Delivery Instructions: ${f.instructions}`);
  out.push("");

  out.push("*ORDER ITEMS*");
  items.forEach((item, i) => {
    out.push(
      "",
      `${i + 1}. ${item.name}`,
      `   Product ID: ${item.id}`,
      `   Size: EU ${item.size}`,
      `   Color: ${item.color}`,
      `   Quantity: ${item.qty}`,
      `   Unit Price: ${formatPKR(item.unitPrice)}`,
      `   Subtotal: ${formatPKR(item.lineTotal)}`,
    );
  });
  out.push("");

  out.push("*ORDER SUMMARY*", `Items: ${totals.itemCount}`, `Subtotal: ${formatPKR(totals.subtotal)}`);
  if (totals.delivery === null) {
    out.push("Delivery: To be confirmed by the store", `Total: ${formatPKR(totals.subtotal)} + delivery (to be confirmed)`);
  } else {
    out.push(`Delivery: ${totals.delivery === 0 ? "Free" : formatPKR(totals.delivery)}`, `Total: ${formatPKR(totals.total)}`);
  }

  if (f.notes) out.push("", `Customer Notes: ${f.notes}`);

  out.push("", "Please confirm product availability, delivery charges, and order acceptance.");
  return out.join("\n");
}

/** https://wa.me/<digits>?text=<encoded> — or null when the store number is not configured. */
export function buildWhatsAppUrl(storeNumber, message) {
  const number = normalizeWhatsAppNumber(storeNumber);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
