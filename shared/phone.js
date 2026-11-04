/** Pakistani phone numbers. Shared by browser forms and Cloud Functions. */

const strip = (value) => String(value ?? "").replace(/[\s\-().]/g, "");

/**
 * Accepts Pakistani mobile numbers: 03XXXXXXXXX, +923XXXXXXXXX, 923XXXXXXXXX, 00923XXXXXXXXX.
 * Returns the canonical "+92 3XX XXXXXXX", or null when invalid.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePkMobile(value) {
  const m = strip(value).match(/^(?:\+92|0092|92|0)(3\d{9})$/);
  if (!m) return null;
  return `+92 ${m[1].slice(0, 3)} ${m[1].slice(3)}`;
}

/** "+92 300 1234567" → "+923001234567" (E.164, for storage and tel: links). */
export const toE164 = (canonical) => canonical.replace(/\s/g, "");
