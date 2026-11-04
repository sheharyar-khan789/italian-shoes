/**
 * Firebase web app configuration for the "italianshoes" project.
 *
 * These values are PUBLIC by design — every Firebase website ships them to the browser.
 * They identify the project; they do not grant access. Access is controlled by Firestore and
 * Storage security rules and by Cloud Functions checks. For extra protection, restrict this API key
 * to the site's domains in Google Cloud Console → APIs & Services → Credentials.
 *
 * Never put a service-account key (the "firebase-adminsdk" JSON file) in this file or anywhere in
 * the browser code.
 */
export const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyAhitYaHNfUFjXAFRpJ4YuMuZDIvGaEwbM",
  authDomain: "italianshoes.firebaseapp.com",
  projectId: "italianshoes",
  storageBucket: "italianshoes.firebasestorage.app",
  messagingSenderId: "886268566826",
  appId: "1:886268566826:web:ed7b195e5976a38ec7d253",
  // measurementId (Google Analytics) is intentionally left out: analytics needs a cookie-consent
  // banner and a privacy-policy update first. Value from the console: G-JC0HYSL6Z3
};

/** "demo-" project ids make the emulators refuse to reach any real Google service. */
export const EMULATOR_PROJECT_ID = "demo-italianshoes";

export const EMULATOR_PORTS = { auth: 9099, firestore: 8080, functions: 5001, storage: 9199 };

/** Must match setGlobalOptions({ region }) in functions/index.js. */
export const FUNCTIONS_REGION = "asia-south1";
