/**
 * Stock levels, locations and barcodes: stock per size/colour with minimum / reorder / maximum levels and storage
 * locations, barcode assignment and lookup by scan, and product label printing. Stock comes from the real inventory.
 */
import { esc } from "../../lib/format.js";
import { ean13Svg, isEan13 } from "../../../shared/inventory.js";
import { toast, errorState } from "../ui/kit.js";
import { formDialog, row, input, printDocument } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { money, messageOf, labelTables } from "../financeUi.js";

export default async function stockLevels({ main, user }) {
  const canManage = user.perms.includes("inventory.manage");
  let items = [];
  let whs = [];
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Stock levels <em>&amp; barcodes</em></h1>
        <p class="muted">Stock per size/colour from your inventory records. Set minimum, reorder and maximum levels and shelf locations; give each variant a barcode (a code you already have, or a new in-store EAN-13); print labels.</p></header>
      <form class="adm-filters" data-scan novalidate><div class="field"><label for="sl-scan">Scan or type a barcode / SKU</label><input id="sl-scan" autocomplete="off" placeholder="Scan here, then Enter" /></div><button class="btn btn--ghost" type="submit"><span>Find</span></button></form>
      <div data-found></div>
      <div class="adm-filters"><div class="field"><label for="sl-q">Search</label><input id="sl-q" type="search" placeholder="Product or SKU" /></div><div class="field"><label for="sl-wh">Warehouse</label><select id="sl-wh"><option value="">All warehouses</option></select></div></div>
      ${canManage ? `<p><button type="button" class="btn btn--ghost" data-labels>Print labels for ticked items</button> <span class="muted">Each label needs a barcode: assign one first.</span></p>` : ""}
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLElement} */ (main.querySelector(s));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;

  const draw = () => {
    const q = /** @type {HTMLInputElement} */ ($("#sl-q")).value.trim().toLowerCase();
    const wid = /** @type {HTMLSelectElement} */ ($("#sl-wh")).value;
    const shown = items.filter((i) => (!q || `${i.productName} ${i.sku} ${i.barcode}`.toLowerCase().includes(q)) && (!wid || (i.byWh[wid]?.onHand ?? 0) > 0 || (i.byWh[wid]?.reserved ?? 0) > 0));
    $("[data-list]").innerHTML = shown.length
      ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${canManage ? "<th></th>" : ""}<th>Product</th><th>SKU / barcode</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Levels</th><th>Cost</th><th>Value</th><th>Location</th><th></th></tr></thead><tbody>${shown
          .map((i) => {
            const onHand = wid ? i.byWh[wid]?.onHand ?? 0 : i.onHand;
            const reserved = wid ? i.byWh[wid]?.reserved ?? 0 : i.reserved;
            const status = i.available <= 0 ? `<span class="tag tag--out">Out</span>` : i.minStock !== null && i.available <= i.minStock ? `<span class="tag tag--low">Low</span>` : i.maxStock !== null && i.onHand > i.maxStock ? `<span class="tag">Over</span>` : "";
            return `<tr>${canManage ? `<td><input type="checkbox" data-pick="${esc(i.id)}" aria-label="Select ${esc(i.productName)} ${esc(i.variantLabel)}" /></td>` : ""}<td><strong>${esc(i.productName)}</strong><br /><span class="muted">${esc(i.variantLabel)}</span> ${status}</td><td><code>${esc(i.sku)}</code><br />${i.barcode ? `<code>${esc(i.barcode)}</code>` : `<span class="muted">no barcode</span>`}</td><td>${onHand}</td><td>${reserved}</td><td>${onHand - reserved}</td><td>${[i.minStock !== null ? `min ${i.minStock}` : "", i.reorderLevel !== null ? `reorder ${i.reorderLevel}` : "", i.maxStock !== null ? `max ${i.maxStock}` : ""].filter(Boolean).join(" · ") || "—"}</td><td>${i.cost === null ? "—" : esc(money(i.cost))}</td><td>${esc(money(wid ? (i.cost ?? 0) * onHand : i.value))}</td><td>${esc((wid ? i.locations[wid] : Object.values(i.locations).join(", ")) || "—")}</td><td class="adm-actions">${canManage ? `<button type="button" class="text-btn" data-levels="${esc(i.id)}">Levels</button> <button type="button" class="text-btn" data-barcode="${esc(i.id)}">${i.barcode ? "Change barcode" : "Barcode"}</button>` : ""}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="muted">Nothing matches.</p>`;
    labelTables($("[data-list]"));
  };

  async function load() {
    try {
      const r = await call("inventoryItems", {});
      if (!alive()) return;
      items = r.items;
      whs = r.warehouses;
      const sel = /** @type {HTMLSelectElement} */ ($("#sl-wh"));
      sel.innerHTML = `<option value="">All warehouses</option>${whs.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")}`;
      draw();
    } catch (e) {
      if (alive()) {
        $("[data-list]").innerHTML = errorState(messageOf(e));
        $("[data-list]").querySelector("[data-retry]")?.addEventListener("click", load);
      }
    }
  }

  $("#sl-q").addEventListener("input", draw);
  $("#sl-wh").addEventListener("change", draw);
  $("[data-scan]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = /** @type {HTMLInputElement} */ ($("#sl-scan"));
    const code = inp.value.trim();
    if (code.length < 3) return;
    inp.value = "";
    try {
      const r = await call("lookupBarcode", { code });
      $("[data-found]").innerHTML = r.found ? `<div class="adm-card"><strong>${esc(r.product)}</strong> · ${esc(r.variant)}<br />SKU <code>${esc(r.sku)}</code>${r.barcode ? ` · barcode <code>${esc(r.barcode)}</code>` : ""} · found by ${esc(r.via)}<br />Price ${esc(money(r.price))} · cost ${r.cost === null ? "—" : esc(money(r.cost))} · <strong>${r.onHand}</strong> on hand</div>` : `<p class="form-alert" role="alert">Nothing found for “${esc(code)}”.</p>`;
    } catch (err) {
      $("[data-found]").innerHTML = errorState(messageOf(err));
    }
    inp.focus();
  });

  main.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest("button");
    if (!t) return;
    const item = (id) => items.find((i) => i.id === id);
    if (t.dataset.levels) {
      const i = item(t.dataset.levels);
      formDialog({
        title: `Levels — ${i.productName} (${i.variantLabel})`,
        intro: "Leave a box empty for no limit. A variant's own minimum replaces the general low-stock alert.",
        body: row("minStock", "Minimum stock (pairs)", input("minStock", `inputmode="numeric" value="${i.minStock ?? ""}"`)) + row("reorderLevel", "Reorder level (pairs)", input("reorderLevel", `inputmode="numeric" value="${i.reorderLevel ?? ""}"`)) + row("maxStock", "Maximum stock (pairs)", input("maxStock", `inputmode="numeric" value="${i.maxStock ?? ""}"`)) + whs.filter((w) => w.isActive).map((w) => row(`loc-${w.id}`, `Shelf / bin in ${w.name}`, input(`loc-${w.id}`, `maxlength="40" value="${esc(i.locations[w.id] ?? "")}"`))).join(""),
        submit: "Save levels",
        onSubmit: async (form, { show, close }) => {
          const f = new FormData(form);
          const num = (k) => (String(f.get(k) ?? "").trim() === "" ? null : Number(f.get(k)));
          const vals = [num("minStock"), num("reorderLevel"), num("maxStock")];
          if (vals.some((v) => v !== null && (!Number.isInteger(v) || v < 0))) return show("Use whole numbers of pairs.");
          await call("setStockPolicy", { productId: i.productId, variantId: i.variantId, minStock: vals[0], reorderLevel: vals[1], maxStock: vals[2], locations: Object.fromEntries(whs.filter((w) => w.isActive).map((w) => [w.id, String(f.get(`loc-${w.id}`) ?? "").trim()]).filter(([, v]) => v)) });
          close();
          toast("Saved");
          load();
        },
      });
    }
    if (t.dataset.barcode) {
      const i = item(t.dataset.barcode);
      formDialog({
        title: `Barcode — ${i.productName} (${i.variantLabel})`,
        intro: "Type or scan a code you already have (8–14 digits), or leave it empty to create a NEW in-store EAN-13 (it replaces any current code). A code can belong to only one size/colour.",
        body: row("barcode", "Barcode", input("barcode", `inputmode="numeric" maxlength="14" autocomplete="off" value="${esc(i.barcode)}"`)),
        submit: "Save barcode",
        onSubmit: async (form, { show, close }) => {
          const code = String(new FormData(form).get("barcode") ?? "").trim();
          if (code && !/^\d{8,14}$/.test(code)) return show("Use 8 to 14 digits.", { barcode: "Digits only" });
          if (code.length === 13 && !isEan13(code)) return show("That isn't a valid EAN-13 (the last digit doesn't match).", { barcode: "Check digit" });
          const r = await call("assignBarcode", { productId: i.productId, variantId: i.variantId, ...(code ? { barcode: code } : {}) });
          close();
          toast(`Barcode ${r.barcode}`);
          load();
        },
      });
    }
    if (t.hasAttribute("data-labels")) {
      const picked = [...main.querySelectorAll("[data-pick]:checked")].map((c) => item(/** @type {HTMLElement} */ (c).dataset.pick)).filter(Boolean);
      if (!picked.length) return toast("Tick the items to print labels for.", "error");
      const withCode = picked.filter((i) => isEan13(i.barcode));
      if (!withCode.length) return toast("None of the ticked items has an EAN-13 barcode yet. Assign one first.", "error");
      const labels = withCode.map((i) => `<div class="label"><div class="n">${esc(i.productName)}</div><div class="v">${esc(i.variantLabel)} · ${esc(i.sku)}</div>${ean13Svg(i.barcode, { module: 1.6, height: 40 })}<div class="p">${esc(money(i.price))}</div></div>`).join("");
      const ok = printDocument("Product labels", `<style>.label{display:inline-block;width:52mm;padding:2mm;margin:1mm;border:1px dotted #999;text-align:center;font:11px system-ui;page-break-inside:avoid}.n{font-weight:700}.v{color:#444;margin-bottom:2px}.p{font-weight:700;font-size:13px}svg{max-width:100%;height:auto}</style>${labels}`);
      if (!ok) toast("Allow pop-ups for this site to print labels.", "error");
      else if (withCode.length < picked.length) toast(`${picked.length - withCode.length} item(s) were skipped: no EAN-13 barcode.`);
    }
  });
  await load();
}
