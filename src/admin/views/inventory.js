/**
 * Inventory & Stock: every size/colour with its stock, filters for low and out of stock, stock
 * adjustments with a reason, and the history of who changed what. Changes go through the
 * adjustStock Cloud Function, which refuses negative stock and logs every change.
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, dataTable, emptyState, formatWhen } from "../ui/kit.js";
import { call, listInventory, listProducts, listMovements } from "../catalogData.js";
import { loadSettings, staffDirectory } from "../data.js";
import { stockAdjustmentSchema, STOCK_REASONS, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

const REASON_LABEL = {
  initial: "Opening stock",
  adjustment: "Adjustment",
  correction: "Stock count correction",
  damaged: "Damaged / unsellable",
  found: "Found / returned to shelf",
  sale: "Sold",
  cancellation: "Order cancelled",
  return: "Customer return",
};

export default async function inventory({ main, user }) {
  const canAdjust = user.perms.includes("inventory.adjust");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Inventory <em>&amp; stock</em></h1>
        <p class="muted">Stock per size and colour. Every change is recorded with who made it and why. Stock can't go below zero.</p>
      </header>
      <div class="adm-filters">
        <label class="visually-hidden" for="inv-search">Search</label>
        <input id="inv-search" type="search" placeholder="Search product, SKU or colour" />
        <label class="visually-hidden" for="inv-filter">Show</label>
        <select id="inv-filter"><option value="">All</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
      </div>
      <div data-table><p class="muted">Loading…</p></div>
    </div>`;
  const wrap = main.querySelector("[data-table]");

  let rows = [];
  let threshold = null;
  const load = async () => {
    try {
      const [inv, products, settings] = await Promise.all([listInventory(), listProducts(), loadSettings().catch(() => ({ private: null }))]);
      threshold = settings.private?.lowStockThreshold ?? null;
      const byId = Object.fromEntries(products.map((p) => [p.id, p]));
      rows = inv
        .map((i) => ({ ...i, product: byId[i.productId] }))
        .filter((i) => i.product)
        .sort((a, b) => a.product.name.localeCompare(b.product.name) || String(a.sku).localeCompare(String(b.sku)));
      draw();
    } catch {
      wrap.innerHTML = errorState();
      wrap.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  };

  const level = (r) => {
    const available = r.onHand - r.reserved;
    const t = r.lowStockThreshold ?? threshold;
    if (available <= 0) return "out";
    if (t !== null && available <= t) return "low";
    return "ok";
  };

  const table = dataTable({
    caption: "Stock by size and colour",
    empty: { title: "Nothing matches", text: "Try another search or filter." },
    columns: [
      { key: "product", label: "Product", render: (r) => `<a class="text-link" href="/admin/products/${esc(r.productId)}" data-link>${esc(r.product.name)}</a>` },
      { key: "sku", label: "SKU" },
      { key: "onHand", label: "On hand" },
      { key: "reserved", label: "Reserved", render: (r) => String(r.reserved ?? 0) },
      {
        key: "available",
        label: "Available",
        render: (r) => {
          const l = level(r);
          return `<strong>${r.onHand - r.reserved}</strong>${l === "out" ? ` <span class="tag tag--out">Out</span>` : l === "low" ? ` <span class="tag tag--low">Low</span>` : ""}`;
        },
      },
      {
        key: "actions",
        label: "",
        className: "adm-actions",
        render: (r) => `${canAdjust ? `<button type="button" class="text-btn" data-adjust="${esc(r.id)}">Adjust</button> ` : ""}<button type="button" class="text-btn" data-history="${esc(r.id)}">History</button>`,
      },
    ],
  });

  const draw = () => {
    if (!rows.length) {
      wrap.innerHTML = emptyState({
        title: "No stock to show yet",
        text: "Stock appears here once a product has sizes and colours. New sizes start at 0 — add the real count with Adjust.",
        action: `<a class="btn btn--ghost" href="/admin/products" data-link>Go to products</a>`,
      });
      return;
    }
    const q = /** @type {HTMLInputElement} */ (main.querySelector("#inv-search")).value.trim().toLowerCase();
    const f = /** @type {HTMLSelectElement} */ (main.querySelector("#inv-filter")).value;
    table.set(rows.filter((r) => (!q || `${r.product.name} ${r.sku} ${r.variantId}`.toLowerCase().includes(q)) && (!f || level(r) === f)));
    if (!wrap.contains(table.el)) wrap.replaceChildren(table.el);
  };
  main.querySelector(".adm-filters").addEventListener("input", draw);

  wrap.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const adj = t.closest("[data-adjust]");
    const his = t.closest("[data-history]");
    if (adj) adjustDialog(rows.find((r) => r.id === /** @type {HTMLElement} */ (adj).dataset.adjust));
    if (his) historyDialog(rows.find((r) => r.id === /** @type {HTMLElement} */ (his).dataset.history));
  });

  /** Native <dialog> form: change (+/-), reason, note. */
  function adjustDialog(r) {
    const d = document.createElement("dialog");
    d.className = "adm-dialog";
    d.setAttribute("aria-labelledby", "adj-title");
    d.innerHTML = `
      <form novalidate data-adj>
        <h2 id="adj-title">Adjust stock</h2>
        <p>${esc(r.product.name)} · <code>${esc(r.sku)}</code><br /><span class="muted">On hand now: ${r.onHand}${r.reserved ? ` (${r.reserved} reserved)` : ""}</span></p>
        <p class="form-alert" role="alert" data-form-alert hidden></p>
        <div class="field" data-field="change">
          <label for="adj-change">Change</label>
          <p class="field-hint" id="adj-change-hint">Positive to add pairs (e.g. 6), negative to remove (e.g. -2).</p>
          <input id="adj-change" name="change" type="number" step="1" required aria-describedby="adj-change-hint" />
          <p class="field-error" hidden></p>
        </div>
        <div class="field" data-field="reason">
          <label for="adj-reason">Reason</label>
          <select id="adj-reason" name="reason">${STOCK_REASONS.map((x) => `<option value="${x}" ${x === (r.onHand === 0 ? "initial" : "adjustment") ? "selected" : ""}>${REASON_LABEL[x]}</option>`).join("")}</select>
        </div>
        <div class="field" data-field="note">
          <label for="adj-note">Note</label>
          <input id="adj-note" name="note" maxlength="300" placeholder="e.g. Counted the shelf on Monday" />
          <p class="field-error" hidden></p>
        </div>
        <div class="adm-dialog__actions">
          <button type="button" class="btn btn--ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn--primary"><span>Save</span></button>
        </div>
      </form>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    const form = /** @type {HTMLFormElement} */ (d.querySelector("[data-adj]"));
    const show = (msg, fields = {}) => {
      const alert = /** @type {HTMLElement} */ (form.querySelector("[data-form-alert]"));
      alert.textContent = msg;
      alert.hidden = !msg;
      form.querySelectorAll(".field").forEach((w) => {
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
      const fd = new FormData(form);
      const parsed = stockAdjustmentSchema.safeParse({
        productId: r.productId,
        variantId: r.variantId,
        change: fd.get("change") === "" ? NaN : Number(fd.get("change")),
        reason: fd.get("reason"),
        note: fd.get("note"),
      });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      const btn = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
      btn.disabled = true;
      try {
        const res = await call("adjustStock", parsed.data);
        d.close();
        toast(`Stock updated — ${res.available} available.`);
        await load();
      } catch (error) {
        show(fnResult(error).message);
        btn.disabled = false;
      }
    });
    d.showModal();
  }

  async function historyDialog(r) {
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide";
    d.setAttribute("aria-labelledby", "his-title");
    d.innerHTML = `<h2 id="his-title">Stock history</h2><p>${esc(r.product.name)} · <code>${esc(r.sku)}</code></p><div data-his><p class="muted">Loading…</p></div>
      <div class="adm-dialog__actions"><button type="button" class="btn btn--ghost" data-close>Close</button></div>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    d.showModal();
    const box = d.querySelector("[data-his]");
    try {
      const [moves, names] = await Promise.all([listMovements(r.id), staffDirectory().catch(() => ({}))]);
      box.innerHTML = moves.length
        ? `<ul class="adm-feed">${moves
            .map(
              (m) => `<li><span><strong>${m.change > 0 ? "+" : ""}${m.change}</strong> · ${esc(REASON_LABEL[m.reason] ?? m.reason)}${m.note ? ` — ${esc(m.note)}` : ""}<br />
                <span class="muted">${m.onHandBefore} → ${m.onHandAfter} · ${esc(names[m.actorUid] ?? "Staff member")}</span></span><span class="muted">${esc(formatWhen(m.at))}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">No changes yet.</p>`;
    } catch {
      box.innerHTML = `<p class="muted">History couldn't be loaded.</p>`;
    }
  }

  await load();
}
