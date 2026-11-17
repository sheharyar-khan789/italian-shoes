/**
 * Warehouses (stock locations). The ONLY code that creates or changes them.
 *
 *   warehouses/{id}   name, code (unique), description, address, isActive, isDefault, sellsOnline
 *
 * The default warehouse has the id "main". It holds all stock that existed before warehouses were added and
 * can be renamed but never switched off. A warehouse can only be switched off while it holds no stock and has
 * no open transfer, so stock can't be stranded in a location nobody can use.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { DEFAULT_WAREHOUSE_ID } from "../shared/schemas/warehouses.js";

const warehouses = () => db.collection("warehouses");
export const MAX_WAREHOUSES = 20;

/**
 * Make sure the default warehouse document exists (the stock service already treats it as existing).
 * Creating it again is harmless. No quantities are touched.
 * @param {string | null} [actorUid]
 */
export async function ensureDefaultWarehouse(actorUid = null) {
  try {
    await warehouses().doc(DEFAULT_WAREHOUSE_ID).create({
      name: "Main warehouse",
      code: "MAIN",
      description: "Holds all the stock that existed before warehouses were added.",
      address: "",
      isActive: true,
      isDefault: true,
      sellsOnline: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    });
    return { created: true };
  } catch (error) {
    // 6 = ALREADY_EXISTS: nothing to do.
    if (/** @type {{code?: number}} */ (error).code !== 6) throw error;
    return { created: false };
  }
}

/**
 * Create or edit a warehouse.
 * @param {Record<string, any> & { id?: string }} input validated saveWarehouseInput
 * @param {string} actorUid
 * @returns {Promise<{ id: string, needsRebuild: boolean }>} needsRebuild: the "sells online" setting changed, so online totals must be recalculated
 */
export async function saveWarehouse(input, actorUid) {
  const { id, ...data } = input;
  await ensureDefaultWarehouse(actorUid);
  const ref = id ? warehouses().doc(id) : warehouses().doc();
  let needsRebuild = false;

  await db.runTransaction(async (tx) => {
    const [current, clash, all] = await Promise.all([id ? tx.get(ref) : null, tx.get(warehouses().where("code", "==", data.code).limit(2)), id ? null : tx.get(warehouses().select())]);
    if (id && !current.exists) throw new AppError("not-found", "That warehouse no longer exists.");
    if (clash.docs.some((d) => d.id !== ref.id)) throw new AppError("already-exists", `The code ${data.code} is already used by another warehouse.`, { fields: { code: "Already used" } });
    if (all && all.size >= MAX_WAREHOUSES) throw new AppError("failed-precondition", `A store can have at most ${MAX_WAREHOUSES} warehouses.`);
    const isDefault = ref.id === DEFAULT_WAREHOUSE_ID;
    if (isDefault && data.sellsOnline === false) {
      throw new AppError("failed-precondition", "The default warehouse must stay available to online customers.", { fields: { sellsOnline: "Can't be turned off" } });
    }

    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (current) {
      needsRebuild = current.data().sellsOnline !== data.sellsOnline;
      tx.update(ref, { ...data, ...stamp });
    } else {
      tx.create(ref, { ...data, isActive: true, isDefault: false, ...stamp, createdAt: FieldValue.serverTimestamp(), createdBy: actorUid });
    }
    writeAudit({ actorUid, action: current ? "warehouse.updated" : "warehouse.created", entityType: "warehouse", entityId: ref.id, changes: { after: data } }, tx);
  });
  return { id: ref.id, needsRebuild };
}

/**
 * Switch a warehouse on or off.
 * @param {{ id: string, isActive: boolean }} input
 * @param {string} actorUid
 * @returns {Promise<{ id: string, isActive: boolean, needsRebuild: boolean }>}
 */
export async function setWarehouseActive({ id, isActive }, actorUid) {
  await ensureDefaultWarehouse(actorUid);
  const ref = warehouses().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new AppError("not-found", "That warehouse no longer exists.");
  if (snap.data().isActive === isActive) return { id, isActive, needsRebuild: false };

  if (!isActive) {
    if (id === DEFAULT_WAREHOUSE_ID) throw new AppError("failed-precondition", "The default warehouse can't be switched off.");
    // Stock held here (stock at 0 is fine) and transfers that still need it would be stranded.
    const [holdsStock, from, to] = await Promise.all([
      db.collection("inventory").where(`byWarehouse.${id}.onHand`, ">", 0).limit(1).get(),
      db.collection("stockTransfers").where("fromWarehouseId", "==", id).get(),
      db.collection("stockTransfers").where("toWarehouseId", "==", id).get(),
    ]);
    if (!holdsStock.empty) throw new AppError("failed-precondition", "This warehouse still holds stock. Move it to another warehouse first (a stock transfer), then switch it off.");
    if ([...from.docs, ...to.docs].some((d) => ["draft", "in_transit"].includes(d.data().status))) {
      throw new AppError("failed-precondition", "This warehouse has a transfer that isn't finished. Receive or cancel it first.");
    }
  }
  await db.runTransaction(async (tx) => {
    tx.update(ref, { isActive, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
    writeAudit({ actorUid, action: isActive ? "warehouse.activated" : "warehouse.deactivated", entityType: "warehouse", entityId: id, changes: { isActive } }, tx);
  });
  return { id, isActive, needsRebuild: isActive };
}
