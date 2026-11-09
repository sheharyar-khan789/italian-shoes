/**
 * Global options for every Cloud Function. Imported FIRST by every module that defines a function.
 *
 * Why a separate module: ES modules evaluate their imports before their own body, so calling
 * setGlobalOptions in index.js would run only after the functions had already been created with
 * the default region (us-central1) — the browser, which calls asia-south1, could then never reach them.
 */
import { setGlobalOptions } from "firebase-functions/v2";

export const FUNCTIONS_REGION = process.env.FUNCTIONS_REGION || "asia-south1";

setGlobalOptions({
  // Mumbai is the closest Google region to Pakistan. Keep it in the same region as the
  // Firestore database, and in step with FUNCTIONS_REGION in src/app/firebase-config.js.
  region: FUNCTIONS_REGION,
  // A hard ceiling on parallel instances keeps Blaze costs bounded if traffic spikes or someone abuses an endpoint.
  maxInstances: 10,
});
