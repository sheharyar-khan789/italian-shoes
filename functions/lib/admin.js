/**
 * Firebase Admin SDK, initialised once.
 * In Cloud Functions and the emulators, credentials come from the environment automatically;
 * no service-account key file is used or needed.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const app = getApps()[0] ?? initializeApp();

export const db = getFirestore(app);
export const auth = getAuth(app);
export { FieldValue, Timestamp } from "firebase-admin/firestore";
