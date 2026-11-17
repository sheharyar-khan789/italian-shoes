import { z } from "zod";
import { docId, text, optionalText } from "./common.js";

/** Id of the warehouse that holds all stock that existed before warehouses were introduced. */
export const DEFAULT_WAREHOUSE_ID = "main";

/** Short code printed on labels and transfers: 2–10 capital letters, numbers or hyphens. */
export const WAREHOUSE_CODE = /^[A-Z0-9][A-Z0-9-]{1,9}$/;

const warehouseCode = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(WAREHOUSE_CODE, "2–10 letters, numbers or hyphens, e.g. SHOP-1"));

/** Create or edit a warehouse. Activation is changed separately (it checks stock and open transfers). */
export const saveWarehouseInput = z.object({
  id: docId.optional(),
  name: text(2, 80),
  code: warehouseCode,
  description: optionalText(300),
  address: optionalText(300),
  /** Stock here is counted as available to online customers. */
  sellsOnline: z.boolean().default(true),
});

export const setWarehouseActiveInput = z.object({ id: docId, isActive: z.boolean() });

/** One page of the "recalculate online stock" job (after a warehouse's online setting changed). */
export const rebuildOnlineStockInput = z.object({ cursor: z.string().max(300).nullish() });

/* ───────── Transfers ───────── */

export const TRANSFER_STATUSES = /** @type {const} */ (["draft", "in_transit", "received", "cancelled"]);
export const TRANSFER_MAX_LINES = 100;

export const transferLineInput = z.object({
  productId: docId,
  variantId: docId,
  qty: z.number().int("Whole pairs only").min(1, "At least 1").max(100000, "Too many"),
});

export const saveTransferInput = z
  .object({
    id: docId.optional(),
    fromWarehouseId: docId,
    toWarehouseId: docId,
    note: optionalText(300),
    lines: z.array(transferLineInput).min(1, "Add at least one item").max(TRANSFER_MAX_LINES, `At most ${TRANSFER_MAX_LINES} items per transfer`),
  })
  .refine((t) => t.fromWarehouseId !== t.toWarehouseId, { message: "Choose two different warehouses", path: ["toWarehouseId"] })
  .refine((t) => new Set(t.lines.map((l) => `${l.productId}/${l.variantId}`)).size === t.lines.length, { message: "Each size/colour can appear only once", path: ["lines"] });

export const transferActionInput = z.object({ id: docId });
