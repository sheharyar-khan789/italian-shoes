/** Shared form markup and error display for account and admin forms. */
import { esc } from "../lib/format.js";

/**
 * @param {{ name: string, label: string, type?: string, value?: string, hint?: string, autocomplete?: string, required?: boolean, inputmode?: string, maxlength?: number, textarea?: boolean }} f
 * @param {string} [prefix] id prefix, unique per form
 */
export function field(f, prefix = "f") {
  const id = `${prefix}-${f.name}`;
  const describedBy = [f.hint && `${id}-hint`, `${id}-error`].filter(Boolean).join(" ");
  const attrs = `id="${id}" name="${f.name}" autocomplete="${f.autocomplete ?? "off"}" aria-describedby="${describedBy}" ${f.required ? 'required aria-required="true"' : ""} ${f.maxlength ? `maxlength="${f.maxlength}"` : ""}`;
  const control = f.textarea
    ? `<textarea ${attrs} rows="3">${esc(f.value ?? "")}</textarea>`
    : `<input ${attrs} type="${f.type ?? "text"}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ""} value="${esc(f.value ?? "")}" />`;
  return `
  <div class="field" data-field="${f.name}">
    <label for="${id}">${esc(f.label)}${f.required === false ? ` <span class="muted">(optional)</span>` : ""}</label>
    ${f.hint ? `<p class="field-hint" id="${id}-hint">${esc(f.hint)}</p>` : ""}
    ${control}
    <p class="field-error" id="${id}-error" hidden></p>
  </div>`;
}

/** Read a form's named fields as a plain object of strings / booleans. */
export function formValues(form) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (const el of form.elements) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) || !el.name) continue;
    out[el.name] = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}

/**
 * Show a result from session.js on a form: field errors next to fields, one message on top.
 * @param {HTMLFormElement} form
 * @param {{ ok: boolean, message?: string, fields?: Record<string, string> }} result
 */
export function showResult(form, result) {
  const alert = /** @type {HTMLElement | null} */ (form.querySelector("[data-form-alert]"));
  form.querySelectorAll(".field").forEach((wrap) => {
    const name = /** @type {HTMLElement} */ (wrap).dataset.field;
    const msg = result.fields?.[name];
    const input = wrap.querySelector("input, textarea, select");
    const err = /** @type {HTMLElement | null} */ (wrap.querySelector(".field-error"));
    wrap.classList.toggle("has-error", Boolean(msg));
    if (input) {
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    if (err) {
      err.textContent = msg ?? "";
      err.hidden = !msg;
    }
  });
  if (alert) {
    alert.textContent = result.ok ? "" : result.message ?? "";
    alert.hidden = result.ok || !result.message;
  }
  if (!result.ok) {
    const firstBad = /** @type {HTMLElement | null} */ (form.querySelector('[aria-invalid="true"]'));
    (firstBad ?? alert)?.focus?.();
  }
}

/** Disable a form's submit button while `task` runs (no double submits). */
export async function busy(form, task, busyLabel = "Please wait…") {
  const btn = form.querySelector('[type="submit"]');
  const label = btn?.querySelector("span") ?? btn;
  const original = label?.textContent;
  if (btn) btn.disabled = true;
  if (label) label.textContent = busyLabel;
  try {
    return await task();
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = original;
  }
}
