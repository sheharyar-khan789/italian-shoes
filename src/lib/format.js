const pkr = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });

/** 12500 → "Rs. 12,500" */
export const formatPKR = (amount) => `Rs. ${pkr.format(Math.round(Number(amount) || 0))}`;

export const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escape any text before it goes into an HTML template. */
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
