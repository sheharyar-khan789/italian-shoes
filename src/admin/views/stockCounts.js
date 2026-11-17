/**
 * Physical stock counts: start a count of one warehouse, enter what is physically there, submit, approve and apply.
 * Applying changes stock by (counted − system quantity when counted), so sales and receipts that happened after the
 * count are kept. One open count per warehouse.
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, confirmDialog } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call, pageOf, getRow } from "../purchData.js";
import { listProducts, listVariants, listWarehouses, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { money, messageOf, labelTables } from "../financeUi.js";

const TAG = { counting: "tag tag--low", submitted: "tag tag--low", approved: "tag", applying: "tag", applied: "tag", rejected: "tag tag--out", cancelled: "tag tag--out" };

export default async function stockCounts({ main, user, params, navigate }) {
  const can = (p) => user.perms.includes(p);
  if (params[0]) return detail(params[0]);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Stock <em>counts</em></h1>
        <p class="muted">Count what is physically on the shelves, compare it with the system, and apply the differences once approved. Only one count can be open per warehouse.</p>
        ${can("inventory.count") ? `<p><button type="button" class="btn btn--primary" data-new><span>Start a count</span></button></p>` : ""}</header>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const list = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  try {
    const p = await pageOf("stockCounts", { orderBy: ["createdAt", "desc"], size: 50 });
    if (!alive()) return;
    list.innerHTML = p.rows.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Count</th><th>Warehouse</th><th>Started</th><th>Status</th><th>Items counted</th><th>With a difference</th><th></th></tr></thead><tbody>${p.rows.map((c) => `<tr><td><strong>${esc(c.number)}</strong>${c.name ? `<br /><span class="muted">${esc(c.name)}</span>` : ""}</td><td>${esc(c.warehouseName)}</td><td>${esc(c.createdAt?.toDate ? c.createdAt.toDate().toLocaleDateString("en-PK") : "—")}<br /><span class="muted">${esc(c.startedByName ?? "")}</span></td><td><span class="${TAG[c.status] ?? "tag"}">${esc(c.status)}</span></td><td>${c.summary?.counted ?? Object.values(c.lines ?? {}).filter((l) => l.countedQty !== null).length}</td><td>${c.summary?.withVariance ?? "—"}</td><td class="adm-actions"><a class="text-link" href="/admin/stock-counts/${esc(c.id)}" data-link>Open</a></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No counts yet.</p>`;
    labelTables(list);
  } catch (e) {
    list.innerHTML = errorState(messageOf(e));
  }
  main.querySelector("[data-new]")?.addEventListener("click", async () => {
    let whs = await listWarehouses().catch(() => []);
    whs = (whs.some((w) => w.id === "main") ? whs : [VIRTUAL_DEFAULT_WAREHOUSE, ...whs]).filter((w) => w.isActive !== false);
    const idem = newKey();
    formDialog({
      title: "Start a stock count",
      intro: "Lists every size/colour the system says this warehouse holds. Enter what you actually find.",
      body: row("warehouseId", "Warehouse", select("warehouseId", whs.map((w) => [w.id, w.name]), "main")) + row("name", "Name (optional)", input("name", 'maxlength="80" placeholder="e.g. Monthly count"')),
      submit: "Start count",
      onSubmit: async (form, { close }) => {
        const f = new FormData(form);
        const r = await call("startStockCount", { idempotencyKey: idem, warehouseId: String(f.get("warehouseId")), name: String(f.get("name") ?? "").trim() });
        close();
        toast(`${r.number} started`);
        navigate?.(`/admin/stock-counts/${r.id}`);
      },
    });
  });

  /* ───── One count ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    const draw = async () => {
      let c;
      try {
        c = await getRow("stockCounts", id);
      } catch (e) {
        page.innerHTML = errorState(messageOf(e));
        return;
      }
      if (!c) return void (page.innerHTML = `<p>That count doesn't exist. <a class="text-link" href="/admin/stock-counts" data-link>Back</a></p>`);
      const lines = Object.entries(c.lines ?? {}).map(([k, l]) => ({ k, ...l })).sort((a, b) => a.productName.localeCompare(b.productName) || a.variantLabel.localeCompare(b.variantLabel));
      const editing = c.status === "counting" && can("inventory.count");
      const counted = lines.filter((l) => l.countedQty !== null && l.countedQty !== undefined);
      const shortU = counted.filter((l) => l.variance < 0).reduce((n, l) => n - l.variance, 0);
      const overU = counted.filter((l) => l.variance > 0).reduce((n, l) => n + l.variance, 0);
      page.innerHTML = `
        <p><a class="text-link" href="/admin/stock-counts" data-link>← Stock counts</a></p>
        <header class="adm-page__head"><h1 class="adm-h1">${esc(c.number)} <span class="${TAG[c.status] ?? "tag"}">${esc(c.status)}</span></h1>
          <p>${esc(c.warehouseName)}${c.name ? ` · ${esc(c.name)}` : ""} · ${counted.length} of ${lines.length} counted · <strong>${shortU}</strong> short · <strong>${overU}</strong> over${c.flagged ? ` · <strong>${c.flagged} line(s) need attention</strong>` : ""}</p>
          <p>
            ${editing ? `<button type="button" class="btn btn--ghost" data-add>Add an item</button> <button type="button" class="btn btn--primary" data-submit>Submit for approval</button> ` : ""}
            ${c.status === "submitted" && can("inventory.approve") ? `<button type="button" class="btn btn--primary" data-approve>Approve</button> <button type="button" class="btn btn--ghost" data-reject>Reject</button> ` : ""}
            ${["approved", "applying"].includes(c.status) && can("inventory.approve") ? `<button type="button" class="btn btn--primary" data-apply>Apply to stock</button> ` : ""}
            ${["counting", "submitted", "approved"].includes(c.status) && can("inventory.count") ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel count</button>` : ""}
          </p></header>
        <p class="muted">Applying adds or removes the counted DIFFERENCE, so a sale or receipt recorded after you counted an item is kept.</p>
        <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Item</th><th>System</th><th>Counted</th><th>Difference</th><th>Value</th><th>Result</th></tr></thead><tbody>${lines
          .map((l) => `<tr><td><strong>${esc(l.productName)}</strong><br /><span class="muted">${esc(l.variantLabel)} · ${esc(l.sku)}</span></td><td>${l.systemQty}</td><td>${editing ? `<input type="number" min="0" step="1" inputmode="numeric" data-count="${esc(l.k)}" value="${l.countedQty ?? ""}" aria-label="Counted ${esc(l.productName)} ${esc(l.variantLabel)}" style="width:5rem" />` : (l.countedQty ?? "—")}</td><td>${l.variance === null || l.variance === undefined ? "—" : `<strong class="${l.variance < 0 ? "is-bad" : ""}">${l.variance > 0 ? "+" : ""}${l.variance}</strong>`}</td><td>${l.variance && l.unitCost !== null ? esc(money(l.variance * l.unitCost)) : l.variance ? "no cost" : "—"}</td><td>${l.applied ? `Applied (${l.applied.onHandBefore} → ${l.applied.onHandAfter})` : l.error ? `<span class="tag tag--out">${esc(l.error)}</span>` : l.appliedAt ? "No change" : "—"}</td></tr>`)
          .join("")}</tbody></table></div>`;
      labelTables(page);
      const act = (sel, fn) => page.querySelector(sel)?.addEventListener("click", async () => {
        try {
          await fn();
          draw();
        } catch (e) {
          toast(messageOf(e), "error");
        }
      });
      page.querySelectorAll("[data-count]").forEach((inp) =>
        inp.addEventListener("change", async () => {
          const [productId, variantId] = /** @type {HTMLElement} */ (inp).dataset.count.split("__");
          const v = /** @type {HTMLInputElement} */ (inp).value;
          if (v === "") return;
          try {
            const r = await call("saveStockCountLine", { sessionId: id, productId, variantId, countedQty: Number(v) });
            toast(`${r.variance === 0 ? "Matches" : `${r.variance > 0 ? "+" : ""}${r.variance}`} (system ${r.systemQty})`);
            draw();
          } catch (e) {
            toast(messageOf(e), "error");
          }
        }),
      );
      act("[data-submit]", async () => {
        const r = await call("submitStockCount", { id });
        toast(`Submitted: ${r.summary.withVariance} item(s) with a difference`);
      });
      act("[data-approve]", async () => {
        if (!(await confirmDialog({ title: "Approve this count?", body: "You can then apply it to the stock.", confirm: "Approve" }))) throw new Error("Not approved.");
        await call("decideStockCount", { id, decision: "approve" });
      });
      act("[data-reject]", async () => {
        await call("decideStockCount", { id, decision: "reject" });
        toast("Rejected; the warehouse can be counted again.");
      });
      act("[data-apply]", async () => {
        const r = await call("applyStockCount", { id });
        toast(r.flagged ? `Applied; ${r.flagged} line(s) need attention` : `Applied to stock (${r.applied} item(s) changed)`);
      });
      act("[data-cancel]", async () => {
        if (!(await confirmDialog({ title: "Cancel this count?", body: "Nothing has been applied to stock.", confirm: "Cancel count", danger: true }))) throw new Error("Kept.");
        await call("cancelStockCount", { id });
      });
      page.querySelector("[data-add]")?.addEventListener("click", async () => {
        const prods = (await listProducts().catch(() => [])).filter((p) => p.status !== "archived");
        formDialog({
          title: "Count another item",
          body: `<div class="field"><label for="pd-pid">Product</label><select id="pd-pid" name="pid"><option value="">Choose…</option>${prods.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label for="pd-vid">Size / colour</label><select id="pd-vid" name="vid"><option value="">Choose a product first</option></select></div>${row("qty", "Counted pairs", input("qty", 'inputmode="numeric"'))}`,
          submit: "Add",
          onOpen: (form) => {
            const f = /** @type {any} */ (form.elements);
            f.pid.addEventListener("change", async () => {
              const vs = f.pid.value ? await listVariants(f.pid.value).catch(() => []) : [];
              f.vid.innerHTML = `<option value="">Size / colour…</option>${vs.map((v) => `<option value="${esc(v.id)}">${esc(v.colorName)} · ${esc(v.sizeLabel)}</option>`).join("")}`;
            });
          },
          onSubmit: async (form, { show, close }) => {
            const f = new FormData(form);
            const qty = Number(f.get("qty"));
            if (!f.get("vid") || !Number.isInteger(qty) || qty < 0) return show("Choose the item and enter the counted pairs.");
            await call("saveStockCountLine", { sessionId: id, productId: String(f.get("pid")), variantId: String(f.get("vid")), countedQty: qty });
            close();
            draw();
          },
        });
      });
    };
    await draw();
  }
}
