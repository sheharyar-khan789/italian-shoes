/** Rupee boxes in the admin: people type rupees, the system stores whole paisa. */
import { rupeesToPaisa } from "../../../shared/money.js";

/** paisa → "12500" (or "12500.5") for an input box; "" when unset */
export const rupeesField = (paisa) => (paisa == null ? "" : String(paisa / 100));

/** "12,500" → paisa; "" → null; unreadable → NaN (which fails validation with a clear message) */
export const toPaisa = (text) => {
  if (String(text).trim() === "") return null;
  try {
    return rupeesToPaisa(text);
  } catch {
    return NaN;
  }
};
