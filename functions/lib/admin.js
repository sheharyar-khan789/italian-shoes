/**
 * Firebase Admin SDK, initialised once.
 *
 * On Vercel the credentials come ONLY from server-side environment variables:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * (the private key may contain literal "\n" sequences; they are turned back into line breaks here).
 * In the emulators nothing is needed: a "demo-" project id and the emulator host variables are enough.
 * No service-account file is ever read or committed.
 */
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

/** @returns {import("firebase-admin/app").App} */
function start() {
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: rawKey } = process.env;
  if (clientEmail && rawKey && projectId) {
    // Env-var editors often store the key with "\n" typed out, or wrapped in quotes.
    const privateKey = rawKey.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
    return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  }
  return initializeApp(projectId ? { projectId } : undefined);
}

const app = getApps()[0] ?? start();

export const db = getFirestore(app);
export const auth = getAuth(app);
export { FieldValue, Timestamp } from "firebase-admin/firestore";
