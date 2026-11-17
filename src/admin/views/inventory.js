/**
 * Inventory & Stock: stock per warehouse, size and colour, shown one PAGE at a time (a page costs about one
 * read per product row, never the whole collection). Filters for low and out of stock, stock adjustments
 * with a reason, and the history of every movement (warehouse, source, who, before → after).
 * Changes go through the adjustStock endpoint, which refuses negative stock and logs every change.
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, dataTable, emptyState, formatWhen } from "../ui/kit.js";
import { call, listInventoryPage, getProductsByIds, listMovements, listWarehouses, listColors, listSizes, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { loadSettings, staffDirectory } from "../data.js";
import { stockAdjustmentSchema, STOCK_REASONS, fieldErrors, DEFAULT_WAREHOUSE_ID } from "../../../shared/schemas/index.js";
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
  transfer_out: "Transferred out",
  transfer_in: "Transferred in",
  purchase_receipt: "Goods received",
  purchase_return: "Returned to supplier",
};

export default async function inventory({ main, user }) {
  const canAdjust = user.perms.includes("inventory.adjust");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Inventory <em>&amp; stock</em></h1>
        <p class="muted">Stock per warehouse, size and colour. Every change is recorded with who made it and why. Stock can't go below zero in any warehouse.</p>
      </header>
      <div class="adm-filters">
        <label class="visually-hidden" for="inv-search">Search by SKU</label>
        <input id="inv-search" type="search" placeholder="Search by SKU (starts with…)" />
        <label class="visually-hidden" for="inv-wh">Warehouse</label>
        <select id="inv-wh"><option value="">All warehouses</option></select>
        <label class="visually-hidden" for="inv-filter">Show</label>
        <select id="inv-filter"><option value="">All</option><option value="low" data-low>Low stock</option><option value="out">Out of stock</option></select>
      </div>
      <div data-table><p class="muted">Loading…</p></div>
    </div>`;
  const wrap = main.querySelector("[data-table]");
  const searchEl = /** @type {HTMLInputElement} */ (main.querySelector("#inv-search"));
  const whEl = /** @type {HTMLSelectElement} */ (main.querySelector("#inv-wh"));
  const filterEl = /** @type {HTMLSelectElement} */ (main.querySelector("#inv-filter"));

  let warehouses = [VIRTUAL_DEFAULT_WAREHOUSE];
  const whName = (id) => warehouses.find((w) => w.id === id)?.name ?? "Unknown warehouse";
  let threshold = null;
  let colors = new Map();
  let sizes = new Map();
  /** @type {Record<string, any>} */
  const products = {};
  /** @type {{ cursor: any, hasMore: boolean, rows: any[] }} */
  let state = { cursor: null, hasMore: false, rows: [] };
  let ticket = 0;

  const labelOf = (variantId) => {
    const [colorId, sizeId] = variantId.split("_");
    const c = colors.get(colorId);
    const s = sizes.get(sizeId);
    return c && s ? `${c.name} / ${s.system} ${s.value}` : variantId;
  };

  /** One database document → one row per warehouse that holds (or held) stock of it. */
  const rowsOf = (doc) => {
    const entries = doc.byWarehouse ?? { [DEFAULT_WAREHOUSE_ID]: { onHand: doc.onHand ?? 0, reserved: doc.reserved ?? 0 } };
    return Object.entries(entries)
      .sort(([a], [b]) => Number(b === DEFAULT_WAREHOUSE_ID) - Number(a === DEFAULT_WAREHOUSE_ID) || whName(a).localeCompare(whName(b)))
      .map(([wid, e]) => ({ key: `${doc.id}|${wid}`, doc, wid, onHand: e.onHand ?? 0, reserved: e.reserved ?? 0, product: products[doc.productId], variant: labelOf(doc.variantId) }))
      .filter((r) => r.product && (!whEl.value || r.wid === whEl.value));
  };

  const level = (r) => {
    const available = r.onHand - r.reserved;
    const t = r.doc.lowStockThreshold ?? threshold;
    if (available <= 0) return "out";
    if (t !== null && available <= t) return "low";
    return "ok";
  };

  const table = dataTable({
    caption: "Stock by warehouse, size and colour",
    empty: { title: "Nothing matches", text: "Try another search, warehouse or filter." },
    columns: [
      { key: "warehouse", label: "Warehouse", render: (r) => esc(whName(r.wid)) },
      { key: "product", label: "Product", render: (r) => `<a class="text-link" href="/admin/products/${esc(r.doc.productId)}" data-link>${esc(r.product.name)}</a>` },
      { key: "variant", label: "Variant", render: (r) => esc(r.variant) },
      { key: "sku", label: "SKU", render: (r) => esc(r.doc.sku ?? "—") },
      { key: "onHand", label: "On hand" },
      { key: "reserved", label: "Reserved", render: (r) => String(r.reserved) },
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
        render: (r) => `${canAdjust ? `<button type="button" class="text-btn" data-adjust="${esc(r.key)}">Adjust</button> ` : ""}<button type="button" class="text-btn" data-history="${esc(r.key)}">History</button>`,
      },
    ],
  });
  table.onMore(() => load(false));

  /** Load the first page (reset) or the next one. */
  async function load(reset = true) {
    const mine = ++ticket;
    if (reset) state = { cursor: null, hasMore: false, rows: [] };
    try {
      const page = await listInventoryPage({ search: searchEl.value, filter: /** @type {any} */ (filterEl.value), threshold, after: state.cursor });
      if (mine !== ticket) return;
      const missing = [...new Set(page.rows.map((r) => r.productId))].filter((id) => !(id in products));
      if (missing.length) Object.assign(products, await getProductsByIds(missing));
      if (mine !== ticket) return;
      const rows = page.rows.flatMap(rowsOf);
      state = { cursor: page.last, hasMore: page.hasMore, rows: reset ? rows : state.rows.concat(rows) };
      draw(rows, reset);
    } catch {
      if (mine !== ticket) return;
      wrap.innerHTML = errorState();
      wrap.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }

  function draw(newRows, reset) {
    if (reset && !state.rows.length && !searchEl.value && !filterEl.value && !whEl.value && !state.hasMore) {
      wrap.innerHTML = emptyState({
        title: "No stock to show yet",
        text: "Stock appears here once a product has sizes and colours. New sizes start at 0 — add the real count with Adjust.",
        action: `<a class="btn btn--ghost" href="/admin/products" data-link>Go to products</a>`,
      });
      return;
    }
    if (reset) table.set(state.rows, state.hasMore);
    else table.append(newRows, state.hasMore);
    if (!wrap.contains(table.el)) wrap.replaceChildren(table.el);
  }

  let timer;
  searchEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(true), 350);
  });
  filterEl.addEventListener("change", () => load(true));
  whEl.addEventListener("change", () => load(true));

  wrap.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const adj = t.closest("[data-adjust]");
    const his = t.closest("[data-history]");
    const find = (k) => state.rows.find((r) => r.key === k);
    if (adj) adjustDialog(find(/** @type {HTMLElement} */ (adj).dataset.adjust));
    if (his) historyDialog(find(/** @type {HTMLElement} */ (his).dataset.history));
  });

  /** Native <dialog> form: warehouse, change (+/-), reason, note. */
  function adjustDialog(r) {
    if (!r) return;
    const active = warehouses.filter((w) => w.isActive !== false);
    const d = document.createElement("dialog");
    d.className = "adm-dialog";
    d.setAttribute("aria-labelledby", "adj-title");
    d.innerHTML = `
      <form novalidate data-adj>
        <h2 id="adj-title">Adjust stock</h2>
        <p>${esc(r.product.name)} · ${esc(r.variant)} · <code>${esc(r.doc.sku ?? "")}</code><br /><span class="muted">In ${esc(whName(r.wid))} now: ${r.onHand}${r.reserved ? ` (${r.reserved} reserved)` : ""}</span></p>
        <p class="form-alert" role="alert" data-form-alert hidden></p>
        <div class="field" data-field="warehouseId">
          <label for="adj-wh">Warehouse</label>
          <select id="adj-wh" name="warehouseId">${active.map((w) => `<option value="${esc(w.id)}" ${w.id === r.wid ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
          <p class="field-error" hidden></p>
        </div>
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
        productId: r.doc.productId,
        variantId: r.doc.variantId,
        warehouseId: fd.get("warehouseId") || undefined,
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
        toast(`Stock updated — ${res.available} available online.`);
        await load(true);
      } catch (error) {
        show(fnResult(error).message);
        btn.disabled = false;
      }
    });
    d.showModal();
  }

  async function historyDialog(r) {
    if (!r) return;
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide";
    d.setAttribute("aria-labelledby", "his-title");
    d.innerHTML = `<h2 id="his-title">Stock history</h2><p>${esc(r.product.name)} · ${esc(r.variant)} · <code>${esc(r.doc.sku ?? "")}</code></p><div data-his><p class="muted">Loading…</p></div>
      <div class="adm-dialog__actions"><button type="button" class="btn btn--ghost" data-close>Close</button></div>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    d.showModal();
    const box = d.querySelector("[data-his]");
    try {
      const [moves, names] = await Promise.all([listMovements(r.doc.id), staffDirectory().catch(() => ({}))]);
      box.innerHTML = moves.length
        ? `<ul class="adm-feed">${moves
            .map(
              (m) => `<li><span><strong>${m.change > 0 ? "+" : ""}${m.change}</strong> · ${esc(whName(m.warehouseId ?? DEFAULT_WAREHOUSE_ID))} · ${esc(REASON_LABEL[m.reason] ?? m.reason)}${m.note ? ` — ${esc(m.note)}` : ""}<br />
                <span class="muted">${m.onHandBefore} → ${m.onHandAfter} · ${esc(names[m.actorUid] ?? "Staff member")}</span></span><span class="muted">${esc(formatWhen(m.at))}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">No changes yet.</p>`;
    } catch {
      box.innerHTML = `<p class="muted">History couldn't be loaded.</p>`;
    }
  }

  // Setup: warehouses, the catalogue names used for labels, and the low-stock level, then the first page.
  try {
    const [w, c, s, settings] = await Promise.all([listWarehouses(), listColors(), listSizes(), loadSettings().catch(() => ({ private: null }))]);
    warehouses = w.some((x) => x.id === DEFAULT_WAREHOUSE_ID) ? w : [VIRTUAL_DEFAULT_WAREHOUSE, ...w];
    colors = new Map(c.map((x) => [x.id, x]));
    sizes = new Map(s.map((x) => [x.id, x]));
    threshold = settings.private?.lowStockThreshold ?? null;
  } catch {
    /* names fall back to ids; the list below still loads */
  }
  whEl.innerHTML = `<option value="">All warehouses</option>${warehouses.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}${w.isActive === false ? " (off)" : ""}</option>`).join("")}`;
  if (threshold === null) filterEl.querySelector("[data-low]")?.remove(); // "low" needs the alert level from Store settings
  await load(true);
}
