/**
 * Stock adjustments: a recorded change (previous → new quantity, reason, who) — never an overwrite. Large ones wait for an
 * approver. Cost revaluation (approvers) changes a variant's average cost and posts the difference to the books.
 */
import { esc } from "../../lib/format.js";
import { ADJUST_REASONS } from "../../../shared/inventory.js";
import { toast, errorState, confirmDialog } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call, pageOf } from "../purchData.js";
import { listProducts, listVariants, listWarehouses, getInventoryDoc, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { money, messageOf, toPaisa, labelTables } from "../financeUi.js";

const TAG = { applied: "tag", pending: "tag tag--low", rejected: "tag tag--out" };
let productCache = null;

export default async function stockAdjustments({ main, user }) {
  const can = (p) => user.perms.includes(p);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Stock <em>adjustments</em></h1>
        <p class="muted">Every change to stock is recorded with the previous and new quantity, the reason and who did it. Damaged, lost and missing pairs (and count differences) are written off at cost in the books.</p>
        <p>${can("inventory.adjust") ? `<button type="button" class="btn btn--primary" data-new><span>New adjustment</span></button> ` : ""}${can("inventory.approve") ? `<button type="button" class="btn btn--ghost" data-cost>Revalue cost</button>` : ""}</p></header>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const list = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  let rows = [];
  let last = null;
  let more = false;

  const draw = () => {
    list.innerHTML = rows.length
      ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Ref</th><th>Item</th><th>Warehouse</th><th>Reason</th><th>Previous</th><th>Change</th><th>New</th><th>Status</th><th></th></tr></thead><tbody>${rows
          .map((a) => `<tr><td>${esc(a.createdAt?.toDate ? a.createdAt.toDate().toLocaleDateString("en-PK") : "—")}</td><td><code>${esc(a.number)}</code></td><td><strong>${esc(a.productName)}</strong><br /><span class="muted">${esc(a.variantLabel)}${a.sku ? ` · ${esc(a.sku)}` : ""}</span><br /><span class="muted">${esc(a.description)}</span></td><td>${esc(a.warehouseName)}</td><td>${esc(ADJUST_REASONS[a.reason]?.label ?? a.reason)}</td><td>${a.previousQty ?? "—"}</td><td><strong>${a.changeQty > 0 ? "+" : ""}${a.changeQty}</strong>${a.value ? `<br /><span class="muted">${esc(money(a.value))}</span>` : a.costMissing ? `<br /><span class="muted">no cost</span>` : ""}</td><td>${a.newQty ?? "—"}</td><td><span class="${TAG[a.status] ?? "tag"}">${esc(a.status)}</span><br /><span class="muted">${esc(a.createdByName ?? "")}</span></td><td class="adm-actions">${a.status === "pending" && can("inventory.approve") ? `<button type="button" class="text-btn" data-approve="${esc(a.id)}">Approve</button> <button type="button" class="text-btn" data-reject="${esc(a.id)}">Reject</button>` : ""}</td></tr>`)
          .join("")}</tbody></table></div>${more ? `<p class="adm-table__more"><button type="button" class="btn btn--ghost" data-more>Load more</button></p>` : ""}`
      : `<p class="muted">No adjustments yet.</p>`;
    labelTables(list);
  };
  async function load(reset = true) {
    try {
      const p = await pageOf("stockAdjustments", { orderBy: ["createdAt", "desc"], after: reset ? null : last, size: 25 });
      if (!alive()) return;
      last = p.last;
      more = p.hasMore;
      rows = reset ? p.rows : rows.concat(p.rows);
      draw();
    } catch (e) {
      if (alive()) {
        list.innerHTML = errorState(messageOf(e));
        list.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
      }
    }
  }

  /** product → variant pickers shared by the two dialogs. */
  async function pickers(form, { withWarehouse }) {
    productCache ??= (await listProducts()).filter((p) => p.status !== "archived");
    const f = /** @type {any} */ (form.elements);
    const info = /** @type {HTMLElement} */ (form.querySelector("[data-info]"));
    const refresh = async () => {
      if (!f.variantId.value) return void (info.textContent = "");
      const inv = await getInventoryDoc(f.productId.value, f.variantId.value).catch(() => null);
      const wid = withWarehouse ? f.warehouseId.value : null;
      const e = wid ? inv?.byWarehouse?.[wid] ?? (wid === "main" && !inv?.byWarehouse ? { onHand: inv?.onHand ?? 0 } : { onHand: 0 }) : null;
      info.textContent = wid ? `In stock there now: ${e?.onHand ?? 0}` : `On hand in all warehouses: ${inv?.totalOnHand ?? inv?.onHand ?? 0}`;
      info.dataset.seen = wid ? String(e?.onHand ?? 0) : "";
    };
    f.productId.addEventListener("change", async () => {
      f.variantId.innerHTML = `<option value="">Loading…</option>`;
      const vs = f.productId.value ? await listVariants(f.productId.value).catch(() => []) : [];
      f.variantId.innerHTML = `<option value="">Size / colour…</option>${vs.map((v) => `<option value="${esc(v.id)}">${esc(v.colorName)} · ${esc(v.sizeLabel)}</option>`).join("")}`;
      refresh();
    });
    f.variantId.addEventListener("change", refresh);
    f.warehouseId?.addEventListener("change", refresh);
  }
  const productSelect = () => `<div class="field" data-field="productId"><label for="pd-productId">Product</label><select id="pd-productId" name="productId"><option value="">Choose…</option>${(productCache ?? []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select><p class="field-error" hidden></p></div><div class="field" data-field="variantId"><label for="pd-variantId">Size / colour</label><select id="pd-variantId" name="variantId"><option value="">Size / colour…</option></select><p class="field-error" hidden></p></div><p class="muted" data-info></p>`;

  main.querySelector("[data-new]")?.addEventListener("click", async () => {
    productCache ??= (await listProducts().catch(() => [])).filter((p) => p.status !== "archived");
    let whs = await listWarehouses().catch(() => []);
    whs = (whs.some((w) => w.id === "main") ? whs : [VIRTUAL_DEFAULT_WAREHOUSE, ...whs]).filter((w) => w.isActive !== false);
    const idem = newKey();
    formDialog({
      title: "New stock adjustment",
      wide: true,
      body: productSelect() + row("warehouseId", "Warehouse", select("warehouseId", whs.map((w) => [w.id, w.name]), "main")) + row("reason", "Reason", select("reason", Object.entries(ADJUST_REASONS).map(([k, v]) => [k, v.label]), "correction")) + row("direction", "Direction (for corrections and other reasons)", select("direction", [["out", "Remove pairs"], ["in", "Add pairs"]])) + row("qty", "Number of pairs", input("qty", 'inputmode="numeric"')) + row("description", "Description", input("description", 'maxlength="300" placeholder="What happened?"')),
      submit: "Record adjustment",
      onOpen: (form) => pickers(form, { withWarehouse: true }),
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const reason = String(f.get("reason"));
        const dir = ADJUST_REASONS[reason].dir === "either" ? String(f.get("direction")) : ADJUST_REASONS[reason].dir;
        const qty = Number(f.get("qty"));
        if (!Number.isInteger(qty) || qty < 1) return show("Enter a whole number of pairs.", { qty: "Required" });
        if (!f.get("variantId")) return show("Choose the size/colour.", { variantId: "Required" });
        const seen = /** @type {HTMLElement} */ (form.querySelector("[data-info]")).dataset.seen;
        const r = await call("createStockAdjustment", { idempotencyKey: idem, productId: String(f.get("productId")), variantId: String(f.get("variantId")), warehouseId: String(f.get("warehouseId")), reason, change: dir === "out" ? -qty : qty, description: String(f.get("description") ?? "").trim(), ...(seen ? { seenOnHand: Number(seen) } : {}) });
        close();
        toast(r.status === "pending" ? `${r.number} saved — waiting for approval` : `${r.number}: ${r.previousQty} → ${r.newQty}`);
        load(true);
      },
    });
  });

  main.querySelector("[data-cost]")?.addEventListener("click", async () => {
    productCache ??= (await listProducts().catch(() => [])).filter((p) => p.status !== "archived");
    const idem = newKey();
    formDialog({
      title: "Revalue a cost",
      intro: "Changes the weighted average cost of one size/colour. The difference on the pairs in stock is posted to the books (Inventory ↔ Inventory adjustments) and the change is kept in the cost history.",
      body: productSelect() + row("newCost", "New cost per pair (Rs)", input("newCost", 'inputmode="decimal"')) + row("reason", "Reason", input("reason", 'maxlength="200"')),
      submit: "Revalue",
      onOpen: (form) => pickers(form, { withWarehouse: false }),
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const cost = toPaisa(f.get("newCost"));
        if (!cost) return show("Enter the new cost in rupees.", { newCost: "Required" });
        if (!f.get("variantId")) return show("Choose the size/colour.", { variantId: "Required" });
        const r = await call("adjustVariantCost", { idempotencyKey: idem, productId: String(f.get("productId")), variantId: String(f.get("variantId")), newCost: cost, reason: String(f.get("reason") ?? "").trim() });
        close();
        toast(r.value ? `Cost changed; ${money(Math.abs(r.value))} ${r.value > 0 ? "added to" : "taken off"} the stock value.` : "Cost changed.");
      },
    });
  });

  list.addEventListener("click", async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("button");
    if (!b) return;
    if (b.hasAttribute("data-more")) return load(false);
    const id = b.dataset.approve ?? b.dataset.reject;
    if (!id) return;
    const decision = b.dataset.approve ? "approve" : "reject";
    if (!(await confirmDialog({ title: decision === "approve" ? "Approve this adjustment?" : "Reject this adjustment?", body: decision === "approve" ? "The stock changes now, against what is in stock at this moment." : "Nothing will change.", confirm: decision === "approve" ? "Approve" : "Reject", danger: decision === "reject" }))) return;
    try {
      await call("decideStockAdjustment", { id, decision });
      toast(decision === "approve" ? "Approved and applied" : "Rejected");
      load(true);
    } catch (err) {
      toast(messageOf(err), "error");
    }
  });
  await load(true);
}
