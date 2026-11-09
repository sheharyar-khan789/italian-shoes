/** Calls a Cloud Function (all ordering and review actions run on the server). */
import { firebase } from "./firebase.js";

/** @param {string} name @param {unknown} data @returns {Promise<any>} */
export async function callFn(name, data) {
  const { functions } = await firebase();
  const { httpsCallable } = await import("firebase/functions");
  return (await httpsCallable(functions, name, { timeout: 30000 })(data)).data;
}

/** Safe message from a function error (internal errors never show details). */
export const fnMessage = (error, fallback = "Something went wrong. Please try again.") =>
  /** @type {any} */ (error)?.code && error.code !== "functions/internal" && error.code !== "functions/unknown" ? String(error.message) : fallback;
