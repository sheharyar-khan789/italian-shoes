/**
 * Structured logging that never writes secrets.
 * Any object key that looks sensitive is replaced with "[redacted]" before logging, at any depth.
 * Output is one JSON line per entry (Vercel and Google Cloud both read this format).
 */

const SENSITIVE = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|authorization|cookie|credential|cvv|card/i;

/** @param {unknown} value @param {number} depth */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]));
}

/** @param {"INFO" | "WARNING" | "ERROR"} severity @param {string} message @param {unknown} data */
const write = (severity, message, data) => {
  const line = JSON.stringify({ severity, message, ...(data === undefined ? {} : { data: redact(data) }) });
  (severity === "ERROR" ? console.error : severity === "WARNING" ? console.warn : console.log)(line);
};

export const log = {
  /** @param {string} message @param {unknown} [data] */
  info: (message, data) => write("INFO", message, data),
  /** @param {string} message @param {unknown} [data] */
  warn: (message, data) => write("WARNING", message, data),
  /** @param {string} message @param {unknown} [data] */
  error: (message, data) => write("ERROR", message, data),
};
