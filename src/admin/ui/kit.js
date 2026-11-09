/**
 * Admin UI kit: the shared building blocks every admin module uses, so the dashboard is
 * consistent and accessible. Everything returns HTML strings or small controllers; all
 * dynamic text goes through esc().
 */
import { esc } from "../../lib/format.js";

/* ───────── Toasts (action feedback) ───────── */

let toastHost;
/** @param {string} message @param {"ok" | "error"} [tone] */
export function toast(message, tone = "ok") {
  toastHost ??= Object.assign(document.body.appendChild(document.createElement("div")), { className: "adm-toasts" });
  toastHost.setAttribute("role", "status");
  toastHost.setAttribute("aria-live", "polite");
  const el = document.createElement("p");
  el.className = `adm-toast adm-toast--${tone}`;
  el.textContent = message;
  toastHost.append(el);
  setTimeout(() => el.classList.add("is-leaving"), 3600);
  setTimeout(() => el.remove(), 4200);
}

/* ───────── Confirmation dialog ───────── */

/**
 * Native <dialog>: focus is trapped, Escape cancels, the page behind is inert.
 * @param {{ title: string, body?: string, confirm?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body = "", confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "adm-dialog";
    dialog.setAttribute("aria-labelledby", "adm-dialog-title");
    dialog.innerHTML = `
      <form method="dialog">
        <h2 id="adm-dialog-title">${esc(title)}</h2>
        ${body ? `<p>${esc(body)}</p>` : ""}
        <div class="adm-dialog__actions">
          <button value="cancel" class="btn btn--ghost">Cancel</button>
          <button value="ok" class="btn ${danger ? "btn--danger" : "btn--primary"}"><span>${esc(confirm)}</span></button>
        </div>
      </form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    dialog.showModal();
  });
}

/* ───────── States ───────── */

export const loading = (label = "Loading…") => `<div class="adm-state adm-state--loading" role="status"><span class="adm-spinner" aria-hidden="true"></span>${esc(label)}</div>`;

/** @param {{ title: string, text?: string, action?: string }} o  (action is trusted HTML from our own code) */
export const emptyState = ({ title, text = "", action = "" }) =>
  `<div class="adm-state adm-state--empty"><p class="adm-state__title">${esc(title)}</p>${text ? `<p>${esc(text)}</p>` : ""}${action}</div>`;

/** Shown when a load fails. Never shows raw error details. */
export const errorState = (text = "This couldn't be loaded. Check your connection and try again.") =>
  `<div class="adm-state adm-state--error" role="alert"><p class="adm-state__title">Something went wrong</p><p>${esc(text)}</p><button type="button" class="btn btn--ghost" data-retry>Try again</button></div>`;

/* ───────── Stat card ───────── */

/** @param {{ label: string, value: string | number, note?: string, href?: string }} s */
export const statCard = ({ label, value, note = "", href = "" }) => {
  const inner = `<span class="adm-stat__label">${esc(label)}</span><span class="adm-stat__value">${esc(value)}</span>${note ? `<span class="adm-stat__note">${esc(note)}</span>` : ""}`;
  return href ? `<a class="adm-stat" href="${esc(href)}">${inner}</a>` : `<div class="adm-stat">${inner}</div>`;
};

/* ───────── Table with "load more" pagination ───────── */

/**
 * @template T
 * @param {{
 *   columns: { key: string, label: string, render?: (row: T) => string, className?: string }[],
 *   caption: string,
 *   empty: { title: string, text?: string },
 * }} opts
 * @returns {{ el: HTMLElement, set: (rows: T[], hasMore?: boolean) => void, append: (rows: T[], hasMore?: boolean) => void, onMore: (fn: () => void) => void }}
 */
export function dataTable({ columns, caption, empty }) {
  const el = document.createElement("div");
  el.className = "adm-table-wrap";
  /** @type {T[]} */
  let rows = [];
  let moreFn = () => {};
  const cell = (row, c) => (c.render ? c.render(row) : esc(row[c.key] ?? "—"));
  const draw = (hasMore) => {
    if (!rows.length) {
      el.innerHTML = emptyState(empty);
      return;
    }
    el.innerHTML = `
      <table class="adm-table">
        <caption class="visually-hidden">${esc(caption)}</caption>
        <thead><tr>${columns.map((c) => `<th scope="col" class="${c.className ?? ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.className ?? ""}" data-label="${esc(c.label)}">${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      ${hasMore ? `<p class="adm-table__more"><button type="button" class="btn btn--ghost" data-more>Load more</button></p>` : ""}`;
    el.querySelector("[data-more]")?.addEventListener("click", () => moreFn());
  };
  return {
    el,
    set: (next, hasMore = false) => {
      rows = next;
      draw(hasMore);
    },
    append: (next, hasMore = false) => {
      rows = rows.concat(next);
      draw(hasMore);
    },
    onMore: (fn) => (moreFn = fn),
  };
}

export { formatWhen } from "../../lib/when.js";
