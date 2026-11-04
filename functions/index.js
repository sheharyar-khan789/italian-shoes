/**
 * Cloud Functions entry point. Every deployed function is exported from here.
 * Business logic lives in services/ (added from Phase 3); this file only wires things up.
 */
import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({
  // Mumbai is the closest Google region to Pakistan. Keep it in the same region as the
  // Firestore database (chosen when the database was created in the Firebase console).
  region: process.env.FUNCTIONS_REGION || "asia-south1",
  // A hard ceiling on parallel instances keeps Blaze costs bounded if traffic spikes or someone abuses an endpoint.
  maxInstances: 10,
});

export { healthCheck } from "./http/health.js";
