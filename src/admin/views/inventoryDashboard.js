/** Inventory dashboard: every number is worked out on the server from the real inventory, cost, movement and adjustment records. */
import { esc } from "../../lib/format.js";
import { ALERT_LABEL } from "../../../shared/inventory.js";
import { statCard, errorState, toast } from "../ui/kit.js";
import { formDialog, row, input } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { money, messageOf, labelTables, toPaisa } from "../financeUi.js";

export default async function inventoryDashboard({ main, user }) {
  const canManage = user.perms.includes("inventory.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Inventory <em>dashboard</em></h1>
        <p class="muted">Stock, value and alerts from your real inventory records. Value uses the weighted average cost of each size/colour.</p>
        <p>${canManage ? `<button type="button" class="btn btn--ghost" data-settings>Alert settings</button>` : ""}</p></header>
      <div data-body><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Alerts</h2>
      <div class="adm-filters"><div class="field"><label for="al-kind">Show</label><select id="al-kind"><option value="">All alerts</option>${Object.entries(ALERT_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div></div>
      <div data-alerts><p class="muted">Loading…</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLElement} */ (main.querySelector(s));
  const alive = () => main.isConnected && main.querySelector("[data-body]") !== null;
  let alerts = [];

  const drawAlerts = () => {
    const kind = /** @type {HTMLSelectElement} */ ($("#al-kind")).value;
    const list = alerts.filter((a) => !kind || a.kind === kind);
    $("[data-alerts]").innerHTML = list.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Alert</th><th>Product</th><th>Size / colour</th><th>SKU</th><th>On hand</th><th>Available</th><th>Detail</th></tr></thead><tbody>${list.map((a) => `<tr><td><span class="tag ${["out", "dead"].includes(a.kind) ? "tag--out" : a.kind === "over" ? "" : "tag--low"}">${esc(ALERT_LABEL[a.kind])}</span></td><td>${esc(a.product)}</td><td>${esc(a.variant)}</td><td><code>${esc(a.sku)}</code></td><td>${a.onHand}</td><td>${a.available}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No alerts${kind ? " of this kind" : ""}.</p>`;
    labelTables($("[data-alerts]"));
  };

  async function load() {
    try {
      const [d, a] = await Promise.all([call("inventoryDashboard", {}), call("inventoryAlerts", {})]);
      if (!alive()) return;
      alerts = a.alerts;
      $("[data-body]").innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Total products", value: String(d.products) })}
          ${statCard({ label: "Total variants", value: String(d.variants), note: "size / colour combinations" })}
          ${statCard({ label: "Available stock", value: String(d.available), note: "pairs not reserved" })}
          ${statCard({ label: "Reserved stock", value: String(d.reserved), note: "held for pending orders" })}
          ${statCard({ label: "Damaged (written off)", value: String(d.damagedWrittenOff), note: `${d.missingInTransfer} missing in transfers · ${d.returnedToSuppliers} returned to suppliers` })}
          ${statCard({ label: "Inventory value", value: money(d.value), note: d.unitsWithoutCost ? `${d.unitsWithoutCost} pairs have no recorded cost` : "at average cost" })}
          ${statCard({ label: "Low stock", value: String(d.lowStock), note: `${d.reorder} to reorder` })}
          ${statCard({ label: "Out of stock", value: String(d.outOfStock) })}
          ${statCard({ label: "Overstock", value: String(d.overstock) })}
          ${statCard({ label: "Slow / dead", value: `${d.slow} / ${d.dead}`, note: d.movementNote || "no recent sales / no movement" })}
        </div>
        <h2 class="adm-h2">Warehouse-wise inventory</h2>
        <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Warehouse</th><th>On hand</th><th>Reserved</th><th>Value</th></tr></thead><tbody>${d.warehouses.map((w) => `<tr><td>${esc(w.name)}${w.isActive ? "" : ` <span class="tag tag--out">Off</span>`}</td><td>${w.onHand}</td><td>${w.reserved}</td><td>${esc(money(w.value))}</td></tr>`).join("")}</tbody></table></div>
        <h2 class="adm-h2">Recent stock movements</h2>
        ${d.recentMovements.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Product</th><th>Size / colour</th><th>Change</th><th>Reason</th><th>On hand after</th></tr></thead><tbody>${d.recentMovements.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.product)}</td><td>${esc(m.variant)}</td><td><strong>${m.change > 0 ? "+" : ""}${m.change}</strong></td><td>${esc(m.reason)}</td><td>${m.onHandAfter}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No stock movements yet.</p>`}`;
      labelTables($("[data-body]"));
      drawAlerts();
      if (a.note) $("[data-alerts]").insertAdjacentHTML("afterbegin", `<p class="muted">${esc(a.note)}</p>`);
    } catch (e) {
      if (alive()) {
        $("[data-body]").innerHTML = errorState(messageOf(e));
        $("[data-body]").querySelector("[data-retry]")?.addEventListener("click", load);
        $("[data-alerts]").innerHTML = "";
      }
    }
  }

  $("#al-kind").addEventListener("change", drawAlerts);
  $("[data-settings]")?.addEventListener("click", async () => {
    const s = await call("getInventorySettings", {}).catch(() => null);
    if (!s) return toast("Couldn't load the settings.", "error");
    formDialog({
      title: "Alert settings",
      intro: "Used for every size/colour that has no minimum of its own. A larger adjustment than the limits below needs an approver.",
      body: row("lowStock", "Low-stock alert at (pairs)", input("lowStock", `inputmode="numeric" value="${s.lowStock}"`)) + row("slowDays", "Slow-moving: no sale for (days)", input("slowDays", `inputmode="numeric" value="${s.slowDays}"`)) + row("deadDays", "Dead stock: no movement for (days)", input("deadDays", `inputmode="numeric" value="${s.deadDays}"`)) + row("adjustApprovalUnits", "Adjustments of this many pairs or more need approval (0 = never)", input("adjustApprovalUnits", `inputmode="numeric" value="${s.adjustApprovalUnits}"`)) + row("adjustApprovalValue", "…or worth this much at cost, Rs (0 = never)", input("adjustApprovalValue", `inputmode="decimal" value="${s.adjustApprovalValue / 100}"`)),
      submit: "Save",
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const value = toPaisa(f.get("adjustApprovalValue"));
        if (value === null) return show("Enter the value in rupees.", { adjustApprovalValue: "Number" });
        await call("saveInventorySettings", { lowStock: Number(f.get("lowStock")), slowDays: Number(f.get("slowDays")), deadDays: Number(f.get("deadDays")), adjustApprovalUnits: Number(f.get("adjustApprovalUnits")), adjustApprovalValue: value });
        close();
        toast("Saved");
        load();
      },
    });
  });
  await load();
}
