/**
 * Fixtures for the browser tests: people, a tiny catalogue and a shop warehouse, created in the LOCAL EMULATORS only
 * (the runner refuses to start without the emulator variables and a "demo-" project). Passwords are random per run and
 * handed to the tests through the environment; they exist nowhere else.
 */
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const PROJECT = "demo-italianshoes";

export async function seed() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run through `npm run e2e` (emulators required).");
  process.env.GCLOUD_PROJECT = PROJECT;
  const fs = process.env.FIRESTORE_EMULATOR_HOST;
  const au = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await fetch(`http://${fs}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://${au}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });

  // The default roles (Owner, cashier, …) are created by the same migration the real database uses.
  await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, "../../functions/scripts/migrate.mjs")], { env: { ...process.env, GCLOUD_PROJECT: PROJECT } });

  const { auth, db } = await import("../../functions/lib/admin.js");
  const staff = await import("../../functions/services/staff.js");
  const pos = await import("../../functions/services/pos.js");
  const catalog = await import("../../functions/services/catalog.js");
  const products = await import("../../functions/services/products.js");
  const inventory = await import("../../functions/services/inventory.js");
  const warehouses = await import("../../functions/services/warehouses.js");
  const accounting = await import("../../functions/services/accounting.js");
  const schemas = await import("../../functions/shared/schemas/index.js");

  const password = () => `Aa1-${randomBytes(9).toString("base64url")}`;
  const people = {};
  for (const [key, name] of [["owner", "Test Owner"], ["cashier", "Test Cashier"], ["customer", "Test Customer"]]) {
    const pw = password();
    const u = await auth.createUser({ email: `e2e-${key}@example.test`, password: pw, displayName: name, emailVerified: true });
    people[key] = { uid: u.uid, email: u.email, password: pw, name };
  }
  await staff.setStaffRoles({ uid: people.owner.uid, roles: ["owner"], actorUid: people.owner.uid });
  await pos.createPosRoles(people.owner.uid);
  await staff.setStaffRoles({ uid: people.cashier.uid, roles: ["cashier"], actorUid: people.owner.uid });

  await db.doc("settings/public").set({ storeName: "E2E Test Store", phone: "0300 1112223", address: "Test Road", isOpen: true, currency: "PKR" });
  await db.doc("settings/private").set({ orderPrefix: "IS", lowStockThreshold: 2, notifyLowStock: true, taxEnabled: false });
  const actor = people.owner.uid;
  const cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), actor)).id;
  const black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, actor)).id;
  const s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, actor)).id;
  const shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), actor)).id;
  await accounting.initializeAccounting(actor);

  const items = {};
  /** @type {[string, string, number, number, number][]} */
  const catalogue = [["oxford-e2e", "E2E Oxford", 20, 1000000, 600000], ["derby-e2e", "E2E Derby", 5, 1500000, 900000]];
  for (const [slug, name, stock, price, cost] of catalogue) {
    const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name, slug, categoryId: cat, sku: slug.toUpperCase() }), actor)).id;
    await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [black], sizeIds: [s42], price, salePrice: null, costPrice: cost }), { actorUid: actor, canEditCost: true });
    const variantId = products.variantKey(black, s42);
    await inventory.adjustStock({ productId, variantId, warehouseId: shop, change: stock, reason: "initial", note: "" }, actor);
    await db.doc(`products/${productId}`).update({ status: "published", images: [{ id: "i", isPrimary: true, alt: "", paths: { 400: "x" } }] });
    items[slug] = { productId, variantId, name, price, stock };
  }
  return { people, items, ids: { cat, black, s42, shop } };
}
