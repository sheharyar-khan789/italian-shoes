/**
 * Friendly messages for Firebase Auth errors.
 * Sign-in failures always say the same thing, so the site never reveals whether an email has an account.
 */
const MESSAGES = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-login-credentials": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/email-already-in-use": "An account with this email already exists. Try signing in, or reset your password.",
  "auth/weak-password": "Please choose a stronger password.",
  "auth/password-does-not-meet-requirements": "Please choose a stronger password.",
  "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "auth/user-disabled": "This account has been disabled. Please contact the store.",
  "auth/requires-recent-login": "For your security, please enter your current password again.",
  "auth/network-request-failed": "Can't reach the server. Check your internet connection and try again.",
  "auth/expired-action-code": "This link has expired. Please request a new one.",
  "auth/invalid-action-code": "This link is invalid or has already been used.",
  "auth/missing-password": "Enter your password.",
};

/** Callable-function error codes (from Cloud Functions) also arrive here. */
const FUNCTION_CODES = new Set([
  "functions/invalid-argument",
  "functions/failed-precondition",
  "functions/permission-denied",
  "functions/already-exists",
  "functions/not-found",
  "functions/resource-exhausted",
  "functions/unauthenticated",
]);

/** @param {unknown} error */
export function friendlyAuthError(error) {
  const code = /** @type {{code?: string}} */ (error)?.code ?? "";
  if (code in MESSAGES) return MESSAGES[code];
  // Messages from our own functions are written to be shown (see functions/lib/errors.js).
  if (FUNCTION_CODES.has(code)) return /** @type {Error} */ (error).message;
  return "Something went wrong. Please try again.";
}
