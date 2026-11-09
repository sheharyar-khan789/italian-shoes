/**
 * Cloud Functions entry point. Every deployed function is exported from here.
 * Business logic lives in services/; this file only wires things up.
 */
import "./lib/options.js"; // must stay first: sets region and limits before any function is created

export { healthCheck } from "./http/health.js";
export { claimOwner, setStaffRoles } from "./callable/staff.js";
export { saveSettings } from "./callable/settings.js";
export {
  saveCategory,
  saveBrand,
  saveColor,
  saveSize,
  deleteCatalogItem,
  saveProduct,
  setProductStatus,
  saveVariant,
  createVariants,
  productImageAction,
  adjustStock,
} from "./callable/catalog.js";
export { quoteCheckout, placeOrder, cancelMyOrder, updateOrderStatus, addOrderNote, addShipment, exportOrders } from "./callable/orders.js";
export { recordCollection, recordRefund, setPaymentMethod, saveShippingMethod, saveShippingRate, deleteShippingItem } from "./callable/payments.js";
export { onProductImageUploaded } from "./triggers/images.js";
export { saveCoupon, deleteCoupon } from "./callable/coupons.js";
export { submitReview, moderateReview, deleteReview, setCustomerDisabled, saveBanner, saveFaq, savePage, deletePage, saveHome, deleteContentItem, salesReport, inventoryReport } from "./callable/engage.js";
