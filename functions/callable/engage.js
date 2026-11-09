/**
 * Reviews, customers, website content and reports. Staff functions check a permission on the server.
 */
import { secureCallable } from "../lib/callable.js";
import {
  submitReviewInput, moderateReviewInput, deleteReviewInput, setCustomerDisabledInput,
  saveBannerInput, saveFaqInput, savePageInput, deletePageInput, saveHomeInput, deleteContentInput, reportRangeInput,
} from "../shared/schemas/index.js";
import * as reviews from "../services/reviews.js";
import * as customers from "../services/customers.js";
import * as content from "../services/content.js";
import * as reports from "../services/reports.js";

const staff = (permission, limit = 240) => ({ auth: /** @type {const} */ ("required"), permission, rateLimit: { limit, windowSeconds: 600 } });

export const submitReview = secureCallable("submitReview", { auth: "required", schema: submitReviewInput, rateLimit: { limit: 20, windowSeconds: 3600 } }, ({ data, uid }) => reviews.submitReview(data, { uid }));
export const moderateReview = secureCallable("moderateReview", { ...staff("reviews.moderate"), schema: moderateReviewInput }, ({ data, uid }) => reviews.moderateReview(data, uid));
export const deleteReview = secureCallable("deleteReview", { ...staff("reviews.moderate"), schema: deleteReviewInput }, ({ data, uid }) => reviews.deleteReview(data.reviewId, uid));

export const setCustomerDisabled = secureCallable("setCustomerDisabled", { ...staff("customers.manage", 60), schema: setCustomerDisabledInput }, ({ data, uid }) => customers.setCustomerDisabled(data, uid));

const CONTENT = staff("content.manage");
export const saveBanner = secureCallable("saveBanner", { ...CONTENT, schema: saveBannerInput }, ({ data, uid }) => content.saveBanner(data, uid));
export const saveFaq = secureCallable("saveFaq", { ...CONTENT, schema: saveFaqInput }, ({ data, uid }) => content.saveFaq(data, uid));
export const savePage = secureCallable("savePage", { ...CONTENT, schema: savePageInput }, ({ data, uid }) => content.savePage(data, uid));
export const deletePage = secureCallable("deletePage", { ...CONTENT, schema: deletePageInput }, ({ data, uid }) => content.deletePage(data.slug, uid));
export const saveHome = secureCallable("saveHome", { ...CONTENT, schema: saveHomeInput }, ({ data, uid }) => content.saveHome(data, uid));
export const deleteContentItem = secureCallable("deleteContentItem", { ...CONTENT, schema: deleteContentInput }, ({ data, uid }) => content.deleteContent(data.kind, data.id, uid));

export const salesReport = secureCallable("salesReport", { ...staff("reports.sales", 60), schema: reportRangeInput }, ({ data }) => reports.salesReport(data));
export const inventoryReport = secureCallable("inventoryReport", staff("reports.inventory", 60), () => reports.inventoryReport());
