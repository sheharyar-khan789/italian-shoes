/**
 * Browser Firebase setup. Lazy: nothing loads until a page first needs Auth, Firestore or Functions,
 * so the storefront's first paint is not slowed by the SDK.
 *
 * Development (`npm run dev`) talks to the local emulators by default, so working on the site can
 * never touch live data. Set VITE_FIREBASE_TARGET=production in .env.local to point dev at the
 * real project; production builds always use the real project.
 */
import { FIREBASE_WEB_CONFIG, EMULATOR_PROJECT_ID, EMULATOR_PORTS, FUNCTIONS_REGION } from "./firebase-config.js";

export const usingEmulators = import.meta.env.DEV && import.meta.env.VITE_FIREBASE_TARGET !== "production";

/** @type {Promise<{ app: import("firebase/app").FirebaseApp, auth: import("firebase/auth").Auth, db: import("firebase/firestore").Firestore, functions: import("firebase/functions").Functions }> | null} */
let ready = null;

export function firebase() {
  ready ??= (async () => {
    const [{ initializeApp }, authMod, fsMod, fnMod] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
      import("firebase/firestore"),
      import("firebase/functions"),
    ]);
    // In the emulators the default bucket is "<project>.appspot.com"; uploads must go there for the
    // image function (a Storage trigger on the default bucket) to see them.
    const config = usingEmulators
      ? { ...FIREBASE_WEB_CONFIG, projectId: EMULATOR_PROJECT_ID, storageBucket: `${EMULATOR_PROJECT_ID}.appspot.com` }
      : FIREBASE_WEB_CONFIG;
    const app = initializeApp(config);

    // App Check proves requests come from this website, not a script. Enabled when a reCAPTCHA
    // Enterprise site key is configured (VITE_APPCHECK_SITE_KEY — public, not a secret). See SECURITY.md.
    const appCheckKey = import.meta.env.VITE_APPCHECK_SITE_KEY;
    if (appCheckKey && !usingEmulators) {
      const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import("firebase/app-check");
      initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckKey), isTokenAutoRefreshEnabled: true });
    }

    // initializeAuth without a popup/redirect resolver: email + password only, so the SDK never
    // loads a hidden iframe (keeps the CSP's frame-src 'none'). Sessions persist across reloads.
    const auth = authMod.initializeAuth(app, { persistence: [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence] });
    const db = fsMod.getFirestore(app);
    const functions = fnMod.getFunctions(app, FUNCTIONS_REGION);

    if (usingEmulators) {
      const host = location.hostname;
      authMod.connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
      fsMod.connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
      fnMod.connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
    }
    return { app, auth, db, functions };
  })();
  return ready;
}

/** @type {Promise<import("firebase/storage").FirebaseStorage> | null} */
let storageReady = null;

/** Cloud Storage — loaded only by the admin (photo uploads), never by shoppers. */
export function storage() {
  storageReady ??= (async () => {
    const { app } = await firebase();
    const { getStorage, connectStorageEmulator } = await import("firebase/storage");
    const s = getStorage(app);
    if (usingEmulators) connectStorageEmulator(s, location.hostname, EMULATOR_PORTS.storage);
    return s;
  })();
  return storageReady;
}

/** Public URL of a processed product photo (Storage rules allow public reads of images/). */
export function imageUrl(path) {
  const bucket = usingEmulators ? `${EMULATOR_PROJECT_ID}.appspot.com` : FIREBASE_WEB_CONFIG.storageBucket;
  const base = usingEmulators ? `http://${location.hostname}:${EMULATOR_PORTS.storage}` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}
