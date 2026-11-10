/**
 * Browser Firebase setup. Lazy: nothing loads until a page first needs Auth, Firestore or Functions,
 * so the storefront's first paint is not slowed by the SDK.
 *
 * Development (`npm run dev`) talks to the local emulators by default, so working on the site can
 * never touch live data. Set VITE_FIREBASE_TARGET=production in .env.local to point dev at the
 * real project; production builds always use the real project.
 */
import { FIREBASE_WEB_CONFIG, EMULATOR_PROJECT_ID, EMULATOR_PORTS } from "./firebase-config.js";

export const usingEmulators = import.meta.env.DEV && import.meta.env.VITE_FIREBASE_TARGET !== "production";

/** @type {Promise<{ app: import("firebase/app").FirebaseApp, auth: import("firebase/auth").Auth, db: import("firebase/firestore").Firestore }> | null} */
let ready = null;

export function firebase() {
  ready ??= (async () => {
    const [{ initializeApp }, authMod, fsMod] = await Promise.all([import("firebase/app"), import("firebase/auth"), import("firebase/firestore")]);
    const config = usingEmulators
      ? { ...FIREBASE_WEB_CONFIG, projectId: EMULATOR_PROJECT_ID }
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

    if (usingEmulators) {
      const host = location.hostname;
      authMod.connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
      fsMod.connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
    }
    return { app, auth, db };
  })();
  return ready;
}

/** Public URL of a product photo: the full https address stored with the photo (Vercel Blob). */
export function imageUrl(path) {
  return String(path).startsWith("https://") ? path : "";
}
