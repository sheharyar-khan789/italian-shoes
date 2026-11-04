/**
 * Security-rules tests. Run with `npm run test:emulator` (starts the emulators automatically).
 * Test identities below exist only inside this test run's emulator; no accounts are created.
 */
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
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
  // Some data written with rules bypassed, as Cloud Functions would.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "roles/owner"), { name: "Owner", permissions: ["staff.manage"] });
    await setDoc(doc(db, "_migrations/001-seed-roles"), { status: "done" });
    await setDoc(doc(db, "orders/o1"), { userId: "customer-a", grandTotal: 100 });
  });
});

const visitor = () => env.unauthenticatedContext();
const customer = () => env.authenticatedContext("customer-a");
// A token claiming staff permissions — what a real staff token will carry from Phase 3.
const staff = () => env.authenticatedContext("staff-x", { staff: true, perms: ["staff.manage", "orders.read", "products.write"] });

const PATHS = ["roles/owner", "_migrations/001-seed-roles", "orders/o1", "products/p1", "inventory/v1", "users/customer-a", "settings/public"];

test("nobody can read anything yet (deny by default)", async () => {
  for (const who of [visitor, customer, staff]) {
    const db = who().firestore();
    for (const path of PATHS) await assertFails(getDoc(doc(db, path)));
    await assertFails(getDocs(collection(db, "orders")));
  }
});

test("nobody can write anything yet, including a customer writing their own order or price", async () => {
  for (const who of [visitor, customer, staff]) {
    const db = who().firestore();
    await assertFails(setDoc(doc(db, "orders/o2"), { userId: "customer-a", grandTotal: 1 }));
    await assertFails(setDoc(doc(db, "inventory/v1"), { onHand: 999 }));
    await assertFails(setDoc(doc(db, "roles/owner"), { permissions: [] }));
    await assertFails(setDoc(doc(db, "users/customer-a"), { name: "x" }));
  }
});

test("storage denies uploads and downloads by default", async () => {
  for (const who of [visitor, customer, staff]) {
    const storage = who().storage();
    await assertFails(uploadString(ref(storage, "products/p1/a.jpg"), "data"));
    await assertFails(getBytes(ref(storage, "products/p1/a.jpg")));
  }
});
