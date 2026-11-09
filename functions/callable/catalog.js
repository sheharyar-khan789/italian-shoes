/**
 * Catalogue, product and stock functions for the admin. Each checks a permission on the server.
 */
import { secureCallable } from "../lib/callable.js";
import { hasPermission } from "../lib/callable.js";
import {
  saveCategoryInput,
  saveBrandInput,
  saveColorInput,
  saveSizeInput,
  deleteCatalogItemInput,
  saveProductInput,
  setProductStatusInput,
  saveVariantInput,
  createVariantsInput,
  stockAdjustmentSchema,
  imageActionInput,
} from "../shared/schemas/index.js";
import * as catalog from "../services/catalog.js";
import * as products from "../services/products.js";
import * as inventory from "../services/inventory.js";
import * as images from "../services/images.js";

const WRITE = { auth: /** @type {const} */ ("required"), permission: "products.write", rateLimit: { limit: 240, windowSeconds: 600 } };

export const saveCategory = secureCallable("saveCategory", { ...WRITE, schema: saveCategoryInput }, ({ data, uid }) => catalog.saveCatalogItem("category", data, uid));
export const saveBrand = secureCallable("saveBrand", { ...WRITE, schema: saveBrandInput }, ({ data, uid }) => catalog.saveCatalogItem("brand", data, uid));
export const saveColor = secureCallable("saveColor", { ...WRITE, schema: saveColorInput }, ({ data, uid }) => catalog.saveCatalogItem("color", data, uid));
export const saveSize = secureCallable("saveSize", { ...WRITE, schema: saveSizeInput }, ({ data, uid }) => catalog.saveCatalogItem("size", data, uid));
export const deleteCatalogItem = secureCallable("deleteCatalogItem", { ...WRITE, schema: deleteCatalogItemInput }, ({ data, uid }) =>
  catalog.deleteCatalogItem(data.kind, data.id, uid),
);

export const saveProduct = secureCallable("saveProduct", { ...WRITE, schema: saveProductInput }, ({ data, uid }) => products.saveProduct(data, uid));
export const setProductStatus = secureCallable("setProductStatus", { ...WRITE, schema: setProductStatusInput }, ({ data, uid }) =>
  products.setProductStatus(data.productId, data.status, uid),
);
export const saveVariant = secureCallable("saveVariant", { ...WRITE, schema: saveVariantInput }, ({ data, uid, token }) =>
  products.saveVariant(data, { actorUid: uid, canEditCost: hasPermission(token, "costs.read") }),
);
export const createVariants = secureCallable("createVariants", { ...WRITE, schema: createVariantsInput }, ({ data, uid, token }) =>
  products.createVariants(data, { actorUid: uid, canEditCost: hasPermission(token, "costs.read") }),
);
export const productImageAction = secureCallable("productImageAction", { ...WRITE, schema: imageActionInput }, ({ data, uid }) => images.imageAction(data, uid));

export const adjustStock = secureCallable(
  "adjustStock",
  { auth: "required", permission: "inventory.adjust", schema: stockAdjustmentSchema, rateLimit: { limit: 300, windowSeconds: 600 } },
  ({ data, uid }) => inventory.adjustStock(data, uid),
);
