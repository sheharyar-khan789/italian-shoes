/**
 * Products: list (/admin/products) and editor (/admin/products/new, /admin/products/{id}).
 * Prices are typed in rupees and stored as paisa. Every save goes through a Cloud Function.
 */
import { esc } from "../../lib/format.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, dataTable, emptyState } from "../ui/kit.js";
import { call, listProducts, getProduct, listVariants, listVariantCosts, listCategories, listBrands, listColors, listSizes, uploadProductImage } from "../catalogData.js";
import { imageUrl } from "../../app/firebase.js";
import { saveProductInput, saveVariantInput, createVariantsInput, IMAGE_UPLOAD, fieldErrors } from "../../../shared/schemas/index.js";
import { formatPKR } from "../../../shared/money.js";
import { rupeesField, toPaisa } from "../ui/money.js";
import { slugify } from "../../../shared/slug.js";
import { fnResult } from "./catalogue.js";

const STATUS_LABEL = { draft: "Draft", published: "Published", archived: "Archived" };
const statusTag = (s) => `<span class="tag tag--${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
const thumb = (p) => {
  const img = p.images?.find((i) => i.isPrimary) ?? p.images?.[0];
  return img ? `<img class="adm-thumb" src="${esc(imageUrl(img.paths[400]))}" alt="" loading="lazy" />` : `<span class="adm-thumb adm-thumb--empty" aria-hidden="true"></span>`;
};
const priceRange = (s) => (s?.minPrice == null ? "—" : s.minPrice === s.maxPrice ? formatPKR(s.minPrice) : `${formatPKR(s.minPrice)} – ${formatPKR(s.maxPrice)}`);

export default async function products(ctx) {
  if (ctx.params[0]) return editor(ctx, ctx.params[0]);
  return productList(ctx);
}

/* ───────── List ───────── */

async function productList({ main, user, navigate }) {
  const canWrite = user.perms.includes("products.write");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head adm-page__head--row">
        <div>
          <h1 class="adm-h1">Products</h1>
          <p class="muted">Drafts are only visible here. A product appears on the website once it's published.</p>
        </div>
        ${canWrite ? `<a class="btn btn--primary" href="/admin/products/new" data-link><span>Add product</span></a>` : ""}
      </header>
      <div class="adm-filters">
        <label class="visually-hidden" for="p-search">Search products</label>
        <input id="p-search" type="search" placeholder="Search by name or SKU" />
        <label class="visually-hidden" for="p-status">Status</label>
        <select id="p-status"><option value="">All statuses</option><option value="draft">Drafts</option><option value="published">Published</option><option value="archived">Archived</option></select>
        <label class="visually-hidden" for="p-cat">Category</label>
        <select id="p-cat"><option value="">All categories</option></select>
      </div>
      <div data-table><p class="muted">Loading…</p></div>
    </div>`;

  const wrap = main.querySelector("[data-table]");
  let all = [];
  let cats = [];
  const table = dataTable({
    caption: "Products",
    empty: { title: "No products match", text: "Try another search or filter." },
    columns: [
      { key: "photo", label: "", render: thumb, className: "adm-col-thumb" },
      { key: "name", label: "Product", render: (p) => `<a class="text-link" href="/admin/products/${esc(p.id)}" data-link>${esc(p.name)}</a><br /><span class="muted">${esc(p.sku)}</span>` },
      { key: "cat", label: "Category", render: (p) => esc(cats.find((c) => c.id === p.categoryId)?.name ?? "—") },
      { key: "status", label: "Status", render: (p) => statusTag(p.status) },
      { key: "variants", label: "Sizes / colours", render: (p) => String(p.summary?.variantCount ?? 0) },
      { key: "stock", label: "In stock", render: (p) => String(p.summary?.totalStock ?? 0) },
      { key: "price", label: "Price", render: (p) => esc(priceRange(p.summary)), className: "nowrap" },
    ],
  });

  const apply = () => {
    const q = /** @type {HTMLInputElement} */ (main.querySelector("#p-search")).value.trim().toLowerCase();
    const st = /** @type {HTMLSelectElement} */ (main.querySelector("#p-status")).value;
    const cat = /** @type {HTMLSelectElement} */ (main.querySelector("#p-cat")).value;
    table.set(all.filter((p) => (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)) && (!st || p.status === st) && (!cat || p.categoryId === cat)));
  };

  try {
    [all, cats] = await Promise.all([listProducts(), listCategories()]);
  } catch {
    wrap.innerHTML = errorState();
    wrap.querySelector("[data-retry]")?.addEventListener("click", () => productList({ main, user, navigate }));
    return;
  }
  main.querySelector("#p-cat").insertAdjacentHTML("beforeend", cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(""));

  if (!all.length) {
    wrap.innerHTML = emptyState({
      title: "No products yet",
      text: cats.length ? "Add your first product, then its photos, sizes and colours." : "Start by adding categories, colours and sizes, then add products.",
      action: canWrite ? `<a class="btn btn--primary" href="${cats.length ? "/admin/products/new" : "/admin/categories"}" data-link><span>${cats.length ? "Add product" : "Set up categories"}</span></a>` : "",
    });
    return;
  }
  wrap.replaceChildren(table.el);
  apply();
  main.querySelector(".adm-filters").addEventListener("input", apply);
}

/* ───────── Editor ───────── */

async function editor({ main, user, navigate }, id) {
  const isNew = id === "new";
  const canWrite = user.perms.includes("products.write");
  const canCost = user.perms.includes("costs.read");
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading…</p></div>`;

  /** @type {any} */
  let product = null;
  /** @type {any[]} */
  let variants = [];
  /** @type {Record<string, number | null>} */
  let costs = {};
  /** @type {any[]} */
  let cats, brands, colors, sizes;
  try {
    [cats, brands, colors, sizes] = await Promise.all([listCategories(), listBrands(), listColors(), listSizes()]);
    if (!isNew) {
      product = await getProduct(id);
      if (!product) {
        main.innerHTML = `<div class="adm-page">${emptyState({ title: "Product not found", text: "It may have been removed.", action: `<a class="btn btn--ghost" href="/admin/products" data-link>Back to products</a>` })}</div>`;
        return;
      }
      [variants, costs] = await Promise.all([listVariants(id), canCost ? listVariantCosts(id).catch(() => ({})) : Promise.resolve({})]);
    }
  } catch {
    main.innerHTML = `<div class="adm-page">${errorState()}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => editor({ main, user, navigate }, id));
    return;
  }

  if (isNew && !cats.length) {
    main.innerHTML = `<div class="adm-page">${emptyState({ title: "Add a category first", text: "Every product belongs to a category (for example Sneakers or Formal).", action: `<a class="btn btn--primary" href="/admin/categories" data-link><span>Set up categories</span></a>` })}</div>`;
    return;
  }

  /** @type {any} */
  const p = product ?? {};
  const dis = canWrite ? "" : "disabled";
  main.innerHTML = `
    <div class="adm-page">
      <p><a class="text-link" href="/admin/products" data-link>← All products</a></p>
      <header class="adm-page__head adm-page__head--row">
        <div>
          <h1 class="adm-h1">${isNew ? "New <em>product</em>" : esc(p.name)}</h1>
          ${isNew ? `<p class="muted">Save the details first; then add photos and sizes.</p>` : `<p class="muted">${statusTag(p.status)} · SKU ${esc(p.sku)}</p>`}
        </div>
        ${!isNew && canWrite ? `<div class="adm-status-actions" data-status-actions></div>` : ""}
      </header>

      <section class="adm-section adm-card">
        <h2 class="adm-h2">Details</h2>
        <form class="adm-form" novalidate data-details>
          <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
          <fieldset class="adm-grid2" ${dis}>
            ${field({ name: "name", label: "Product name", required: true, maxlength: 120, value: p.name }, "pd")}
            ${field({ name: "sku", label: "Product code (SKU)", required: true, maxlength: 64, hint: "Your own code, e.g. IS-FO-014", value: p.sku }, "pd")}
            ${field({ name: "slug", label: "Web address", required: true, maxlength: 120, hint: "/product/…  — filled in from the name", value: p.slug }, "pd")}
            <div class="field" data-field="categoryId"><label for="pd-categoryId">Category</label>
              <select id="pd-categoryId" name="categoryId">${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${c.parentId ? "— " : ""}${esc(c.name)}</option>`).join("")}</select>
              <p class="field-error" hidden></p></div>
            <div class="field" data-field="brandId"><label for="pd-brandId">Brand <span class="muted">(optional)</span></label>
              <select id="pd-brandId" name="brandId"><option value="">— None —</option>${brands.map((b) => `<option value="${esc(b.id)}" ${b.id === p.brandId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>
              <p class="field-error" hidden></p></div>
          </fieldset>
          <fieldset ${dis}>
            ${field({ name: "description", label: "Description", required: false, maxlength: 5000, textarea: true, hint: "Materials, fit, care — only what's true for this product.", value: p.description }, "pd")}
            <div class="adm-checks">
              <label class="check"><input type="checkbox" name="isFeatured" ${p.isFeatured ? "checked" : ""} /> Featured on the homepage</label>
              <label class="check"><input type="checkbox" name="isNewArrival" ${p.isNewArrival ? "checked" : ""} /> Mark as new arrival</label>
            </div>
            <details class="accordion"><summary>Search engines (optional)</summary>
              ${field({ name: "seoTitle", label: "Title", required: false, maxlength: 70, value: p.seoTitle }, "pd")}
              ${field({ name: "seoDescription", label: "Description", required: false, maxlength: 160, textarea: true, value: p.seoDescription }, "pd")}
            </details>
          </fieldset>
          ${canWrite ? `<div class="form-actions"><button type="submit" class="btn btn--primary"><span>${isNew ? "Save and continue" : "Save details"}</span></button></div>` : ""}
        </form>
      </section>

      ${
        isNew
          ? ""
          : `<section class="adm-section adm-card" aria-labelledby="ph-title">
              <h2 class="adm-h2" id="ph-title">Photos <span class="muted">(${(p.images ?? []).length}/${IMAGE_UPLOAD.maxPerProduct})</span></h2>
              <div class="adm-photos" data-photos></div>
              ${canWrite ? `<label class="btn btn--ghost adm-upload"><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-upload /> <span>Add photos</span></label>
              <p class="fine">JPEG, PNG or WebP, up to 8 MB, at least 300 × 300 pixels. Each photo is checked and resized automatically.</p>
              <ul class="adm-uploads" data-upload-list aria-live="polite"></ul>` : ""}
            </section>
            <section class="adm-section adm-card" aria-labelledby="var-title">
              <h2 class="adm-h2" id="var-title">Sizes &amp; colours</h2>
              <div data-variants></div>
              ${canWrite ? `<details class="accordion" ${variants.length ? "" : "open"}><summary>Add sizes and colours</summary><div data-add-variants></div></details>` : ""}
              <p class="fine">Stock is added on the <a class="text-link" href="/admin/inventory" data-link>Inventory</a> page. New sizes start at 0.</p>
            </section>`
      }
    </div>`;

  /* Details */
  const form = /** @type {HTMLFormElement} */ (main.querySelector("[data-details]"));
  const nameEl = /** @type {HTMLInputElement} */ (form.elements.namedItem("name"));
  const slugEl = /** @type {HTMLInputElement} */ (form.elements.namedItem("slug"));
  if (isNew) nameEl.addEventListener("input", () => (slugEl.value = slugify(nameEl.value)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const raw = {
      ...(isNew ? {} : { id }),
      name: fd.get("name"),
      sku: fd.get("sku"),
      slug: fd.get("slug"),
      categoryId: fd.get("categoryId"),
      brandId: fd.get("brandId") || null,
      description: fd.get("description"),
      isFeatured: fd.get("isFeatured") === "on",
      isNewArrival: fd.get("isNewArrival") === "on",
      seoTitle: fd.get("seoTitle") ?? "",
      seoDescription: fd.get("seoDescription") ?? "",
    };
    const parsed = saveProductInput.safeParse(raw);
    if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
    const result = await busy(form, async () => {
      try {
        return { ok: true, ...(await call("saveProduct", parsed.data)) };
      } catch (error) {
        return fnResult(error);
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast("Saved.");
      if (isNew) navigate(`/admin/products/${result.id}`);
    }
  });
  if (isNew) return;

  /* Status */
  const statusBox = main.querySelector("[data-status-actions]");
  if (statusBox) {
    const actions = {
      draft: [["published", "Publish"], ["archived", "Archive"]],
      published: [["draft", "Unpublish"], ["archived", "Archive"]],
      archived: [["draft", "Restore as draft"]],
    }[p.status];
    statusBox.innerHTML = actions.map(([to, label], i) => `<button type="button" class="btn ${i === 0 && to === "published" ? "btn--primary" : "btn--ghost"}" data-status="${to}"><span>${label}</span></button>`).join("");
    statusBox.addEventListener("click", async (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest("[data-status]");
      if (!btn) return;
      const to = /** @type {HTMLElement} */ (btn).dataset.status;
      const copy = {
        published: ["Publish this product?", "It will appear on the website for customers."],
        draft: ["Move back to draft?", "Customers won't see it until you publish it again."],
        archived: ["Archive this product?", "It disappears from the website. It's kept for past orders and can be restored."],
      }[to];
      if (!(await confirmDialog({ title: copy[0], body: copy[1], confirm: btn.textContent.trim() }))) return;
      try {
        await call("setProductStatus", { productId: id, status: to });
        toast(`Product ${STATUS_LABEL[to].toLowerCase()}.`);
        editor({ main, user, navigate }, id);
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    });
  }

  /* Photos */
  const photos = main.querySelector("[data-photos]");
  const drawPhotos = () => {
    const imgs = product.images ?? [];
    photos.innerHTML = imgs.length
      ? imgs
          .map(
            (img, i) => `<figure class="adm-photo ${img.isPrimary ? "is-primary" : ""}" data-image="${esc(img.id)}">
              <img src="${esc(imageUrl(img.paths[400]))}" alt="${esc(img.alt || product.name)}" loading="lazy" />
              <figcaption>
                ${img.isPrimary ? `<span class="tag">Main photo</span>` : canWrite ? `<button type="button" class="text-btn" data-img="primary">Make main</button>` : ""}
                ${
                  canWrite
                    ? `<label class="visually-hidden" for="alt-${esc(img.id)}">Description for screen readers</label>
                       <input id="alt-${esc(img.id)}" class="adm-alt" maxlength="160" placeholder="Describe the photo" value="${esc(img.alt ?? "")}" data-alt />
                       <span class="adm-photo__btns">
                         <button type="button" class="text-btn" data-img="left" ${i === 0 ? "disabled" : ""} aria-label="Move earlier">←</button>
                         <button type="button" class="text-btn" data-img="right" ${i === imgs.length - 1 ? "disabled" : ""} aria-label="Move later">→</button>
                         <button type="button" class="text-btn" data-img="delete">Delete</button>
                       </span>`
                    : ""
                }
              </figcaption>
            </figure>`,
          )
          .join("")
      : `<p class="muted">No photos yet. A product needs at least one photo before it can be published.</p>`;
  };
  const refreshProduct = async () => {
    product = (await getProduct(id)) ?? product;
    drawPhotos();
    main.querySelector("#ph-title .muted").textContent = `(${(product.images ?? []).length}/${IMAGE_UPLOAD.maxPerProduct})`;
  };
  drawPhotos();

  photos.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-img]");
    if (!btn) return;
    const imageId = /** @type {HTMLElement} */ (btn.closest("[data-image]")).dataset.image;
    const act = /** @type {HTMLElement} */ (btn).dataset.img;
    try {
      if (act === "delete") {
        if (!(await confirmDialog({ title: "Delete this photo?", confirm: "Delete", danger: true }))) return;
        await call("productImageAction", { productId: id, action: "delete", imageId });
      } else if (act === "primary") {
        await call("productImageAction", { productId: id, action: "primary", imageId });
      } else {
        const order = product.images.map((i) => i.id);
        const at = order.indexOf(imageId);
        const to = act === "left" ? at - 1 : at + 1;
        [order[at], order[to]] = [order[to], order[at]];
        await call("productImageAction", { productId: id, action: "reorder", order });
      }
      await refreshProduct();
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
  });
  photos.addEventListener("change", async (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (!input.matches("[data-alt]")) return;
    try {
      await call("productImageAction", { productId: id, action: "alt", imageId: input.closest("[data-image]").getAttribute("data-image"), alt: input.value });
      toast("Photo description saved.");
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
  });

  const uploadInput = /** @type {HTMLInputElement | null} */ (main.querySelector("[data-upload]"));
  const uploadList = main.querySelector("[data-upload-list]");
  uploadInput?.addEventListener("change", async () => {
    const files = [...(uploadInput.files ?? [])];
    uploadInput.value = "";
    for (const file of files) {
      const li = document.createElement("li");
      li.textContent = `${file.name}: `;
      const state = document.createElement("span");
      li.append(state);
      uploadList.append(li);
      // Same limits the server enforces, so obvious problems are explained before uploading.
      if (!IMAGE_UPLOAD.types.includes(file.type)) {
        state.textContent = "not added — use a JPEG, PNG or WebP photo.";
        continue;
      }
      if (file.size > IMAGE_UPLOAD.maxBytes) {
        state.textContent = "not added — the file is larger than 8 MB.";
        continue;
      }
      try {
        const result = await uploadProductImage(id, file, user.uid, (pct) => (state.textContent = pct < 100 ? `uploading ${pct}%` : "checking and resizing…"));
        state.textContent = result.status === "done" ? "added ✓" : `not added — ${result.reason}`;
        if (result.status === "done") await refreshProduct();
      } catch {
        state.textContent = "not added — the upload failed. Check your connection and try again.";
      }
    }
  });

  /* Variants */
  const varWrap = main.querySelector("[data-variants]");
  const drawVariants = () => {
    if (!variants.length) {
      varWrap.innerHTML = `<p class="muted">No sizes or colours yet. Add them below — each colour × size combination gets its own price, SKU and stock.</p>`;
      return;
    }
    varWrap.innerHTML = `
      <div class="adm-table-wrap"><table class="adm-table adm-table--edit">
        <caption class="visually-hidden">Sizes and colours</caption>
        <thead><tr><th scope="col">Colour / size</th><th scope="col">SKU</th><th scope="col">Price (Rs)</th><th scope="col">Sale price (Rs)</th>${canCost ? `<th scope="col">Cost (Rs)</th>` : ""}<th scope="col">Available</th><th scope="col">On sale to customers</th><th scope="col"></th></tr></thead>
        <tbody>${variants
          .map(
            (v) => `<tr data-variant="${esc(v.id)}">
              <td data-label="Colour / size"><span class="adm-swatch" style="--swatch:${esc(v.colorHex ?? "#888")}"></span>${esc(v.colorName)} · ${esc(v.sizeLabel)}</td>
              <td data-label="SKU"><input name="sku" value="${esc(v.sku)}" maxlength="64" ${dis} aria-label="SKU" /></td>
              <td data-label="Price"><input name="price" inputmode="decimal" value="${esc(rupeesField(v.price))}" ${dis} aria-label="Price in rupees" /></td>
              <td data-label="Sale price"><input name="salePrice" inputmode="decimal" value="${esc(rupeesField(v.salePrice))}" placeholder="—" ${dis} aria-label="Sale price in rupees" /></td>
              ${canCost ? `<td data-label="Cost"><input name="costPrice" inputmode="decimal" value="${esc(rupeesField(costs[v.id]))}" placeholder="—" ${dis} aria-label="Cost price in rupees" /></td>` : ""}
              <td data-label="Available">${esc(String(v.available ?? 0))}</td>
              <td data-label="On sale"><input type="checkbox" name="isActive" ${v.isActive ? "checked" : ""} ${dis} aria-label="Available to customers" /></td>
              <td>${canWrite ? `<button type="button" class="text-btn" data-save-variant>Save</button>` : ""}<p class="field-error" hidden></p></td>
            </tr>`,
          )
          .join("")}</tbody></table></div>`;
  };
  drawVariants();

  varWrap.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-save-variant]");
    if (!btn) return;
    const row = btn.closest("tr");
    const v = variants.find((x) => x.id === row.dataset.variant);
    const val = (n) => /** @type {HTMLInputElement} */ (row.querySelector(`[name="${n}"]`));
    const err = /** @type {HTMLElement} */ (row.querySelector(".field-error"));
    const parsed = saveVariantInput.safeParse({
      productId: id,
      variantId: v.id,
      colorId: v.colorId,
      sizeId: v.sizeId,
      sku: val("sku").value,
      price: toPaisa(val("price").value),
      salePrice: toPaisa(val("salePrice").value),
      costPrice: canCost ? toPaisa(val("costPrice").value) : null,
      isActive: val("isActive").checked,
    });
    if (!parsed.success) {
      err.textContent = Object.values(fieldErrors(parsed.error))[0] ?? "Check this row";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    try {
      await call("saveVariant", parsed.data);
      toast(`${v.colorName} · ${v.sizeLabel} saved.`);
      variants = await listVariants(id);
    } catch (error) {
      err.textContent = fnResult(error).message;
      err.hidden = false;
    }
  });

  const addWrap = main.querySelector("[data-add-variants]");
  if (addWrap) {
    addWrap.innerHTML =
      !colors.length || !sizes.length
        ? `<p class="muted">Add colours and sizes on the <a class="text-link" href="/admin/categories" data-link>Categories &amp; Sizes</a> page first.</p>`
        : `<form class="adm-form" novalidate data-add-form>
            <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
            <fieldset class="adm-chips" data-field="colorIds"><legend>Colours</legend>${colors.map((c) => `<label class="check"><input type="checkbox" name="colorIds" value="${esc(c.id)}" /><span class="adm-swatch" style="--swatch:${esc(c.hex)}"></span>${esc(c.name)}</label>`).join("")}<p class="field-error" hidden></p></fieldset>
            <fieldset class="adm-chips" data-field="sizeIds"><legend>Sizes</legend>${sizes.map((s) => `<label class="check"><input type="checkbox" name="sizeIds" value="${esc(s.id)}" />${esc(s.system)} ${esc(s.value)}</label>`).join("")}<p class="field-error" hidden></p></fieldset>
            <div class="adm-grid3">
              ${field({ name: "price", label: "Price (Rs)", required: true, inputmode: "decimal", hint: "For all of them; change any one later" }, "av")}
              ${field({ name: "salePrice", label: "Sale price (Rs)", required: false, inputmode: "decimal" }, "av")}
              ${canCost ? field({ name: "costPrice", label: "Cost price (Rs)", required: false, inputmode: "decimal", hint: "Staff only" }, "av") : ""}
            </div>
            <div class="form-actions"><button type="submit" class="btn btn--primary"><span>Add sizes &amp; colours</span></button></div>
          </form>`;
    const addForm = /** @type {HTMLFormElement | null} */ (addWrap.querySelector("[data-add-form]"));
    addForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(addForm);
      const parsed = createVariantsInput.safeParse({
        productId: id,
        colorIds: fd.getAll("colorIds"),
        sizeIds: fd.getAll("sizeIds"),
        price: toPaisa(String(fd.get("price") ?? "")),
        salePrice: toPaisa(String(fd.get("salePrice") ?? "")),
        costPrice: canCost ? toPaisa(String(fd.get("costPrice") ?? "")) : null,
      });
      if (!parsed.success) return showResult(addForm, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
      const result = await busy(addForm, async () => {
        try {
          return { ok: true, ...(await call("createVariants", parsed.data)) };
        } catch (error) {
          return fnResult(error);
        }
      }, "Adding…");
      showResult(addForm, result);
      if (result.ok) {
        toast(`${result.created} added${result.skipped ? `, ${result.skipped} already existed` : ""}.`);
        variants = await listVariants(id);
        drawVariants();
        addForm.reset();
      }
    });
  }
}
