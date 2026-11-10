/**
 * Calls the store's server endpoints (/api/<name>, running on Vercel). Every request carries the
 * signed-in person's Firebase ID token; the server verifies it and decides what that person may do.
 * Nothing price-related is trusted from here: the server recalculates it.
 *
 * Errors keep the same shape the screens already handle: { code: "functions/<code>", message, details }.
 */
import { firebase } from "./firebase.js";

/** @param {string} name @param {unknown} [data] @returns {Promise<any>} */
export async function callApi(name, data) {
  const { auth } = await firebase();
  const headers = { "Content-Type": "application/json" };
  const user = auth.currentUser;
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;

  /** @type {Response} */
  let res;
  try {
    res = await fetch(`/api/${encodeURIComponent(name)}`, { method: "POST", headers, body: JSON.stringify({ data: data ?? null }), signal: AbortSignal.timeout(30000) });
  } catch {
    throw apiError("unavailable", "Couldn't reach the store. Check your connection and try again.");
  }
  /** @type {any} */
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON reply (e.g. a platform error page) */
  }
  if (!res.ok) {
    const e = json?.error;
    throw apiError(e?.code ?? "internal", e?.message ?? "Something went wrong. Please try again.", e?.details);
  }
  return json?.data ?? null;
}

/** @param {string} code @param {string} message @param {unknown} [details] */
function apiError(code, message, details) {
  return Object.assign(new Error(message), { code: `functions/${code}`, details });
}
