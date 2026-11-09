/**
 * Categories & Sizes: the building blocks products are made from — categories, brands, colours
 * and sizes. Everything starts empty; the owner adds what the store actually sells.
 */
import { esc } from "../../lib/format.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, dataTable } from "../ui/kit.js";
import { call, listCategories, listBrands, listColors, listSizes } from "../catalogData.js";
import { saveCategoryInput, saveBrandInput, saveColorInput, saveSizeInput, fieldErrors } from "../../../shared/schemas/index.js";
import { slugify } from "../../../shared/slug.js";

const TABS = [
  { key: "category", label: "Categories", fn: "saveCategory", schema: saveCategoryInput, load: listCategories },
  { key: "brand", label: "Brands", fn: "saveBrand", schema: saveBrandInput, load: listBrands },
  { key: "color", label: "Colours", fn: "saveColor", schema: saveColorInput, load: listColors },
  { key: "size", label: "Sizes", fn: "saveSize", schema: saveSizeInput, load: listSizes },
];

/** Error from a Cloud Function → form result (safe message + field errors). */
export const fnResult = (error) => ({
  ok: false,
  message: /** @type {any} */ (error)?.code && error.code !== "functions/internal" ? error.message : "Couldn't save. Please try again.",
  fields: /** @type {any} */ (error)?.details?.fields ?? {},
});

export default async function catalogue({ main }) {
  let tab = TABS[0];
  let editing = null;
  let rows = [];
  let categories = [];

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Categories <em>&amp; sizes</em></h1>
        <p class="muted">Set these up first. Products are then built from them — for example "Formal", "Black", "EU 42".</p>
      </header>
      <div class="adm-tabs" role="tablist" aria-label="Catalogue lists">
        ${TABS.map((t, i) => `<button type="button" role="tab" id="tab-${t.key}" aria-selected="${i === 0}" aria-controls="cat-panel" data-tab="${t.key}">${t.label}</button>`).join("")}
      </div>
      <div class="adm-split" id="cat-panel" role="tabpanel" aria-labelledby="tab-category">
        <section data-list aria-label="List"></section>
        <section data-form-wrap aria-label="Add or edit"></section>
      </div>
    </div>`;

  const listEl = main.querySelector("[data-list]");
  const formWrap = main.querySelector("[data-form-wrap]");

  const columns = {
    category: [
      { key: "name", label: "Name", render: (r) => `${r.parentId ? "↳ " : ""}${esc(r.name)}` },
      { key: "slug", label: "Web address", render: (r) => `<code>/shop/${esc(r.slug)}</code>` },
      { key: "isActive", label: "Shown", render: (r) => (r.isActive === false ? "Hidden" : "Yes") },
    ],
    brand: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Web address", render: (r) => `<code>${esc(r.slug)}</code>` },
    ],
    color: [{ key: "name", label: "Colour", render: (r) => `<span class="adm-swatch" style="--swatch:${esc(r.hex)}"></span>${esc(r.name)}` }, { key: "hex", label: "Hex" }],
    size: [
      { key: "value", label: "Size", render: (r) => `${esc(r.system)} ${esc(r.value)}` },
      { key: "sortOrder", label: "Order" },
    ],
  };

  const drawList = () => {
    const table = dataTable({
      caption: tab.label,
      empty: { title: `No ${tab.label.toLowerCase()} yet`, text: "Add the first one with the form." },
      columns: [
        ...columns[tab.key],
        {
          key: "actions",
          label: "",
          className: "adm-actions",
          render: (r) => `<button type="button" class="text-btn" data-edit="${esc(r.id)}">Edit</button> <button type="button" class="text-btn" data-delete="${esc(r.id)}">Delete</button>`,
        },
      ],
    });
    table.set(tab.key === "category" ? orderCategories(rows) : rows);
    listEl.replaceChildren(table.el);
  };

  /** Parents first, each followed by its children. */
  const orderCategories = (list) => list.filter((c) => !c.parentId).flatMap((p) => [p, ...list.filter((c) => c.parentId === p.id)]);

  const drawForm = () => {
    const v = editing ?? {};
    const prefix = `cat-${tab.key}`;
    const fields = {
      category: `
        ${field({ name: "name", label: "Name", required: true, maxlength: 80, value: v.name }, prefix)}
        ${field({ name: "slug", label: "Web address", required: true, maxlength: 120, hint: "Lower-case letters, numbers and hyphens. Filled in from the name.", value: v.slug }, prefix)}
        <div class="field" data-field="parentId">
          <label for="${prefix}-parentId">Inside category <span class="muted">(optional)</span></label>
          <select id="${prefix}-parentId" name="parentId"><option value="">— Top level —</option>${categories
            .filter((c) => !c.parentId && c.id !== v.id)
            .map((c) => `<option value="${esc(c.id)}" ${c.id === v.parentId ? "selected" : ""}>${esc(c.name)}</option>`)
            .join("")}</select>
          <p class="field-error" hidden></p>
        </div>
        ${field({ name: "description", label: "Description", required: false, maxlength: 1000, textarea: true, value: v.description }, prefix)}
        ${field({ name: "sortOrder", label: "Order", type: "number", required: false, hint: "Smaller numbers come first", value: String(v.sortOrder ?? 0) }, prefix)}
        <label class="check"><input type="checkbox" name="isActive" ${v.isActive === false ? "" : "checked"} /> Show on the website</label>`,
      brand: `
        ${field({ name: "name", label: "Name", required: true, maxlength: 80, value: v.name }, prefix)}
        ${field({ name: "slug", label: "Web address", required: true, maxlength: 120, value: v.slug }, prefix)}`,
      color: `
        ${field({ name: "name", label: "Colour name", required: true, maxlength: 40, hint: "As customers should see it, e.g. Black, Tan, Navy", value: v.name }, prefix)}
        <div class="field" data-field="hex">
          <label for="${prefix}-hex">Swatch colour</label>
          <input id="${prefix}-hex" name="hex" type="color" value="${esc(v.hex ?? "#1a1a1a")}" />
          <p class="field-error" hidden></p>
        </div>`,
      size: `
        <div class="field" data-field="system">
          <label for="${prefix}-system">Size system</label>
          <select id="${prefix}-system" name="system">${["EU", "UK", "US", "PK"].map((s) => `<option ${s === (v.system ?? "EU") ? "selected" : ""}>${s}</option>`).join("")}</select>
          <p class="field-error" hidden></p>
        </div>
        ${field({ name: "value", label: "Size", required: true, maxlength: 10, hint: "e.g. 42, 7.5, 32", value: v.value }, prefix)}
        ${field({ name: "sortOrder", label: "Order", type: "number", required: false, hint: "Usually the size number, so sizes list in order", value: String(v.sortOrder ?? "") }, prefix)}`,
    }[tab.key];

    formWrap.innerHTML = `
      <form class="adm-form adm-card" novalidate data-form>
        <h2 class="adm-h2">${editing ? `Edit ${tab.label.toLowerCase().replace(/s$|ies$/, (m) => (m === "ies" ? "y" : ""))}` : `Add ${tab.key === "category" ? "a category" : `a ${tab.key === "color" ? "colour" : tab.key}`}`}</h2>
        <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
        ${fields}
        <div class="form-actions">
          <button type="submit" class="btn btn--primary"><span>${editing ? "Save changes" : "Add"}</span></button>
          ${editing ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel</button>` : ""}
        </div>
      </form>`;

    const form = /** @type {HTMLFormElement} */ (formWrap.querySelector("[data-form]"));
    const name = /** @type {HTMLInputElement | null} */ (form.elements.namedItem("name"));
    const slug = /** @type {HTMLInputElement | null} */ (form.elements.namedItem("slug"));
    if (name && slug && !editing) name.addEventListener("input", () => (slug.value = slugify(name.value)));
    const value = /** @type {HTMLInputElement | null} */ (form.elements.namedItem("value"));
    const sort = /** @type {HTMLInputElement | null} */ (form.elements.namedItem("sortOrder"));
    if (tab.key === "size" && value && sort && !editing) value.addEventListener("input", () => (sort.value = String(Math.round(Number(value.value) * 10) || "")));
    form.querySelector("[data-cancel]")?.addEventListener("click", () => {
      editing = null;
      drawForm();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = Object.fromEntries(
        [...form.elements]
          .filter((el) => /** @type {HTMLInputElement} */ (el).name)
          .map((el) => {
            const i = /** @type {HTMLInputElement} */ (el);
            return [i.name, i.type === "checkbox" ? i.checked : i.type === "number" ? (i.value === "" ? 0 : Number(i.value)) : i.value];
          }),
      );
      if (tab.key === "category") raw.parentId = raw.parentId || null;
      if (editing) raw.id = editing.id;
      const parsed = tab.schema.safeParse(raw);
      if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
      const result = await busy(form, async () => {
        try {
          await call(tab.fn, parsed.data);
          return { ok: true };
        } catch (error) {
          return fnResult(error);
        }
      }, "Saving…");
      showResult(form, result);
      if (result.ok) {
        toast(editing ? "Saved." : "Added.");
        editing = null;
        await load();
      }
    });
  };

  const load = async () => {
    listEl.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      [rows, categories] = await Promise.all([tab.load(), tab.key === "category" ? listCategories() : Promise.resolve(categories)]);
      if (tab.key === "category") categories = rows;
      drawList();
      drawForm();
    } catch {
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  };

  listEl.addEventListener("click", async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const edit = target.closest("[data-edit]");
    const del = target.closest("[data-delete]");
    if (edit) {
      editing = rows.find((r) => r.id === /** @type {HTMLElement} */ (edit).dataset.edit) ?? null;
      drawForm();
      formWrap.querySelector("input, select")?.focus();
    }
    if (del) {
      const row = rows.find((r) => r.id === /** @type {HTMLElement} */ (del).dataset.delete);
      const label = row?.name ?? `${row?.system} ${row?.value}`;
      if (!(await confirmDialog({ title: `Delete ${label}?`, body: "This can't be undone. Items that products use can't be deleted.", confirm: "Delete", danger: true }))) return;
      try {
        await call("deleteCatalogItem", { kind: tab.key, id: row.id });
        toast("Deleted.");
        await load();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    }
  });

  main.querySelector(".adm-tabs").addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
    if (!btn) return;
    tab = TABS.find((t) => t.key === /** @type {HTMLElement} */ (btn).dataset.tab);
    editing = null;
    main.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    main.querySelector("#cat-panel").setAttribute("aria-labelledby", `tab-${tab.key}`);
    load();
  });

  await load();
}
