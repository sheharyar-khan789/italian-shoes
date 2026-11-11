import { getCatalog, categoryBySlug } from "../app/state.js";
import { queryProducts, PRICE_BANDS, SORTS, allSizes } from "../lib/shop.js";
import { esc, pluralize } from "../lib/format.js";
import { grid, skeletonGrid, bindCardSwatches, emptyState, catalogGate, previewGrid } from "../ui/components.js";
import { openSheet, closeSheet } from "../ui/layout.js";
import { navigate } from "../app/router.js";

const AVAILABILITY = [
  { id: "instock", label: "In stock only" },
  { id: "sale", label: "On sale" },
];
const PAGE_SIZE = 12;

const readFilters = (query) => ({
  sizes: query.getAll("size"),
  colors: query.getAll("color"),
  price: query.getAll("price"),
  avail: query.getAll("avail").filter((v) => AVAILABILITY.some((a) => a.id === v)),
  sort: SORTS.some((s) => s.id === query.get("sort")) ? query.get("sort") : "featured",
});

export default async function shop(ctx) {
  const { outlet, params, query } = ctx;
  const categorySlug = params[0];
  outlet.innerHTML = `<div class="page shop">${skeletonGrid()}</div>`;
  if (!(await catalogGate(outlet, () => shop(ctx)))) return;
  const { products, categories, colorFamilies } = getCatalog();

  const category = categorySlug ? categoryBySlug(categorySlug) : null;
  if (categorySlug && !category) return navigate("/shop", { replace: true });
  document.title = `${category ? category.name : "All Footwear"} — Shop`;

  const filters = readFilters(query);
  const scope = category ? products.filter((p) => p.category === category.id) : products;
  const sizes = allSizes(scope);
  const families = colorFamilies.filter((f) => scope.some((p) => p.colors.some((c) => c.family === f.id)));

  const filterForm = (idPrefix) => `
    <form class="filters" data-filters aria-label="Filter products">
      <fieldset class="filter-group">
        <legend>Size <span class="muted">(in stock)</span></legend>
        <div class="size-opts size-opts--filter">
          ${sizes
            .map(
              (s) => `<label class="size-opt"><input type="checkbox" name="size" value="${esc(s.id)}" ${filters.sizes.includes(s.id) ? "checked" : ""}/><span>${esc(s.label)}</span></label>`,
            )
            .join("")}
        </div>
      </fieldset>
      <fieldset class="filter-group">
        <legend>Colour</legend>
        ${families
          .map(
            (f) => `<label class="check"><input type="checkbox" name="color" value="${f.id}" ${filters.colors.includes(f.id) ? "checked" : ""}/>
              <span class="check__dot" style="--swatch:${f.hex}"></span>${esc(f.name)}</label>`,
          )
          .join("")}
      </fieldset>
      <fieldset class="filter-group">
        <legend>Price</legend>
        ${PRICE_BANDS.map(
          (b) => `<label class="check"><input type="checkbox" name="price" value="${b.id}" ${filters.price.includes(b.id) ? "checked" : ""}/>${esc(b.label)}</label>`,
        ).join("")}
      </fieldset>
      <fieldset class="filter-group">
        <legend>Availability</legend>
        ${AVAILABILITY.map(
          (a) => `<label class="check"><input type="checkbox" name="avail" value="${a.id}" ${filters.avail.includes(a.id) ? "checked" : ""}/>${esc(a.label)}</label>`,
        ).join("")}
      </fieldset>
      <button type="button" class="text-btn" data-clear-filters id="${idPrefix}-clear">Clear all filters</button>
    </form>`;

  outlet.innerHTML = `
  <div class="page shop">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>${category ? "Category" : "The Collection"}</p>
      <h1 class="page-title">${category ? esc(category.name) : filters.avail.includes("sale") ? "On <em>Sale</em>" : "All <em>Footwear</em>"}</h1>
      ${category?.blurb ? `<p class="page-lede">${esc(category.blurb)}</p>` : ""}
    </header>

    <nav class="cat-nav" aria-label="Categories">
      <a href="/shop${query.toString() ? `?${query}` : ""}" ${!category ? 'aria-current="page"' : ""}>All</a>
      ${categories.map((c) => `<a href="/shop/${esc(c.slug)}${query.toString() ? `?${query}` : ""}" ${category?.id === c.id ? 'aria-current="page"' : ""}>${esc(c.name)}</a>`).join("")}
    </nav>

    <div class="shop__layout">
      <aside class="shop__aside" aria-label="Filters">${filterForm("side")}</aside>
      <div class="shop__main">
        <div class="toolbar">
          <button type="button" class="btn btn--ghost toolbar__filter" data-open-filters>Filter <span data-filter-count></span></button>
          <p class="toolbar__count" aria-live="polite" data-count></p>
          <label class="sort">
            <span class="muted">Sort</span>
            <select data-sort>${SORTS.map((s) => `<option value="${s.id}" ${s.id === filters.sort ? "selected" : ""}>${s.label}</option>`).join("")}</select>
          </label>
        </div>
        <div class="active-filters" data-active></div>
        <div data-results></div>
      </div>
    </div>
  </div>`;

  const results = outlet.querySelector("[data-results]");
  const count = outlet.querySelector("[data-count]");
  const active = outlet.querySelector("[data-active]");
  const filterCount = outlet.querySelector("[data-filter-count]");

  const labelFor = (name, value) =>
    name === "size"
      ? sizes.find((s) => s.id === value)?.label ?? "Size"
      : name === "color"
        ? colorFamilies.find((f) => f.id === value)?.name
        : name === "avail"
          ? AVAILABILITY.find((a) => a.id === value)?.label
          : PRICE_BANDS.find((b) => b.id === value)?.label;
  const arrFor = (name) => ({ size: filters.sizes, color: filters.colors, price: filters.price, avail: filters.avail })[name];
  const runQuery = () =>
    queryProducts(scope, { ...filters, inStock: filters.avail.includes("instock"), sale: filters.avail.includes("sale") });

  let shown = PAGE_SIZE;
  const renderPage = (list) => {
    const more = list.length - shown;
    return `${grid(list.slice(0, shown))}${
      more > 0
        ? `<div class="load-more"><p class="muted">Showing ${shown} of ${list.length}</p><button type="button" class="btn btn--ghost" data-load-more>Show ${Math.min(more, PAGE_SIZE)} more</button></div>`
        : ""
    }`;
  };

  const update = ({ keepPage = false } = {}) => {
    if (!keepPage) shown = PAGE_SIZE;
    const list = runQuery();
    count.textContent = pluralize(list.length, "style");
    results.innerHTML = list.length
      ? renderPage(list)
      : !scope.length
        ? `${previewGrid()}<div class="empty"><p class="empty__title">${category ? "Nothing in this category yet." : "Our collection is on its way."}</p><p class="empty__text">Real products are being added. Please check back soon.</p></div>`
        : emptyState({
            title: "No styles match these filters.",
            text: "Try removing a size or colour, or browse the full collection.",
            cta: "Clear filters",
            href: category ? `/shop/${category.slug}` : "/shop",
          });

    const chips = [
      ...filters.sizes.map((v) => ["size", v]),
      ...filters.colors.map((v) => ["color", v]),
      ...filters.price.map((v) => ["price", v]),
      ...filters.avail.map((v) => ["avail", v]),
    ];
    active.innerHTML = chips
      .map(([n, v]) => `<button type="button" class="chip chip--remove" data-remove-filter="${n}:${v}" aria-label="Remove filter ${esc(labelFor(n, v))}">${esc(labelFor(n, v))}<span aria-hidden="true">×</span></button>`)
      .join("");
    filterCount.textContent = chips.length ? `(${chips.length})` : "";

    const qs = new URLSearchParams();
    filters.sizes.forEach((s) => qs.append("size", s));
    filters.colors.forEach((c) => qs.append("color", c));
    filters.price.forEach((p) => qs.append("price", p));
    filters.avail.forEach((a) => qs.append("avail", a));
    if (filters.sort !== "featured") qs.set("sort", filters.sort);
    const url = `${location.pathname}${qs.toString() ? `?${qs}` : ""}`;
    history.replaceState(history.state, "", url);
    outlet.querySelectorAll(".cat-nav a").forEach((a) => {
      const u = new URL(a.href);
      u.search = qs.toString();
      a.href = u.pathname + u.search;
    });
    return list.length;
  };

  const syncForms = () => {
    document.querySelectorAll("[data-filters]").forEach((form) => {
      form.querySelectorAll("input").forEach((input) => {
        const arr = arrFor(input.name);
        input.checked = arr.includes(input.value);
      });
    });
  };

  const onFormChange = (e) => {
    const input = e.target;
    if (!input.name) return;
    const arr = arrFor(input.name);
    if (!arr) return;
    const v = input.value;
    const i = arr.indexOf(v);
    if (input.checked && i < 0) arr.push(v);
    if (!input.checked && i >= 0) arr.splice(i, 1);
    const n = update();
    syncForms();
    const showBtn = document.querySelector("[data-show-results]");
    if (showBtn) showBtn.textContent = `Show ${pluralize(n, "style")}`;
  };

  const clearAll = () => {
    filters.sizes.length = 0;
    filters.colors.length = 0;
    filters.price.length = 0;
    filters.avail.length = 0;
    update();
    syncForms();
  };

  const bindForm = (root) => {
    root.addEventListener("change", onFormChange);
    root.addEventListener("click", (e) => e.target.closest("[data-clear-filters]") && clearAll());
  };
  bindForm(outlet.querySelector(".shop__aside"));

  outlet.querySelector("[data-sort]").addEventListener("change", (e) => {
    filters.sort = e.target.value;
    update();
  });

  outlet.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-remove-filter]");
    if (chip) {
      const [n, v] = chip.dataset.removeFilter.split(":");
      const arr = arrFor(n);
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1);
      update();
      syncForms();
      (active.querySelector("button") ?? outlet.querySelector("[data-sort]")).focus();
    }
    if (e.target.closest("[data-load-more]")) {
      const firstNew = shown;
      shown += PAGE_SIZE;
      update({ keepPage: true });
      // Move focus to the first newly revealed product for keyboard users.
      results.querySelectorAll(".card__title a")[firstNew]?.focus();
    }
    if (e.target.closest(".empty .btn")) {
      e.preventDefault();
      clearAll();
    }
    if (e.target.closest("[data-open-filters]")) {
      openSheet(
        "Filter",
        `${filterForm("sheet")}<button type="button" class="btn btn--primary btn--block" data-show-results>Show ${pluralize(runQuery().length, "style")}</button>`,
        (body) => {
          bindForm(body);
          body.querySelector("[data-show-results]").addEventListener("click", closeSheet);
        },
      );
    }
  });

  bindCardSwatches(outlet, products);
  update();
}
