/**
 * Warehouse and stock-transfer endpoints. Each checks a permission on the server; stock itself is only
 * ever changed by services/inventory.js (called from the transfer service).
 */
import { secureCallable } from "../lib/callable.js";
import { saveWarehouseInput, setWarehouseActiveInput, rebuildOnlineStockInput, saveTransferInput, transferActionInput } from "../shared/schemas/index.js";
import * as warehouses from "../services/warehouses.js";
import * as transfers from "../services/transfers.js";
import * as inventory from "../services/inventory.js";

const WAREHOUSES = { auth: /** @type {const} */ ("required"), permission: "warehouses.manage", rateLimit: { limit: 120, windowSeconds: 600 } };
const TRANSFERS = { auth: /** @type {const} */ ("required"), permission: "transfers.manage", rateLimit: { limit: 240, windowSeconds: 600 } };

export const saveWarehouse = secureCallable("saveWarehouse", { ...WAREHOUSES, schema: saveWarehouseInput }, ({ data, uid }) => warehouses.saveWarehouse(data, uid));
export const ensureDefaultWarehouse = secureCallable("ensureDefaultWarehouse", { ...WAREHOUSES, rateLimit: { limit: 20, windowSeconds: 600 } }, ({ uid }) => warehouses.ensureDefaultWarehouse(uid));
export const setWarehouseActive = secureCallable("setWarehouseActive", { ...WAREHOUSES, schema: setWarehouseActiveInput }, ({ data, uid }) => warehouses.setWarehouseActive(data, uid));
export const rebuildOnlineStock = secureCallable("rebuildOnlineStock", { ...WAREHOUSES, rateLimit: { limit: 600, windowSeconds: 600 }, schema: rebuildOnlineStockInput }, ({ data }) => inventory.rebuildOnlineStock(data));

export const saveTransfer = secureCallable("saveTransfer", { ...TRANSFERS, schema: saveTransferInput }, ({ data, uid }) => transfers.saveTransfer(data, uid));
export const sendTransfer = secureCallable("sendTransfer", { ...TRANSFERS, schema: transferActionInput }, ({ data, uid }) => transfers.sendTransfer(data, uid));
export const receiveTransfer = secureCallable("receiveTransfer", { ...TRANSFERS, schema: transferActionInput }, ({ data, uid }) => transfers.receiveTransfer(data, uid));
export const cancelTransfer = secureCallable("cancelTransfer", { ...TRANSFERS, schema: transferActionInput }, ({ data, uid }) => transfers.cancelTransfer(data, uid));
