/**
 * Stock. The ONLY code that changes inventory. Used for manual adjustments (below) and by the
 * order service for sales, cancellations and returns, so every path obeys the same rules.
 * Every change:
 *   - happens in a Firestore transaction, so two changes at once can't lose an update;
 *   - refuses to take stock below zero or below what is reserved for pending orders;
 *   - writes an append-only stockMovements record (who, how much, before → after, why);
 *   - keeps the variant's public `available` count in step;
 *   - raises a notification when a variant crosses the low-stock level or runs out.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import { inventoryId, recomputeSummary } from "./products.js";

/**
 * Read everything a stock change needs. Call BEFORE any write in the transaction.
 * @param {FirebaseFirestore.Transaction} tx
 */
export async function readStock(tx, productId, variantId) {
  const invRef = db.collection("inventory").doc(inventoryId(productId, variantId));
  const productRef = db.collection("products").doc(productId);
  const variantRef = productRef.collection("variants").doc(variantId);
  const [inv, variant, product] = await Promise.all([tx.get(invRef), tx.get(variantRef), tx.get(productRef)]);
  return { productId, variantId, invRef, variantRef, inv, variant, product };
}

/** Units a customer could buy right now. */
export const availableOf = (stock) => (stock.inv.exists ? stock.inv.data().onHand - stock.inv.data().reserved : 0);

/**
 * Apply a stock change inside a transaction (writes only; `stock` comes from readStock).
 * @param {FirebaseFirestore.Transaction} tx
 * @param {Awaited<ReturnType<typeof readStock>>} stock
 * @param {{ change: number, reason: string, note?: string, orderId?: string | null, actorUid: string, settings?: Record<string, any> | undefined }} change
 */
export function writeStockChange(tx, stock, { change, reason, note = "", orderId = null, actorUid, settings }) {
  const { inv, variant, product, invRef, variantRef, productId, variantId } = stock;
  if (!inv.exists || !variant.exists) throw new AppError("not-found", "That size/colour no longer exists.");

  const { onHand, reserved } = /** @type {{onHand: number, reserved: number}} */ (inv.data());
  const nextOnHand = onHand + change;
  if (nextOnHand < 0) throw new AppError("failed-precondition", `Only ${onHand} in stock — you can't remove ${-change}.`);
  if (nextOnHand < reserved) throw new AppError("failed-precondition", `${reserved} of these are reserved for pending orders, so stock can't go below ${reserved}.`);

  const before = onHand - reserved;
  const after = nextOnHand - reserved;
  const movementRef = db.collection("stockMovements").doc();
  tx.update(invRef, { onHand: nextOnHand, updatedAt: FieldValue.serverTimestamp() });
  tx.update(variantRef, { available: after });
  tx.create(movementRef, {
    inventoryId: invRef.id,
    productId,
    variantId,
    productName: product.data()?.name ?? "",
    variantLabel: `${variant.data().colorName ?? ""} / ${variant.data().sizeLabel ?? ""}`,
    sku: variant.data().sku,
    change,
    onHandBefore: onHand,
    onHandAfter: nextOnHand,
    reason,
    note,
    orderId,
    actorUid,
    at: FieldValue.serverTimestamp(),
  });

  // Alerts when crossing a line (not on every change below it).
  const threshold = inv.data().lowStockThreshold ?? settings?.lowStockThreshold ?? null;
  const wantsAlerts = settings?.notifyLowStock !== false;
  const label = `${product.data()?.name ?? "Product"} — ${variant.data().colorName ?? ""} ${variant.data().sizeLabel ?? ""}`.trim();
  if (wantsAlerts && variant.data().isActive) {
    if (after === 0 && before > 0) {
      notify({ type: "stock.out", audience: "inventory.adjust", title: `Sold out: ${label}`, link: "/admin/inventory", data: { productId, variantId } }, tx);
    } else if (threshold !== null && after > 0 && after <= threshold && before > threshold) {
      notify({ type: "stock.low", audience: "inventory.adjust", title: `Low stock (${after} left): ${label}`, link: "/admin/inventory", data: { productId, variantId, available: after } }, tx);
    }
  }
  return { onHand: nextOnHand, available: after };
}

/**
 * Manual stock adjustment by staff.
 * @param {{ productId: string, variantId: string, change: number, reason: string, note?: string }} input validated stockAdjustmentSchema
 * @param {string} actorUid
 */
export async function adjustStock(input, actorUid) {
  const { productId, variantId, change, reason, note = "" } = input;
  const settingsRef = db.collection("settings").doc("private");

  const result = await db.runTransaction(async (tx) => {
    const [stock, settings] = await Promise.all([readStock(tx, productId, variantId), tx.get(settingsRef)]);
    return writeStockChange(tx, stock, { change, reason, note, actorUid, settings: settings.data() });
  });

  await recomputeSummary(productId);
  return result;
}
