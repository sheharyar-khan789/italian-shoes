/**
 * Stock transfers between warehouses: draft → send → receive (or cancel a draft). Nothing moves until
 * "Send": that takes the pairs out of the source warehouse, and "Receive" puts them into the destination.
 * The server checks stock, refuses double steps and never leaves a transfer half-applied.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState, dataTable, formatWhen } from "../ui/kit.js";
import { call, listTransfers, listWarehouses, listProducts, listVariants, getInventoryDoc, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { formDialog, newKey } from "../ui/purchasing.js";
import { saveTransferInput, receiveTransferLinesInput, fieldErrors, DEFAULT_WAREHOUSE_ID } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

const STATUS = {
  draft: ["Draft", "tag"],
  requested: ["Requested", "tag tag--low"],
  in_transit: ["Dispatched", "tag tag--low"],
  partially_received: ["Partially received", "tag tag--low"],
  received: ["Received", "tag"],
  cancelled: ["Cancelled", "tag tag--out"],
};

export default async function transfers({ main, user }) {
  const canManage = user.perms.includes("transfers.manage");
  let rows = [];
  let warehouses = [VIRTUAL_DEFAULT_WAREHOUSE];
  /** @type {any[] | null} */
  let productList = null;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const whName = (id) => warehouses.find((w) => w.id === id)?.name ?? "Unknown warehouse";

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Stock <em>transfers</em></h1>
        <p class="muted">Move pairs from one warehouse to another. A draft moves nothing. <strong>Send</strong> takes the pairs out of the source; <strong>Receive</strong> puts them into the destination. A sent transfer can't be cancelled, so stock is never lost half-way.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>New transfer</span></button></p>` : ""}
      </header>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const listEl = main.querySelector("[data-list]");

  const table = dataTable({
    caption: "Stock transfers",
    empty: { title: "No transfers yet", text: canManage ? "Create one with “New transfer”." : "" },
    columns: [
      { key: "number", label: "Transfer", render: (r) => `<strong>${esc(r.number)}</strong>` },
      { key: "route", label: "From → To", render: (r) => `${esc(r.fromName ?? whName(r.fromWarehouseId))} → ${esc(r.toName ?? whName(r.toWarehouseId))}` },
      { key: "itemCount", label: "Pairs", render: (r) => String(r.itemCount ?? 0) },
      { key: "status", label: "Status", render: (r) => `<span class="${STATUS[r.status]?.[1] ?? "tag"}">${esc(STATUS[r.status]?.[0] ?? r.status)}</span>` },
      { key: "createdAt", label: "Created", render: (r) => esc(formatWhen(r.createdAt)) },
      {
        key: "actions",
        label: "",
        className: "adm-actions",
        render: (r) =>
          `<button type="button" class="text-btn" data-view="${esc(r.id)}">View</button>` +
          (canManage && r.status === "draft" ? ` <button type="button" class="text-btn" data-edit="${esc(r.id)}">Edit</button> <button type="button" class="text-btn" data-request="${esc(r.id)}">Request</button> <button type="button" class="text-btn" data-send="${esc(r.id)}">Send</button> <button type="button" class="text-btn" data-cancel="${esc(r.id)}">Cancel</button>` : "") +
          (canManage && r.status === "requested" ? ` <button type="button" class="text-btn" data-send="${esc(r.id)}">Dispatch</button> <button type="button" class="text-btn" data-cancel="${esc(r.id)}">Cancel</button>` : "") +
          (canManage && ["in_transit", "partially_received"].includes(r.status) ? ` <button type="button" class="text-btn" data-receive="${esc(r.id)}">Receive</button>` : ""),
      },
    ],
  });

  async function load() {
    try {
      const [t, w] = await Promise.all([listTransfers(), listWarehouses()]);
      if (!alive()) return;
      warehouses = w.some((x) => x.id === DEFAULT_WAREHOUSE_ID) ? w : [VIRTUAL_DEFAULT_WAREHOUSE, ...w];
      rows = t;
      table.set(rows);
      listEl.replaceChildren(table.el);
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }

  /** Run a lifecycle step after confirmation; the server refuses anything that isn't allowed. */
  async function act(fn, id, { title, body, confirm, done }) {
    if (!(await confirmDialog({ title, body, confirm }))) return;
    try {
      await call(fn, { id });
      toast(done);
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
    await load();
  }

  function viewDialog(t) {
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide";
    d.setAttribute("aria-labelledby", "tv-title");
    d.innerHTML = `
      <h2 id="tv-title">${esc(t.number)} · ${esc(STATUS[t.status]?.[0] ?? t.status)}</h2>
      <p>${esc(t.fromName ?? whName(t.fromWarehouseId))} → ${esc(t.toName ?? whName(t.toWarehouseId))}${t.note ? `<br /><span class="muted">${esc(t.note)}</span>` : ""}</p>
      <ul class="adm-feed">${(t.lines ?? []).map((l) => `<li><span><strong>${l.qty}</strong> × ${esc(l.productName)} · ${esc(l.variantLabel)}<br /><span class="muted"><code>${esc(l.sku ?? "")}</code></span></span></li>`).join("")}</ul>
      <div class="adm-dialog__actions"><button type="button" class="btn btn--ghost" data-close>Close</button></div>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    d.showModal();
  }

  /** New transfer, or edit a draft. */
  async function editDialog(existing = null) {
    const active = warehouses.filter((w) => w.isActive !== false);
    if (active.length < 2) {
      toast("You need at least two warehouses (switched on) to transfer stock. Add one under Warehouses.", "error");
      return;
    }
    try {
      productList ??= (await listProducts()).filter((p) => p.status !== "archived");
    } catch {
      toast("Products couldn't be loaded. Try again.", "error");
      return;
    }
    /** @type {{ productId: string, variantId: string, qty: number, label: string }[]} */
    const lines = (existing?.lines ?? []).map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, label: `${l.productName} · ${l.variantLabel}` }));
    const opt = (w, sel) => `<option value="${esc(w.id)}" ${w.id === sel ? "selected" : ""}>${esc(w.name)}</option>`;
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide";
    d.setAttribute("aria-labelledby", "te-title");
    d.innerHTML = `
      <form novalidate data-form>
        <h2 id="te-title">${existing ? `Edit ${esc(existing.number)}` : "New transfer"}</h2>
        <p class="form-alert" role="alert" data-form-alert hidden></p>
        <div class="field" data-field="fromWarehouseId"><label for="te-from">From</label>
          <select id="te-from" name="from">${active.map((w) => opt(w, existing?.fromWarehouseId ?? DEFAULT_WAREHOUSE_ID)).join("")}</select><p class="field-error" hidden></p></div>
        <div class="field" data-field="toWarehouseId"><label for="te-to">To</label>
          <select id="te-to" name="to">${active.map((w) => opt(w, existing?.toWarehouseId ?? active.find((x) => x.id !== DEFAULT_WAREHOUSE_ID)?.id)).join("")}</select><p class="field-error" hidden></p></div>
        <div class="field" data-field="note"><label for="te-note">Note <span class="muted">(optional)</span></label>
          <input id="te-note" name="note" maxlength="300" value="${esc(existing?.note ?? "")}" /><p class="field-error" hidden></p></div>
        <fieldset class="field" data-field="lines"><legend>Items</legend>
          <div class="adm-inline">
            <select name="product" aria-label="Product"><option value="">Product…</option>${productList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
            <select name="variant" aria-label="Size and colour" disabled><option value="">Size / colour…</option></select>
            <input name="qty" type="number" min="1" step="1" value="1" aria-label="Pairs" />
            <button type="button" class="btn btn--ghost" data-add>Add</button>
          </div>
          <p class="muted" data-avail></p>
          <ul class="adm-feed" data-lines></ul>
          <p class="field-error" hidden></p>
        </fieldset>
        <div class="adm-dialog__actions">
          <button type="button" class="btn btn--ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn--primary"><span>Save draft</span></button>
        </div>
      </form>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.querySelector("[data-close]").addEventListener("click", () => d.close());
    const form = /** @type {HTMLFormElement} */ (d.querySelector("[data-form]"));
    const $ = (n) => /** @type {any} */ (form.elements.namedItem(n));
    const linesEl = form.querySelector("[data-lines]");
    const availEl = form.querySelector("[data-avail]");
    /** @type {any[]} */
    let variants = [];

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
    const drawLines = () => {
      linesEl.innerHTML = lines.length ? lines.map((l, i) => `<li><span><strong>${l.qty}</strong> × ${esc(l.label)}</span><button type="button" class="text-btn" data-remove="${i}">Remove</button></li>`).join("") : `<li class="muted">No items yet.</li>`;
    };
    const showAvailable = async () => {
      availEl.textContent = "";
      if (!$("product").value || !$("variant").value) return;
      const doc = await getInventoryDoc($("product").value, $("variant").value).catch(() => null);
      const e = (doc?.byWarehouse ?? { [DEFAULT_WAREHOUSE_ID]: { onHand: doc?.onHand ?? 0, reserved: doc?.reserved ?? 0 } })[$("from").value] ?? { onHand: 0, reserved: 0 };
      availEl.textContent = `Available in ${whName($("from").value)}: ${e.onHand - e.reserved}`;
    };
    $("product").addEventListener("change", async () => {
      $("variant").disabled = true;
      $("variant").innerHTML = `<option value="">Loading…</option>`;
      variants = $("product").value ? await listVariants($("product").value).catch(() => []) : [];
      $("variant").innerHTML = `<option value="">Size / colour…</option>${variants.map((v) => `<option value="${esc(v.id)}">${esc(v.colorName)} · ${esc(v.sizeLabel)}</option>`).join("")}`;
      $("variant").disabled = !variants.length;
      showAvailable();
    });
    $("variant").addEventListener("change", showAvailable);
    $("from").addEventListener("change", showAvailable);
    form.querySelector("[data-add]").addEventListener("click", () => {
      const productId = $("product").value;
      const variantId = $("variant").value;
      const qty = Number($("qty").value);
      if (!productId || !variantId) return show("Choose a product and a size/colour first.");
      if (!Number.isInteger(qty) || qty < 1) return show("Enter a whole number of pairs, 1 or more.");
      if (lines.some((l) => l.productId === productId && l.variantId === variantId)) return show("That size/colour is already in the list.");
      const v = variants.find((x) => x.id === variantId);
      lines.push({ productId, variantId, qty, label: `${productList.find((p) => p.id === productId)?.name ?? "Product"} · ${v?.colorName} · ${v?.sizeLabel}` });
      show("");
      drawLines();
    });
    linesEl.addEventListener("click", (e) => {
      const rm = /** @type {HTMLElement} */ (e.target).closest("[data-remove]");
      if (!rm) return;
      lines.splice(Number(/** @type {HTMLElement} */ (rm).dataset.remove), 1);
      drawLines();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const parsed = saveTransferInput.safeParse({
        ...(existing ? { id: existing.id } : {}),
        fromWarehouseId: $("from").value,
        toWarehouseId: $("to").value,
        note: $("note").value,
        lines: lines.map(({ productId, variantId, qty }) => ({ productId, variantId, qty })),
      });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      const btn = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
      btn.disabled = true;
      try {
        await call("saveTransfer", parsed.data);
        d.close();
        toast("Draft saved. Press Send when the pairs leave.");
        await load();
      } catch (error) {
        const r = fnResult(error);
        show(r.message, r.fields);
        btn.disabled = false;
      }
    });
    drawLines();
    d.showModal();
  }

  /** Receive what arrived — all of it or part — and report damaged and missing pairs. */
  function receiveDialog(t) {
    const open = t.lines.map((l, i) => ({ l, i, out: l.qty - (l.receivedQty ?? 0) - (l.damagedQty ?? 0) - (l.missingQty ?? 0) })).filter((x) => x.out > 0);
    if (!open.length) return toast("Everything on this transfer is already accounted for.", "error");
    const key = newKey();
    formDialog({
      title: `Receive ${t.number}`,
      intro: `Into <strong>${esc(t.toName)}</strong>. Enter what arrived; pairs that arrived damaged or never arrived are written off at cost. Leave the rest to receive later.`,
      wide: true,
      body: `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Item</th><th>Still to account for</th><th>Arrived OK</th><th>Arrived damaged</th><th>Missing</th></tr></thead><tbody>${open.map((x) => `<tr><td>${esc(x.l.productName)}<br /><span class="muted">${esc(x.l.variantLabel)}</span></td><td>${x.out}<br /><span class="muted">of ${x.l.qty}</span></td><td><input name="rec-${x.i}" type="number" min="0" max="${x.out}" step="1" value="${x.out}" aria-label="Arrived OK" /></td><td><input name="dmg-${x.i}" type="number" min="0" max="${x.out}" step="1" value="0" aria-label="Damaged" /></td><td><input name="mis-${x.i}" type="number" min="0" max="${x.out}" step="1" value="0" aria-label="Missing" /></td></tr>`).join("")}</tbody></table></div><div data-field="lines"><p class="field-error" hidden></p></div>`,
      submit: "Confirm receipt",
      onSubmit: async (form, { show, close }) => {
        const f = /** @type {any} */ (form.elements);
        const lines = open.map((x) => ({ lineIndex: x.i, receivedQty: Number(f[`rec-${x.i}`].value || 0), damagedQty: Number(f[`dmg-${x.i}`].value || 0), missingQty: Number(f[`mis-${x.i}`].value || 0) })).filter((l) => l.receivedQty + l.damagedQty + l.missingQty > 0);
        const parsed = receiveTransferLinesInput.safeParse({ idempotencyKey: key, id: t.id, lines });
        if (!parsed.success) return show("Please check the quantities.", fieldErrors(parsed.error));
        const r = await call("receiveTransferLines", parsed.data);
        close();
        toast(r.status === "received" ? "Received in full." : "Partly received — the rest is still on its way.");
        load();
      },
    });
  }

  main.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("[data-new]")) return editDialog();
    const reqd = rows.find((r) => r.id === /** @type {HTMLElement | null} */ (t.closest("[data-request]"))?.dataset.request);
    if (t.closest("[data-request]") && reqd) return act("requestTransfer", reqd.id, { title: `Request ${reqd.number}?`, body: "This records the request. No stock moves until it is dispatched.", confirm: "Request", done: "Requested." });
    const pick = (attr) => rows.find((r) => r.id === /** @type {HTMLElement | null} */ (t.closest(`[${attr}]`))?.dataset[attr.replace("data-", "")]);
    const view = pick("data-view");
    if (t.closest("[data-view]") && view) return viewDialog(view);
    const edit = pick("data-edit");
    if (t.closest("[data-edit]") && edit) return editDialog(edit);
    const send = pick("data-send");
    if (t.closest("[data-send]") && send) return act("sendTransfer", send.id, { title: `Send ${send.number}?`, body: `This takes ${send.itemCount} pair(s) out of ${send.fromName}. Once sent, it can't be cancelled.`, confirm: "Send", done: "Sent — the pairs are now on their way." });
    const receive = pick("data-receive");
    if (t.closest("[data-receive]") && receive) return receiveDialog(receive);
    const cancel = pick("data-cancel");
    if (t.closest("[data-cancel]") && cancel) return act("cancelTransfer", cancel.id, { title: `Cancel ${cancel.number}?`, body: "Nothing has moved yet, so no stock changes.", confirm: "Cancel transfer", done: "Transfer cancelled." });
  });

  await load();
}
