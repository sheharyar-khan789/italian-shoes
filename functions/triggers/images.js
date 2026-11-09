import "../lib/options.js"; // region and limits before any function is created
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { processUpload } from "../services/images.js";

/** Runs when a staff upload lands in products/{productId}/uploads/. Image work needs more memory. */
export const onProductImageUploaded = onObjectFinalized({ memory: "1GiB", timeoutSeconds: 120 }, async (event) => {
  await processUpload(/** @type {any} */ (event.data));
});
