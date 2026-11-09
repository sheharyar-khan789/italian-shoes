/**
 * Customer and staff session in the browser. Everything that touches Firebase Auth or the
 * customer's own Firestore documents goes through here; views never call the SDK directly.
 *
 * Authorisation is NOT decided here — security rules and Cloud Functions decide. `isStaff` and
 * `perms` only choose what to show.
 */
import { firebase } from "./firebase.js";
import { friendlyAuthError } from "./authErrors.js";
import { signUpSchema, signInSchema, profileSchema, savedAddressSchema, email as emailSchema, passwordSchema, fieldErrors } from "../../shared/schemas/index.js";

/** @typedef {{ uid: string, email: string | null, name: string | null, emailVerified: boolean, isStaff: boolean, roles: string[], perms: string[] }} SessionUser */

/** @type {SessionUser | null} */
let current = null;
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));
const listeners = new Set();
let started = false;

/** Start listening to Firebase Auth (lazy: the SDK loads only when a page needs the session). */
export function startSession() {
  if (started) return ready;
  started = true;
  firebase().then(async ({ auth }) => {
    const { onIdTokenChanged } = await import("firebase/auth");
    onIdTokenChanged(auth, async (user) => {
      if (!user) current = null;
      else {
        const { claims } = await user.getIdTokenResult();
        current = {
          uid: user.uid,
          email: user.email,
          name: user.displayName,
          emailVerified: user.emailVerified,
          isStaff: claims.staff === true,
          roles: Array.isArray(claims.roles) ? claims.roles : [],
          perms: Array.isArray(claims.perms) ? claims.perms : [],
        };
      }
      resolveReady(current);
      listeners.forEach((fn) => fn(current));
    });
  });
  return ready;
}

/** Resolves once Firebase has said whether someone is signed in. */
export const whenReady = () => startSession();
export const currentUser = () => current;
/** @param {(user: SessionUser | null) => void} fn */
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Result shape for forms: either ok, or field errors / one message to show. */
const fail = (message, fields = {}) => ({ ok: false, message, fields });
const invalid = (error) => fail("Please check the highlighted fields.", fieldErrors(error));

/** @param {{ name: string, email: string, phone?: string, password: string }} input */
export async function signUp(input) {
  const parsed = signUpSchema.safeParse({ ...input, phone: input.phone || undefined });
  if (!parsed.success) return invalid(parsed.error);
  const { name, email, phone, password } = parsed.data;
  try {
    const { auth, db } = await firebase();
    const a = await import("firebase/auth");
    const f = await import("firebase/firestore");
    const { user } = await a.createUserWithEmailAndPassword(auth, email, password);
    await a.updateProfile(user, { displayName: name });
    await f.setDoc(f.doc(db, "users", user.uid), {
      name,
      email,
      phone: phone ?? "",
      createdAt: f.serverTimestamp(),
      updatedAt: f.serverTimestamp(),
    });
    await a.sendEmailVerification(user).catch(() => {}); // not fatal: can be resent from the account page
    await user.getIdToken(true);
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

/** @param {{ email: string, password: string }} input */
export async function signIn(input) {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { auth } = await firebase();
    const { signInWithEmailAndPassword } = await import("firebase/auth");
    await signInWithEmailAndPassword(auth, parsed.data.email, parsed.data.password);
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

export async function signOutUser() {
  const { auth } = await firebase();
  const { signOut } = await import("firebase/auth");
  await signOut(auth);
}

/**
 * Always reports success for a well-formed email, whether or not an account exists,
 * so this form can't be used to discover who is a customer.
 * @param {string} rawEmail
 */
export async function requestPasswordReset(rawEmail) {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return fail("Enter a valid email address.", { email: "Enter a valid email address." });
  try {
    const { auth } = await firebase();
    const { sendPasswordResetEmail } = await import("firebase/auth");
    await sendPasswordResetEmail(auth, parsed.data);
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error).code;
    if (code === "auth/too-many-requests" || code === "auth/network-request-failed") return fail(friendlyAuthError(error));
    // user-not-found etc.: deliberately the same response as success
  }
  return { ok: true };
}

export async function resendVerification() {
  try {
    const { auth } = await firebase();
    const { sendEmailVerification } = await import("firebase/auth");
    if (!auth.currentUser) return fail("Please sign in again.");
    await sendEmailVerification(auth.currentUser);
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

/** Re-check verification after the customer clicks the link in their email. */
export async function refreshUser() {
  const { auth } = await firebase();
  if (!auth.currentUser) return;
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
}

/** @param {{ currentPassword: string, newPassword: string }} input */
export async function changePassword({ currentPassword, newPassword }) {
  const strong = passwordSchema.safeParse(newPassword);
  if (!strong.success) return fail("Please choose a stronger password.", { newPassword: strong.error.issues[0].message });
  if (newPassword === currentPassword) return fail("Choose a password different from your current one.", { newPassword: "Must be different" });
  try {
    const { auth } = await firebase();
    const a = await import("firebase/auth");
    const user = auth.currentUser;
    if (!user?.email) return fail("Please sign in again.");
    await a.reauthenticateWithCredential(user, a.EmailAuthProvider.credential(user.email, currentPassword));
    await a.updatePassword(user, newPassword);
    return { ok: true };
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error).code;
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") return fail("Your current password is incorrect.", { currentPassword: "Incorrect password" });
    return fail(friendlyAuthError(error));
  }
}

/* ───────── Profile and addresses (the customer's own documents) ───────── */

async function userDoc() {
  const { db, auth } = await firebase();
  const f = await import("firebase/firestore");
  const uid = auth.currentUser?.uid;
  if (!uid) throw Object.assign(new Error("Not signed in"), { code: "auth/requires-recent-login" });
  return { f, db, uid, ref: f.doc(db, "users", uid) };
}

export async function loadProfile() {
  const { f, ref } = await userDoc();
  const snap = await f.getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

/** @param {{ name: string, phone: string }} input */
export async function saveProfile(input) {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { f, ref } = await userDoc();
    const { auth } = await firebase();
    const { updateProfile } = await import("firebase/auth");
    await f.updateDoc(ref, { name: parsed.data.name, phone: parsed.data.phone, updatedAt: f.serverTimestamp() });
    if (auth.currentUser) await updateProfile(auth.currentUser, { displayName: parsed.data.name });
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

export async function listAddresses() {
  const { f, db, uid } = await userDoc();
  const snap = await f.getDocs(f.query(f.collection(db, "users", uid, "addresses"), f.orderBy("createdAt", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @param {Record<string, unknown>} input @param {string} [id] existing address id */
export async function saveAddress(input, id) {
  const parsed = savedAddressSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { f, db, uid } = await userDoc();
    const col = f.collection(db, "users", uid, "addresses");
    const data = { ...parsed.data, updatedAt: f.serverTimestamp() };
    const batch = f.writeBatch(db);
    if (id) batch.update(f.doc(col, id), data);
    else batch.set(f.doc(col), { ...data, createdAt: f.serverTimestamp() });
    // Only one default address.
    if (parsed.data.isDefault) {
      for (const other of /** @type {Array<{id: string, isDefault?: boolean}>} */ (await listAddresses())) {
        if (other.id !== id && other.isDefault) batch.update(f.doc(col, other.id), { isDefault: false, updatedAt: f.serverTimestamp() });
      }
    }
    await batch.commit();
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

/** @param {string} id */
export async function deleteAddress(id) {
  const { f, db, uid } = await userDoc();
  await f.deleteDoc(f.doc(db, "users", uid, "addresses", id));
}

/* ───────── Staff ───────── */

/** First-time setup: claim the Owner role (the server checks the configured owner email). */
export async function claimOwnership() {
  try {
    const { functions, auth } = await firebase();
    const { httpsCallable } = await import("firebase/functions");
    await httpsCallable(functions, "claimOwner")();
    await auth.currentUser?.getIdToken(true); // pick up the new claims now
    return { ok: true };
  } catch (error) {
    return fail(friendlyAuthError(error));
  }
}

export { safeNext } from "./safeNext.js";
