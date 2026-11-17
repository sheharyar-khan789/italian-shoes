/**
 * Warehouses: the places stock is kept. Create and edit them, switch them on or off, and choose which ones
 * count as available to online customers. The default warehouse holds all stock that existed before this
 * screen did. Every change goes through the server, which checks permission, input and (for switching off)
 * that no stock or open transfer would be stranded.
 */
import { esc } from "../../lib/format.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, dataTable } from "../ui/kit.js";
import { call, listWarehouses, rebuildOnlineStock, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { saveWarehouseInput, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

export default async function warehouses({ main, user }) {
  const canManage = user.perms.includes("warehouses.manage");
  let rows = [];
  let editing = null;

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Ware<em>houses</em></h1>
        <p class="muted">Where your stock is kept. "Sells online" means customers on the website can buy what is stored there. A warehouse can only be switched off while it holds no stock and has no unfinished transfer.</p>
      </header>
      <p class="muted" data-status role="status" hidden></p>
      <div class="adm-split">
        <section data-list aria-label="Warehouses"><p class="muted">Loading…</p></section>
        <section data-form-wrap aria-label="Add or edit a warehouse"></section>
      </div>
    </div>`;
  const listEl = main.querySelector("[data-list]");
  const formWrap = main.querySelector("[data-form-wrap]");
  const statusEl = /** @type {HTMLElement} */ (main.querySelector("[data-status]"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;

  const table = dataTable({
    caption: "Warehouses",
    empty: { title: "No warehouses yet" },
    columns: [
      { key: "name", label: "Name", render: (r) => `<strong>${esc(r.name)}</strong>${r.isDefault ? ` <span class="tag">Default</span>` : ""}${r.description ? `<br /><span class="muted">${esc(r.description)}</span>` : ""}` },
      { key: "code", label: "Code", render: (r) => `<code>${esc(r.code)}</code>` },
      { key: "address", label: "Address", render: (r) => esc(r.address || "—") },
      { key: "sellsOnline", label: "Sells online", render: (r) => (r.sellsOnline === false ? "No" : "Yes") },
      { key: "isActive", label: "Status", render: (r) => (r.isActive === false ? `<span class="tag tag--out">Off</span>` : `<span class="tag">On</span>`) },
      {
        key: "actions",
        label: "",
        className: "adm-actions",
        render: (r) =>
          !canManage
            ? ""
            : r.virtual
              ? `<button type="button" class="text-btn" data-setup>Set up</button>`
              : `<button type="button" class="text-btn" data-edit="${esc(r.id)}">Edit</button>${r.isDefault ? "" : ` <button type="button" class="text-btn" data-toggle="${esc(r.id)}">${r.isActive === false ? "Switch on" : "Switch off"}</button>`}`,
      },
    ],
  });

  const say = (text) => {
    statusEl.textContent = text;
    statusEl.hidden = !text;
  };

  /** After a "sells online" or on/off change, the online totals are recalculated page by page. */
  async function recalc() {
    say("Recalculating what is available online…");
    try {
      const n = await rebuildOnlineStock((done) => alive() && say(`Recalculating what is available online… ${done} items checked`));
      if (alive()) say("");
      toast(`Online availability updated (${n} items checked).`);
    } catch (error) {
      if (alive()) say("");
      toast(`${fnResult(error).message} Use "Recalculate" again from this page when you're back online.`, "error");
    }
  }

  const drawForm = () => {
    const v = editing ?? { name: "", code: "", description: "", address: "", sellsOnline: true };
    if (!canManage) {
      formWrap.innerHTML = `<p class="muted">Your role can view warehouses but not change them.</p>`;
      return;
    }
    const isDefault = Boolean(editing?.isDefault);
    formWrap.innerHTML = `
      <form class="adm-form adm-card" novalidate data-form>
        <h2 class="adm-h2">${editing ? "Edit warehouse" : "Add a warehouse"}</h2>
        <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
        ${field({ name: "name", label: "Name", required: true, maxlength: 80, hint: "e.g. Shop floor, Back room, Godown", value: v.name }, "wh")}
        ${field({ name: "code", label: "Short code", required: true, maxlength: 10, hint: "2–10 letters or numbers; printed on transfers and labels", value: v.code }, "wh")}
        ${field({ name: "address", label: "Address", required: false, maxlength: 300, value: v.address }, "wh")}
        ${field({ name: "description", label: "Notes", required: false, maxlength: 300, textarea: true, value: v.description }, "wh")}
        <label class="check"><input type="checkbox" name="sellsOnline" ${v.sellsOnline === false ? "" : "checked"} ${isDefault ? "disabled" : ""} /> Sells online (customers on the website can buy what is stored here)</label>
        <div class="form-actions">
          <button type="submit" class="btn btn--primary"><span>${editing ? "Save changes" : "Add warehouse"}</span></button>
          ${editing ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel</button>` : ""}
        </div>
      </form>`;
    const form = /** @type {HTMLFormElement} */ (formWrap.querySelector("[data-form]"));
    form.querySelector("[data-cancel]")?.addEventListener("click", () => {
      editing = null;
      drawForm();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = (n) => /** @type {HTMLInputElement} */ (form.elements.namedItem(n));
      const raw = { name: el("name").value, code: el("code").value, address: el("address").value, description: el("description").value, sellsOnline: isDefault ? true : el("sellsOnline").checked, ...(editing ? { id: editing.id } : {}) };
      const parsed = saveWarehouseInput.safeParse(raw);
      if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
      let needsRebuild = false;
      const result = await busy(
        form,
        async () => {
          try {
            needsRebuild = Boolean((await call("saveWarehouse", parsed.data)).needsRebuild);
            return { ok: true };
          } catch (error) {
            return fnResult(error);
          }
        },
        "Saving…",
      );
      showResult(form, result);
      if (!result.ok) return;
      toast(editing ? "Saved." : "Warehouse added.");
      editing = null;
      await load();
      if (needsRebuild) await recalc();
    });
  };

  async function load() {
    try {
      const found = await listWarehouses();
      if (!alive()) return;
      rows = found.some((w) => w.isDefault || w.id === VIRTUAL_DEFAULT_WAREHOUSE.id) ? found : [VIRTUAL_DEFAULT_WAREHOUSE, ...found];
      table.set(rows);
      listEl.replaceChildren(table.el);
      if (rows.some((r) => r.virtual)) {
        listEl.insertAdjacentHTML("beforeend", `<p class="muted">The default warehouse already holds your existing stock. ${canManage ? `Press "Set up" to save it as a warehouse you can rename.` : ""}</p>`);
      }
      drawForm();
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }

  listEl.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("[data-setup]")) {
      try {
        await call("ensureDefaultWarehouse", {});
        toast("Default warehouse saved.");
        await load();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
      return;
    }
    const edit = t.closest("[data-edit]");
    if (edit) {
      editing = rows.find((r) => r.id === /** @type {HTMLElement} */ (edit).dataset.edit) ?? null;
      drawForm();
      formWrap.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      return;
    }
    const toggle = t.closest("[data-toggle]");
    if (toggle) {
      const w = rows.find((r) => r.id === /** @type {HTMLElement} */ (toggle).dataset.toggle);
      if (!w) return;
      const turnOn = w.isActive === false;
      if (!turnOn && !(await confirmDialog({ title: `Switch off ${w.name}?`, body: "It must hold no stock and have no unfinished transfer. You can switch it on again later.", confirm: "Switch off" }))) return;
      try {
        const res = await call("setWarehouseActive", { id: w.id, isActive: turnOn });
        toast(turnOn ? `${w.name} is on.` : `${w.name} is off.`);
        await load();
        if (res.needsRebuild) await recalc();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    }
  });

  await load();
}
