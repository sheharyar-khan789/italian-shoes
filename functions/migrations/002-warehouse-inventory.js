/**
 * Warehouse migration: gives every existing inventory document a per-warehouse breakdown, putting ALL existing
 * stock in the default warehouse ("main"). Nothing is deleted and no quantity changes.
 *
 *   before   inventory/{id} { onHand: 12, reserved: 1, … }                    (no byWarehouse)
 *   after    inventory/{id} { onHand: 12, reserved: 1, …,                     (unchanged)
 *                             byWarehouse: { main: { onHand: 12, reserved: 1 } }, available: 11, totalOnHand: 12 }
 *
 * The stock service already reads a document without `byWarehouse` as "all in the default warehouse", so shop
 * and checkout behave the same before, during and after this migration. Running it is what makes the new
 * warehouse screens and filters complete for old documents.
 *
 * It is NOT in MIGRATIONS (so `npm run migrate` never runs it by accident). Run it with
 * `npm run migrate:warehouses` — a dry run by default.
 *
 * Safety:
 *  - dry run (default) reads everything, reports everything and writes NOTHING;
 *  - only documents that are internally consistent are changed; every other one is reported and left alone;
 *  - each document is updated in its own transaction that re-checks it is still unmigrated, so it can be re-run
 *    at any time (already migrated documents are skipped) and never races with an order;
 *  - after applying, every document is re-read and compared with what it held before.
 */
import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_WAREHOUSE_ID } from "../shared/schemas/warehouses.js";

export const MIGRATION_ID = "002-warehouse-inventory";
const PAGE = 500;
const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{ apply?: boolean, log?: (line: string) => void }} [options]
 */
export async function runWarehouseMigration(db, { apply = false, log = () => {} } = {}) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    alreadyMigrated: 0,
    toMigrate: 0,
    migrated: 0,
    skipped: 0,
    unitsOnHandBefore: 0,
    unitsOnHandAfter: 0,
    defaultWarehouse: /** @type {"exists" | "would-create" | "created"} */ ("exists"),
    problems: {
      badIdOrFields: /** @type {string[]} */ ([]),
      duplicates: /** @type {string[]} */ ([]),
      orphanInventory: /** @type {string[]} */ ([]),
      variantsWithoutInventory: /** @type {string[]} */ ([]),
      invalidQuantities: /** @type {string[]} */ ([]),
      inconsistentWarehouseTotals: /** @type {string[]} */ ([]),
      variantAvailableMismatch: /** @type {string[]} */ ([]),
    },
    verification: { checked: 0, mismatches: /** @type {string[]} */ ([]) },
  };

  // 1. Everything the checks need: variants (for orphan / missing / availability checks) and the default warehouse.
  const [variantSnap, warehouse] = await Promise.all([db.collectionGroup("variants").get(), db.collection("warehouses").doc(DEFAULT_WAREHOUSE_ID).get()]);
  const variants = new Map(variantSnap.docs.map((d) => [`${d.ref.parent.parent?.id}__${d.id}`, d.data()]));
  if (!warehouse.exists) report.defaultWarehouse = "would-create";

  // 2. Scan the inventory.
  const seen = new Map();
  /** @type {{ id: string, onHand: number, reserved: number, safe: boolean, migrated: boolean }[]} */
  const docs = [];
  let last = null;
  for (;;) {
    let q = db.collection("inventory").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const doc of page.docs) {
      report.scanned += 1;
      const d = doc.data();
      const key = `${d.productId}__${d.variantId}`;
      const problems = [];
      if (!d.productId || !d.variantId || doc.id !== key) {
        report.problems.badIdOrFields.push(doc.id);
        problems.push("id");
      } else if (seen.has(key)) {
        report.problems.duplicates.push(doc.id);
        problems.push("duplicate");
      }
      seen.set(key, doc.id);
      if (!variants.has(key)) {
        report.problems.orphanInventory.push(doc.id);
        problems.push("orphan");
      } else {
        const v = variants.get(key);
        if (isCount(d.onHand) && isCount(d.reserved) && v.available !== undefined && v.available !== d.onHand - d.reserved) report.problems.variantAvailableMismatch.push(doc.id);
      }
      if (!isCount(d.onHand) || !isCount(d.reserved) || d.reserved > d.onHand) {
        report.problems.invalidQuantities.push(doc.id);
        problems.push("quantities");
      }
      const migrated = Boolean(d.byWarehouse);
      if (migrated) {
        const sum = Object.values(d.byWarehouse).reduce((n, e) => n + (e.onHand ?? 0), 0);
        if (d.totalOnHand !== undefined && sum !== d.totalOnHand) report.problems.inconsistentWarehouseTotals.push(doc.id);
        report.alreadyMigrated += 1;
      }
      if (isCount(d.onHand)) report.unitsOnHandBefore += d.onHand;
      docs.push({ id: doc.id, onHand: d.onHand, reserved: d.reserved, safe: problems.length === 0, migrated });
    }
    if (page.size < PAGE) break;
    last = page.docs[page.size - 1];
  }
  for (const key of variants.keys()) if (!seen.has(key)) report.problems.variantsWithoutInventory.push(key);

  const pending = docs.filter((d) => !d.migrated && d.safe);
  report.toMigrate = pending.length;
  report.skipped = docs.filter((d) => !d.migrated && !d.safe).length;
  log(`${report.scanned} inventory documents scanned: ${report.alreadyMigrated} already migrated, ${pending.length} to migrate, ${report.skipped} skipped for review.`);

  if (!apply) {
    report.unitsOnHandAfter = report.unitsOnHandBefore;
    return report;
  }

  // 3. Apply. The default warehouse first (create-only: an existing one is never overwritten).
  try {
    await db.collection("warehouses").doc(DEFAULT_WAREHOUSE_ID).create({
      name: "Main warehouse",
      code: "MAIN",
      description: "Holds all the stock that existed before warehouses were added.",
      address: "",
      isActive: true,
      isDefault: true,
      sellsOnline: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    report.defaultWarehouse = "created";
  } catch (error) {
    if (/** @type {{code?: number}} */ (error).code !== 6) throw error;
  }

  for (let i = 0; i < pending.length; i += 10) {
    await Promise.all(
      pending.slice(i, i + 10).map(async (item) => {
        const ref = db.collection("inventory").doc(item.id);
        const done = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const d = snap.data();
          if (!snap.exists || d.byWarehouse) return false; // already migrated by an earlier run or a stock change
          if (!isCount(d.onHand) || !isCount(d.reserved) || d.reserved > d.onHand) return false;
          tx.update(ref, { byWarehouse: { [DEFAULT_WAREHOUSE_ID]: { onHand: d.onHand, reserved: d.reserved } }, available: d.onHand - d.reserved, totalOnHand: d.onHand });
          return true;
        });
        if (done) report.migrated += 1;
      }),
    );
  }

  // 4. Verify: every document still holds exactly the quantities it held before.
  const before = new Map(docs.map((d) => [d.id, d]));
  last = null;
  for (;;) {
    let q = db.collection("inventory").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const doc of page.docs) {
      const d = doc.data();
      const b = before.get(doc.id);
      report.verification.checked += 1;
      if (isCount(d.onHand)) report.unitsOnHandAfter += d.onHand;
      if (b && (d.onHand !== b.onHand || d.reserved !== b.reserved)) report.verification.mismatches.push(`${doc.id}: ${b.onHand}/${b.reserved} → ${d.onHand}/${d.reserved}`);
    }
    if (page.size < PAGE) break;
    last = page.docs[page.size - 1];
  }

  await db.collection("_migrations").doc(MIGRATION_ID).set(
    {
      status: report.verification.mismatches.length ? "done-with-mismatches" : "done",
      description: "Per-warehouse breakdown of existing inventory (all stock in the default warehouse)",
      summary: { scanned: report.scanned, migrated: report.migrated, skipped: report.skipped, unitsOnHandBefore: report.unitsOnHandBefore, unitsOnHandAfter: report.unitsOnHandAfter },
      finishedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return report;
}
