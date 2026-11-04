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
    const config = usingEmulators ? { ...FIREBASE_WEB_CONFIG, projectId: EMULATOR_PROJECT_ID } : FIREBASE_WEB_CONFIG;
    const app = initializeApp(config);
    const auth = authMod.getAuth(app);
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
