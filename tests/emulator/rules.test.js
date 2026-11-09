/**
 * Security-rules tests. Run with `npm run test:emulator` (starts the emulators automatically).
 * The identities below are tokens that exist only inside this test run's emulator; no accounts
 * are created anywhere.
 */
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, serverTimestamp } from "firebase/firestore";
import { ref, uploadString, getBytes } from "firebase/storage";

/** @type {import("@firebase/rules-unit-testing").RulesTestEnvironment} */
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-italianshoes",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
    storage: { rules: readFileSync("storage.rules", "utf8") },
  });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  // Data written with rules bypassed, as Cloud Functions would.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "roles/owner"), { name: "Owner", permissions: ["staff.manage"] });
    await setDoc(doc(db, "_migrations/001-seed-roles"), { status: "done" });
    await setDoc(doc(db, "orders/o1"), { userId: "alice", grandTotal: 100 });
    await setDoc(doc(db, "users/bob"), { name: "Bob Customer", email: "bob@example.com", phone: "" });
    await setDoc(doc(db, "users/bob/addresses/home"), { name: "Bob Customer", phone: "+92 300 1234567", city: "Lahore", area: "Gulberg", line1: "House 1 Street 2", isDefault: true, label: "" });
    await setDoc(doc(db, "staff/owner-1"), { roles: ["owner"], status: "active" });
  });
});

const visitor = () => env.unauthenticatedContext().firestore();
const alice = () => env.authenticatedContext("alice", { email: "alice@example.com" }).firestore();
const supportStaff = () => env.authenticatedContext("staff-x", { email: "x@shop.pk", staff: true, perms: ["customers.read"] }).firestore();
const owner = () => env.authenticatedContext("owner-1", { email: "o@shop.pk", staff: true, perms: ["staff.manage", "customers.read"] }).firestore();
// A customer who forged a "staff" flag but holds no permission list.
const forged = () => env.authenticatedContext("mallory", { email: "m@example.com", staff: true }).firestore();

const newProfile = (extra = {}) => ({ name: "Alice Customer", email: "alice@example.com", phone: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra });
const newAddress = (extra = {}) => ({
  label: "Home",
  name: "Alice Customer",
  phone: "+92 321 7654321",
  city: "Lahore",
  area: "DHA",
  line1: "House 12, Street 4, near the park",
  isDefault: true,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  ...extra,
});

/* ───────── Profiles ───────── */

test("a customer can create and edit their own profile", async () => {
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), newProfile()));
  await assertSucceeds(getDoc(doc(alice(), "users/alice")));
  await assertSucceeds(updateDoc(doc(alice(), "users/alice"), { name: "Alice New", phone: "+92 300 1112223", updatedAt: serverTimestamp() }));
});

test("a customer cannot give themselves extra fields, status or roles", async () => {
  await assertFails(setDoc(doc(alice(), "users/alice"), newProfile({ status: "active" })));
  await assertFails(setDoc(doc(alice(), "users/alice"), newProfile({ roles: ["owner"] })));
  await assertFails(setDoc(doc(alice(), "users/alice"), newProfile({ email: "someone-else@example.com" })), "email must match the token");
  await assertFails(setDoc(doc(alice(), "users/alice"), newProfile({ phone: "12345" })), "phone format");
  await assertFails(setDoc(doc(alice(), "users/alice"), newProfile({ name: "A" })));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), newProfile()));
  await assertFails(updateDoc(doc(alice(), "users/alice"), { email: "new@example.com", updatedAt: serverTimestamp() }), "email is not editable");
  await assertFails(updateDoc(doc(alice(), "users/alice"), { status: "disabled", updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(alice(), "users/alice")));
});

test("customers cannot read or write each other's profile", async () => {
  await assertFails(getDoc(doc(alice(), "users/bob")));
  await assertFails(updateDoc(doc(alice(), "users/bob"), { name: "Hacked", updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(alice(), "users/bob"), newProfile()));
  await assertFails(getDoc(doc(visitor(), "users/bob")));
  await assertFails(getDocs(collection(alice(), "users")), "no listing of customers");
});

test("staff with customers.read can read profiles; a forged staff flag cannot", async () => {
  await assertSucceeds(getDoc(doc(supportStaff(), "users/bob")));
  await assertFails(updateDoc(doc(supportStaff(), "users/bob"), { name: "x", updatedAt: serverTimestamp() }), "read-only for staff");
  await assertFails(getDoc(doc(forged(), "users/bob")));
});

/* ───────── Addresses ───────── */

test("a customer manages only their own addresses", async () => {
  const db = alice();
  await assertSucceeds(setDoc(doc(db, "users/alice/addresses/a1"), newAddress()));
  await assertSucceeds(getDocs(collection(db, "users/alice/addresses")));
  await assertSucceeds(updateDoc(doc(db, "users/alice/addresses/a1"), { city: "Islamabad", updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, "users/alice/addresses/a1")));

  await assertFails(getDocs(collection(db, "users/bob/addresses")));
  await assertFails(getDoc(doc(db, "users/bob/addresses/home")));
  await assertFails(setDoc(doc(db, "users/bob/addresses/x"), newAddress()));
  await assertFails(deleteDoc(doc(db, "users/bob/addresses/home")));
  await assertFails(getDoc(doc(supportStaff(), "users/bob/addresses/home")), "addresses are private even from staff");
});

test("addresses must be valid", async () => {
  const db = alice();
  await assertFails(setDoc(doc(db, "users/alice/addresses/a"), newAddress({ phone: "0300 1234567" })), "must be normalised");
  await assertFails(setDoc(doc(db, "users/alice/addresses/a"), newAddress({ line1: "short" })));
  await assertFails(setDoc(doc(db, "users/alice/addresses/a"), newAddress({ isDefault: "yes" })));
  await assertFails(setDoc(doc(db, "users/alice/addresses/a"), newAddress({ extra: 1 })));
  await assertFails(setDoc(doc(db, "users/alice/addresses/a"), newAddress({ city: "x".repeat(61) })));
});

/* ───────── Staff, roles and server-only data ───────── */

test("staff records and roles are read-only and private", async () => {
  await assertFails(setDoc(doc(alice(), "staff/alice"), { roles: ["owner"], status: "active" }), "nobody can make themselves staff");
  await assertFails(setDoc(doc(owner(), "staff/someone"), { roles: ["owner"] }), "even the Owner changes staff only through the Cloud Function");
  await assertFails(getDoc(doc(alice(), "staff/owner-1")));
  await assertSucceeds(getDoc(doc(owner(), "staff/owner-1")));
  await assertSucceeds(getDoc(doc(supportStaff(), "roles/owner")), "staff can read role definitions");
  await assertFails(getDoc(doc(alice(), "roles/owner")));
  await assertFails(setDoc(doc(owner(), "roles/owner"), { permissions: [] }));
});

test("everything else stays denied", async () => {
  for (const db of [visitor(), alice(), owner()]) {
    for (const path of ["_migrations/001-seed-roles", "products/p1", "inventory/v1", "settings/anything-else", "system/owner", "auditLogs/a", "_rateLimits/x"]) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { x: 1 }));
    }
  }
  await assertSucceeds(getDoc(doc(alice(), "orders/o1")), "a customer reads their own order (Phase 6)");
});

test("storage denies uploads and downloads by default", async () => {
  for (const who of [env.unauthenticatedContext(), env.authenticatedContext("alice"), env.authenticatedContext("owner-1", { staff: true, perms: ["products.write"] })]) {
    const storage = who.storage();
    await assertFails(uploadString(ref(storage, "products/p1/a.jpg"), "data"), "outside the uploads folder");
    await assertFails(getBytes(ref(storage, "products/p1/a.jpg")));
  }
});

/* ───────── Phase 4: settings, notifications, activity log ───────── */

const seedAdminData = () =>
  env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "settings/public"), { storeName: "Italian Shoes" });
    await setDoc(doc(db, "settings/private"), { orderPrefix: "IS", lowStockThreshold: 3 });
    await setDoc(doc(db, "notifications/n1"), { type: "staff.changed", audience: "staff.manage", title: "t", readBy: [] });
    await setDoc(doc(db, "notifications/n2"), { type: "stock.low", audience: "inventory.adjust", title: "t", readBy: [] });
    await setDoc(doc(db, "auditLogs/a1"), { action: "settings.updated", actorUid: "owner-1" });
  });

const stockStaff = () => env.authenticatedContext("stock-1", { staff: true, perms: ["inventory.adjust"] }).firestore();

test("public settings are readable by everyone; private settings only by the Owner; nobody writes either directly", async () => {
  await seedAdminData();
  await assertSucceeds(getDoc(doc(visitor(), "settings/public")));
  await assertFails(getDoc(doc(visitor(), "settings/private")));
  await assertFails(getDoc(doc(supportStaff(), "settings/private")));
  await assertFails(getDoc(doc(owner(), "settings/private")), "this token has staff.manage but not settings.manage");
  const settingsOwner = env.authenticatedContext("owner-1", { staff: true, perms: ["settings.manage"] }).firestore();
  await assertSucceeds(getDoc(doc(settingsOwner, "settings/private")));
  for (const db of [visitor(), alice(), settingsOwner]) {
    await assertFails(setDoc(doc(db, "settings/public"), { storeName: "Hacked" }));
    await assertFails(setDoc(doc(db, "settings/private"), { orderPrefix: "XX" }));
  }
});

test("staff see only notifications for permissions they hold, and can only mark them read for themselves", async () => {
  await seedAdminData();
  const { query, where, arrayUnion } = await import("firebase/firestore");
  await assertSucceeds(getDocs(query(collection(owner(), "notifications"), where("audience", "in", ["staff.manage", "customers.read"]))));
  await assertFails(getDocs(collection(owner(), "notifications")), "unfiltered listing is refused");
  await assertFails(getDoc(doc(owner(), "notifications/n2")), "inventory alert is not for this role");
  await assertSucceeds(getDoc(doc(stockStaff(), "notifications/n2")));
  await assertFails(getDoc(doc(alice(), "notifications/n1")), "customers can't read notifications");

  await assertSucceeds(updateDoc(doc(owner(), "notifications/n1"), { readBy: arrayUnion("owner-1") }));
  await assertFails(updateDoc(doc(owner(), "notifications/n1"), { readBy: ["owner-1", "someone-else"] }), "can't mark read for others");
  await assertFails(updateDoc(doc(owner(), "notifications/n1"), { title: "changed" }));
  await assertFails(setDoc(doc(owner(), "notifications/n9"), { audience: "staff.manage", title: "fake", readBy: [] }));
  await assertFails(deleteDoc(doc(owner(), "notifications/n1")));
});

test("the activity log is readable only with audit.read and never writable", async () => {
  await seedAdminData();
  const auditor = env.authenticatedContext("owner-1", { staff: true, perms: ["audit.read"] }).firestore();
  await assertSucceeds(getDocs(collection(auditor, "auditLogs")));
  await assertFails(getDocs(collection(supportStaff(), "auditLogs")));
  await assertFails(setDoc(doc(auditor, "auditLogs/fake"), { action: "x" }));
  await assertFails(updateDoc(doc(auditor, "auditLogs/a1"), { action: "edited" }));
  await assertFails(deleteDoc(doc(auditor, "auditLogs/a1")));
});

/* ───────── Phase 5: catalogue, stock and photo uploads ───────── */

const seedCatalog = () =>
  env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "categories/formal"), { name: "Formal", slug: "formal" });
    await setDoc(doc(db, "products/live"), { name: "Live", status: "published" });
    await setDoc(doc(db, "products/live/variants/v1"), { price: 100, available: 3 });
    await setDoc(doc(db, "products/draft"), { name: "Draft", status: "draft" });
    await setDoc(doc(db, "products/draft/variants/v1"), { price: 100, available: 3 });
    await setDoc(doc(db, "variantCosts/live__v1"), { costPrice: 60 });
    await setDoc(doc(db, "inventory/live__v1"), { onHand: 3, reserved: 0 });
    await setDoc(doc(db, "stockMovements/m1"), { change: 3 });
    await setDoc(doc(db, "skus/LIVE-1"), { owner: "product:live" });
  });
const catalogStaff = () => env.authenticatedContext("cat-1", { staff: true, perms: ["products.read", "products.write"] }).firestore();
const inventoryStaff = () => env.authenticatedContext("inv-1", { staff: true, perms: ["inventory.read", "inventory.adjust", "costs.read"] }).firestore();

test("shoppers see only published products and their variants; staff see drafts", async () => {
  await seedCatalog();
  const { query, where } = await import("firebase/firestore");
  await assertSucceeds(getDoc(doc(visitor(), "categories/formal")));
  await assertSucceeds(getDoc(doc(visitor(), "products/live")));
  await assertSucceeds(getDoc(doc(visitor(), "products/live/variants/v1")));
  await assertSucceeds(getDocs(query(collection(visitor(), "products"), where("status", "==", "published"))));
  await assertFails(getDocs(collection(visitor(), "products")), "listing must filter to published");
  await assertFails(getDoc(doc(visitor(), "products/draft")));
  await assertFails(getDoc(doc(alice(), "products/draft/variants/v1")));
  await assertSucceeds(getDoc(doc(catalogStaff(), "products/draft")));
  await assertSucceeds(getDoc(doc(catalogStaff(), "products/draft/variants/v1")));
});

test("nobody writes products, prices, stock or SKUs directly — not even staff", async () => {
  await seedCatalog();
  for (const db of [visitor(), alice(), catalogStaff(), inventoryStaff()]) {
    await assertFails(setDoc(doc(db, "products/live"), { name: "x", status: "published" }));
    await assertFails(updateDoc(doc(db, "products/live/variants/v1"), { price: 1 }));
    await assertFails(updateDoc(doc(db, "inventory/live__v1"), { onHand: 999 }));
    await assertFails(setDoc(doc(db, "categories/new"), { name: "x" }));
    await assertFails(setDoc(doc(db, "stockMovements/m2"), { change: 1 }));
    await assertFails(getDoc(doc(db, "skus/LIVE-1")));
  }
});

test("cost prices, stock records and stock history are staff-only, per permission", async () => {
  await seedCatalog();
  await assertSucceeds(getDoc(doc(inventoryStaff(), "variantCosts/live__v1")));
  await assertFails(getDoc(doc(catalogStaff(), "variantCosts/live__v1")), "products.write alone can't see costs");
  await assertFails(getDoc(doc(visitor(), "variantCosts/live__v1")));
  await assertSucceeds(getDoc(doc(inventoryStaff(), "inventory/live__v1")));
  await assertSucceeds(getDocs(collection(inventoryStaff(), "stockMovements")));
  await assertFails(getDoc(doc(alice(), "inventory/live__v1")));
  await assertFails(getDocs(collection(catalogStaff(), "stockMovements")));
});

test("photo uploads: only staff with products.write, only real image types, under 8 MB, own uid recorded", async () => {
  const { uploadBytes } = await import("firebase/storage");
  const file = new Uint8Array(1024);
  const writer = env.authenticatedContext("cat-1", { staff: true, perms: ["products.write"] }).storage();
  const meta = (extra = {}) => ({ contentType: "image/jpeg", customMetadata: { uploadedBy: "cat-1" }, ...extra });

  await assertSucceeds(uploadBytes(ref(writer, "products/p1/uploads/abcdef123456"), file, meta()));
  await assertFails(uploadBytes(ref(writer, "products/p1/uploads/abcdef123457"), file, meta({ contentType: "image/svg+xml" })), "SVG can carry scripts");
  await assertFails(uploadBytes(ref(writer, "products/p1/uploads/abcdef123458"), file, meta({ contentType: "text/html" })));
  await assertFails(uploadBytes(ref(writer, "products/p1/uploads/abcdef123459"), file, meta({ customMetadata: { uploadedBy: "someone-else" } })));
  await assertFails(uploadBytes(ref(writer, "products/p1/uploads/abcdef12345a"), new Uint8Array(8 * 1024 * 1024 + 1), meta()), "over 8 MB");
  await assertFails(uploadBytes(ref(writer, "products/p1/images/abcdef-800.webp"), file, meta()), "processed images are written by the function only");
  await assertFails(getBytes(ref(writer, "products/p1/uploads/abcdef123456")), "originals are never readable");

  const shopper = env.authenticatedContext("alice").storage();
  await assertFails(uploadBytes(ref(shopper, "products/p1/uploads/abcdef12345b"), file, { contentType: "image/jpeg", customMetadata: { uploadedBy: "alice" } }));
  const noPerm = env.authenticatedContext("inv-1", { staff: true, perms: ["inventory.adjust"] }).storage();
  await assertFails(uploadBytes(ref(noPerm, "products/p1/uploads/abcdef12345c"), file, { contentType: "image/jpeg", customMetadata: { uploadedBy: "inv-1" } }));
});

/* ───────── Phase 6: orders ───────── */

const seedOrders = () =>
  env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "orders/oa"), { userId: "alice", number: "IS-1", grandTotal: 100 });
    await setDoc(doc(db, "orders/ob"), { userId: "bob", number: "IS-2", grandTotal: 200 });
    for (const id of ["oa", "ob"]) {
      await setDoc(doc(db, `orders/${id}/history/h1`), { to: "pending" });
      await setDoc(doc(db, `orders/${id}/shipments/s1`), { trackingNumber: "T1" });
      await setDoc(doc(db, `orders/${id}/internalNotes/n1`), { text: "staff only" });
      await setDoc(doc(db, `payments/${id}`), { status: "pending", amount: 1 });
    }
  });
const orderStaff = () => env.authenticatedContext("ord-1", { staff: true, perms: ["orders.read", "orders.update"] }).firestore();

test("customers see only their own orders, history and tracking — never internal notes or payments", async () => {
  await seedOrders();
  const { query, where } = await import("firebase/firestore");
  await assertSucceeds(getDoc(doc(alice(), "orders/oa")));
  await assertSucceeds(getDocs(query(collection(alice(), "orders"), where("userId", "==", "alice"))));
  await assertSucceeds(getDoc(doc(alice(), "orders/oa/history/h1")));
  await assertSucceeds(getDoc(doc(alice(), "orders/oa/shipments/s1")));
  await assertFails(getDoc(doc(alice(), "orders/ob")), "another customer's order");
  await assertFails(getDoc(doc(alice(), "orders/ob/history/h1")));
  await assertFails(getDoc(doc(alice(), "orders/ob/shipments/s1")));
  await assertFails(getDocs(collection(alice(), "orders")), "unfiltered listing");
  await assertFails(getDocs(query(collection(alice(), "orders"), where("userId", "==", "bob"))), "asking for someone else's");
  await assertFails(getDoc(doc(alice(), "orders/oa/internalNotes/n1")), "internal notes are staff-only, even on your own order");
  await assertFails(getDoc(doc(alice(), "payments/oa")));
  await assertFails(getDoc(doc(visitor(), "orders/oa")));
});

test("staff with orders.read see everything about an order; a forged staff flag sees nothing", async () => {
  await seedOrders();
  for (const path of ["orders/oa", "orders/ob", "orders/oa/internalNotes/n1", "orders/ob/history/h1", "payments/ob"]) await assertSucceeds(getDoc(doc(orderStaff(), path)));
  await assertFails(getDoc(doc(forged(), "orders/oa")));
  await assertFails(getDoc(doc(supportStaff(), "orders/oa")), "customers.read isn't orders.read");
});

test("nobody writes orders, history, notes, shipments or payments directly — not even order staff or the order's owner", async () => {
  await seedOrders();
  for (const db of [alice(), orderStaff(), visitor()]) {
    await assertFails(updateDoc(doc(db, "orders/oa"), { status: "delivered" }));
    await assertFails(updateDoc(doc(db, "orders/oa"), { grandTotal: 1 }));
    await assertFails(setDoc(doc(db, "orders/new"), { userId: "alice", grandTotal: 1 }));
    await assertFails(deleteDoc(doc(db, "orders/oa")));
    await assertFails(setDoc(doc(db, "orders/oa/history/h2"), { to: "delivered" }));
    await assertFails(setDoc(doc(db, "orders/oa/internalNotes/n2"), { text: "x" }));
    await assertFails(updateDoc(doc(db, "payments/oa"), { status: "collected" }));
    await assertFails(setDoc(doc(db, "counters/orders"), { next: 1 }));
  }
});

/* ───────── Phase 7: payments and delivery ───────── */

const seedPayments = () =>
  env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "payments/oa"), { status: "collected", amount: 100 });
    await setDoc(doc(db, "payments/oa/transactions/t1"), { type: "collection", amount: 100 });
    await setDoc(doc(db, "paymentMethods/cod"), { isEnabled: true });
    await setDoc(doc(db, "shippingMethods/std"), { name: "Standard", isActive: true });
    await setDoc(doc(db, "shippingRates/std__lahore"), { methodId: "std", city: "Lahore", charge: 20000 });
  });
const payStaff = () => env.authenticatedContext("pay-1", { staff: true, perms: ["payments.update"] }).firestore();
const shipStaff = () => env.authenticatedContext("ship-1", { staff: true, perms: ["shipping.manage"] }).firestore();

test("payment records and history: only staff who handle orders or payments; nobody writes them directly", async () => {
  await seedPayments();
  for (const db of [payStaff(), orderStaff()]) {
    await assertSucceeds(getDoc(doc(db, "payments/oa")));
    await assertSucceeds(getDoc(doc(db, "payments/oa/transactions/t1")));
  }
  for (const db of [alice(), visitor(), shipStaff(), forged()]) {
    await assertFails(getDoc(doc(db, "payments/oa")));
    await assertFails(getDoc(doc(db, "payments/oa/transactions/t1")));
  }
  for (const db of [payStaff(), orderStaff(), alice()]) {
    await assertFails(updateDoc(doc(db, "payments/oa"), { status: "refunded" }));
    await assertFails(setDoc(doc(db, "payments/oa/transactions/t2"), { type: "refund", amount: 100 }));
    await assertFails(setDoc(doc(db, "paymentMethods/cod"), { isEnabled: false }));
  }
});

test("delivery configuration is readable by delivery/order staff only, writable by nobody directly", async () => {
  await seedPayments();
  for (const db of [shipStaff(), orderStaff()]) {
    await assertSucceeds(getDoc(doc(db, "shippingMethods/std")));
    await assertSucceeds(getDoc(doc(db, "shippingRates/std__lahore")));
  }
  for (const db of [alice(), visitor(), supportStaff()]) {
    await assertFails(getDoc(doc(db, "shippingMethods/std")));
    await assertFails(getDoc(doc(db, "shippingRates/std__lahore")));
  }
  await assertSucceeds(getDoc(doc(payStaff(), "paymentMethods/cod")), "any staff may see whether COD is on");
  await assertFails(getDoc(doc(alice(), "paymentMethods/cod")));
  for (const db of [shipStaff(), orderStaff(), alice()]) {
    await assertFails(setDoc(doc(db, "shippingRates/std__lahore"), { charge: 0 }));
    await assertFails(setDoc(doc(db, "shippingMethods/new"), { name: "Free" }));
  }
});

/* ───────── Phase 8: coupons, reviews, content, wishlist ───────── */

const couponStaff = () => env.authenticatedContext("cs", { email: "c@shop.pk", staff: true, perms: ["coupons.manage", "reviews.moderate", "content.manage"] }).firestore();

test("coupons: only coupon managers read them; nobody writes them directly", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), "coupons/SAVE10"), { type: "percent", value: 10, usedCount: 0 }));
  await assertFails(getDoc(doc(visitor(), "coupons/SAVE10")));
  await assertFails(getDoc(doc(alice(), "coupons/SAVE10")));
  await assertFails(getDoc(doc(forged(), "coupons/SAVE10")));
  await assertSucceeds(getDoc(doc(couponStaff(), "coupons/SAVE10")));
  await assertFails(setDoc(doc(couponStaff(), "coupons/NEW"), { type: "percent", value: 99 }));
  await assertFails(updateDoc(doc(alice(), "coupons/SAVE10"), { usedCount: -5 }));
});

test("reviews: public sees approved only; a customer sees their own; nobody writes directly", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "reviews/p1__alice"), { productId: "p1", userId: "alice", status: "pending", rating: 5 });
    await setDoc(doc(db, "reviews/p1__bob"), { productId: "p1", userId: "bob", status: "approved", rating: 4 });
  });
  await assertSucceeds(getDoc(doc(visitor(), "reviews/p1__bob")));
  await assertFails(getDoc(doc(visitor(), "reviews/p1__alice")));
  await assertSucceeds(getDoc(doc(alice(), "reviews/p1__alice")));
  await assertSucceeds(getDoc(doc(couponStaff(), "reviews/p1__alice")));
  await assertFails(setDoc(doc(alice(), "reviews/p1__alice"), { productId: "p1", userId: "alice", status: "approved", rating: 5 }));
  await assertFails(updateDoc(doc(alice(), "reviews/p1__alice"), { status: "approved" }));
});

test("content: visitors see only active/published items; drafts are for content managers; no direct writes", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "banners/on"), { title: "On", isActive: true });
    await setDoc(doc(db, "banners/off"), { title: "Off", isActive: false });
    await setDoc(doc(db, "pages/about"), { title: "About", isPublished: true });
    await setDoc(doc(db, "pages/draft"), { title: "Draft", isPublished: false });
    await setDoc(doc(db, "content/home"), { showBanners: true });
  });
  await assertSucceeds(getDoc(doc(visitor(), "banners/on")));
  await assertFails(getDoc(doc(visitor(), "banners/off")));
  await assertSucceeds(getDoc(doc(visitor(), "pages/about")));
  await assertFails(getDoc(doc(visitor(), "pages/draft")));
  await assertSucceeds(getDoc(doc(couponStaff(), "pages/draft")));
  await assertSucceeds(getDoc(doc(visitor(), "pages/not-written-yet")));
  await assertSucceeds(getDoc(doc(visitor(), "content/home")));
  await assertFails(setDoc(doc(couponStaff(), "pages/x"), { title: "x", isPublished: true }));
  await assertFails(setDoc(doc(visitor(), "content/home"), { showBanners: false }));
});

test("wishlist: only the account holder reads, adds or removes their own entries", async () => {
  const add = (db, uid, pid) => setDoc(doc(db, `users/${uid}/wishlist/${pid}`), { productId: pid, createdAt: serverTimestamp() });
  await assertSucceeds(add(alice(), "alice", "p1"));
  await assertSucceeds(getDoc(doc(alice(), "users/alice/wishlist/p1")));
  await assertFails(add(alice(), "bob", "p1"));
  await assertFails(getDoc(doc(supportStaff(), "users/alice/wishlist/p1")));
  await assertFails(setDoc(doc(alice(), "users/alice/wishlist/p2"), { productId: "other", createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(alice(), "users/alice/wishlist/p3"), { productId: "p3", createdAt: serverTimestamp(), extra: 1 }));
  await assertSucceeds(deleteDoc(doc(alice(), "users/alice/wishlist/p1")));
});
