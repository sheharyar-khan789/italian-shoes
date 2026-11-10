/** Calls a server endpoint (all ordering and review actions run on the server). */
import { callApi } from "./api.js";

/** @param {string} name @param {unknown} data @returns {Promise<any>} */
export const callFn = (name, data) => callApi(name, data);

/** Safe message from a function error (internal errors never show details). */
export const fnMessage = (error, fallback = "Something went wrong. Please try again.") =>
  /** @type {any} */ (error)?.code && error.code !== "functions/internal" && error.code !== "functions/unknown" ? String(error.message) : fallback;
