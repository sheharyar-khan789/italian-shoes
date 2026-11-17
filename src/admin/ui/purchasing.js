/**
 * Small helpers shared by the supplier and purchasing screens: money display, status tags, a form dialog,
 * and printing. Everything dynamic is escaped.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";

/** Rupees for display; negative amounts (a supplier who owes US) are shown with a minus sign. @param {number} paisa */
export const money = (paisa) => (paisa < 0 ? `−${formatPKR(-paisa)}` : formatPKR(paisa ?? 0));

/** @type {Record<string, string[]>} */
export const PO_STATUS = {
  draft: ["Draft", "tag"],
  ordered: ["Ordered", "tag tag--low"],
  partially_received: ["Part received", "tag tag--low"],
  received: ["Received", "tag"],
  closed: ["Closed", "tag"],
  cancelled: ["Cancelled", "tag tag--out"],
};
/** @type {Record<string, string[]>} */
export const PAY_STATUS = { unpaid: ["Unpaid", "tag tag--out"], partial: ["Part paid", "tag tag--low"], paid: ["Paid", "tag"] };

/** @param {Record<string, string[]>} map @param {string} key */
export const tag = (map, key) => `<span class="${map[key]?.[1] ?? "tag"}">${esc(map[key]?.[0] ?? key)}</span>`;

/** A new idempotency key for one button press (reused if the same press is repeated). */
export const newKey = () => crypto.randomUUID().replace(/-/g, "");

/** Today as YYYY-MM-DD in the browser's time zone (for date boxes). */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * A native <dialog> form. `fields` is trusted HTML from our own code. `onSubmit(form, ctx)` does the work and
 * either returns (the dialog closes) or throws an error whose message is shown; `ctx.show(message, fieldErrors)`
 * shows validation problems without closing.
 * @param {{ title: string, intro?: string, body: string, submit?: string, wide?: boolean, onSubmit: (form: HTMLFormElement, ctx: { show: (msg: string, fields?: Record<string, string>) => void, close: () => void }) => Promise<void> | void, onOpen?: (form: HTMLFormElement, ctx: { show: (msg: string, fields?: Record<string, string>) => void }) => void }} o
 * @returns {HTMLDialogElement}
 */
export function formDialog({ title, intro = "", body, submit = "Save", wide = false, onSubmit, onOpen }) {
  const d = document.createElement("dialog");
  d.className = `adm-dialog${wide ? " adm-dialog--wide" : ""}`;
  d.setAttribute("aria-labelledby", "pd-title");
  d.innerHTML = `
    <form novalidate data-pform>
      <h2 id="pd-title">${esc(title)}</h2>
      ${intro ? `<p class="muted">${intro}</p>` : ""}
      <p class="form-alert" role="alert" data-form-alert hidden></p>
      ${body}
      <div class="adm-dialog__actions">
        <button type="button" class="btn btn--ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn--primary"><span>${esc(submit)}</span></button>
      </div>
    </form>`;
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.querySelector("[data-close]")?.addEventListener("click", () => d.close());
  const form = /** @type {HTMLFormElement} */ (d.querySelector("[data-pform]"));
  const show = (msg, fields = {}) => {
    const alert = /** @type {HTMLElement} */ (form.querySelector("[data-form-alert]"));
    alert.textContent = msg;
    alert.hidden = !msg;
    form.querySelectorAll("[data-field]").forEach((w) => {
      const err = /** @type {HTMLElement | null} */ (w.querySelector(".field-error"));
      const m = fields[/** @type {HTMLElement} */ (w).dataset.field];
      if (err) {
        err.textContent = m ?? "";
        err.hidden = !m;
      }
    });
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    btn.disabled = true;
    try {
      show("");
      await onSubmit(form, { show, close: () => d.close() });
    } catch (error) {
      const err = /** @type {any} */ (error);
      show(err?.code && err.code !== "functions/internal" ? err.message : "Couldn't save. Please try again.", err?.details?.fields ?? {});
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
  });
  onOpen?.(form, { show });
  d.showModal();
  return d;
}

/** A labelled input row (trusted HTML). */
export const row = (name, label, control, hint = "") =>
  `<div class="field" data-field="${esc(name)}"><label for="pd-${esc(name)}">${esc(label)}</label>${hint ? `<p class="field-hint">${esc(hint)}</p>` : ""}${control}<p class="field-error" hidden></p></div>`;

export const input = (name, attrs = "") => `<input id="pd-${esc(name)}" name="${esc(name)}" ${attrs} />`;
export const select = (name, options, selected = "", attrs = "") => `<select id="pd-${esc(name)}" name="${esc(name)}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

/** Print a self-contained HTML document in a new window (receipts). The caller escapes everything it passes in. */
export function printDocument(title, innerHtml) {
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) return false;
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      body{font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#111;margin:32px;max-width:640px}
      h1{font-size:20px;margin:0 0 2px} h2{font-size:15px;margin:18px 0 6px} p{margin:2px 0}
      table{width:100%;border-collapse:collapse;margin-top:8px} td,th{padding:6px 4px;border-bottom:1px solid #ccc;text-align:left;vertical-align:top}
      .r{text-align:right} .big{font-size:22px;font-weight:700} .muted{color:#555;font-size:12px}
      .sign{margin-top:48px;display:flex;justify-content:space-between} .sign span{border-top:1px solid #111;padding-top:4px;width:44%;font-size:12px}
      @media print{body{margin:12mm}}
    </style></head><body>${innerHtml}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
  return true;
}
