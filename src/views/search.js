import { getCatalog } from "../app/state.js";
import { searchProducts } from "../lib/shop.js";
import { esc, pluralize } from "../lib/format.js";
import { grid, bindCardSwatches, skeletonGrid, catalogGate } from "../ui/components.js";
import { navigate } from "../app/router.js";

export default async function search(ctx) {
  const { outlet, query } = ctx;
  const q = (query.get("q") ?? "").trim().slice(0, 80);
  document.title = q ? `Search: ${q}` : "Search";
  outlet.innerHTML = `<div class="page">${skeletonGrid(4)}</div>`;
  if (!(await catalogGate(outlet, () => search(ctx)))) return;
  const { products, categories } = getCatalog();
  const hits = searchProducts(products, categories, q);

  outlet.innerHTML = `
  <div class="page search-page">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>Search</p>
      <h1 class="page-title">${q ? `Results for <em>“${esc(q)}”</em>` : "Search the <em>collection</em>"}</h1>
      <form class="search-inline" role="search" data-search>
        <label class="visually-hidden" for="search-page-input">Search footwear</label>
        <input id="search-page-input" name="q" type="search" value="${esc(q)}" placeholder="Search by name, colour or category" />
        <button class="btn btn--primary" type="submit"><span>Search</span></button>
      </form>
      ${q ? `<p class="page-lede" aria-live="polite">${pluralize(hits.length, "style")} found.</p>` : ""}
    </header>
    ${
      q && !hits.length
        ? `<div class="empty"><p class="empty__title">Nothing matched “${esc(q)}”.</p>
           <p class="empty__text">Check the spelling, or browse a category:</p>
           <div class="suggest__chips">${categories.map((c) => `<a class="chip" href="/shop/${esc(c.slug)}">${esc(c.name)}</a>`).join("")}</div></div>`
        : hits.length
          ? grid(hits)
          : ""
    }
  </div>`;

  outlet.querySelector("[data-search]").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = new FormData(e.target).get("q").toString().trim();
    if (next) navigate(`/search?q=${encodeURIComponent(next)}`);
  });
  bindCardSwatches(outlet, products);
}
