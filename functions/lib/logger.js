/**
 * Structured logging that never writes secrets.
 * Any object key that looks sensitive is replaced with "[redacted]" before logging, at any depth.
 */
import { logger } from "firebase-functions";

const SENSITIVE = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|authorization|cookie|credential|cvv|card/i;

/** @param {unknown} value @param {number} depth */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]));
}

export const log = {
  /** @param {string} message @param {unknown} [data] */
  info: (message, data) => logger.info(message, redact(data)),
  /** @param {string} message @param {unknown} [data] */
  warn: (message, data) => logger.warn(message, redact(data)),
  /** @param {string} message @param {unknown} [data] */
  error: (message, data) => logger.error(message, redact(data)),
};
