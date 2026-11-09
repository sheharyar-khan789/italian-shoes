import { getHero } from "../ui/hero.js";
import { getCatalog, getSettings } from "../app/state.js";
import { loadBanners } from "../data/store.js";
import { queryProducts } from "../lib/shop.js";
import { esc } from "../lib/format.js";
import { illustration } from "../ui/illustration.js";
import { grid, bindCardSwatches, catalogGate } from "../ui/components.js";

const CATEGORY_ART = {
  sneakers: { style: "sneaker", color: { hex: "#c99389", sole: "#ece6dc" } },
  casual: { style: "loafer", color: { hex: "#6b4429", sole: "#2a1d14" } },
  formal: { style: "oxford", color: { hex: "#1f1d1b", sole: "#141210" } },
  boots: { style: "chelsea", color: { hex: "#8a6342", sole: "#1a1512" } },
  sandals: { style: "sandal", color: { hex: "#a8764b", sole: "#2a211a" } },
  women: { style: "heel", color: { hex: "#1f2740", sole: "#141210" } },
  kids: { style: "school", color: { hex: "#1b1a19", sole: "#141210" } },
};

export default async function home(ctx) {
  const { outlet } = ctx;
  outlet.append(getHero());

  if (!(await catalogGate(outlet, () => home({ ...ctx, outlet })))) return;
  const { products, categories, home: layout } = getCatalog();
  const s = getSettings();
  document.title = s.seoTitle || s.storeName || "Italian Shoes";
  const show = (key) => layout?.[key] !== false;
  const newest = queryProducts(products, { sort: "newest" }).slice(0, 4);
  const picked = (layout?.featuredProductIds ?? []).map((id) => products.find((p) => p.id === id)).filter(Boolean);
  const featured = (picked.length ? picked : queryProducts(products, { sort: "featured" }).filter((p) => p.featured)).slice(0, 4);
  const banners = show("showBanners") ? await loadBanners().catch(() => []) : [];
  const city = (s.address ?? "").split(",").pop().trim();
  const phoneDigits = (s.phone ?? "").replace(/\D/g, "").replace(/^0/, "").replace(/^92/, "");

  const sections = document.createElement("div");
  sections.innerHTML = `
  ${
    banners.length
      ? `<section class="section banners" aria-label="Announcements">${banners
          .map(
            (b) => `<div class="banner"><p class="banner__title">${esc(b.title)}</p>${b.subtitle ? `<p class="banner__text">${esc(b.subtitle)}</p>` : ""}${b.linkUrl ? `<a class="btn btn--ghost" href="${esc(b.linkUrl)}"${b.linkUrl.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(b.linkLabel || "Learn more")}</a>` : ""}</div>`,
          )
          .join("")}</section>`
      : ""
  }
  ${
    !products.length
      ? `<section class="section"><div class="empty"><p class="empty__title">Our collection is being prepared.</p><p class="empty__text">Please check back soon${s.phone ? ` or call us on ${esc(s.phone)}` : ""}.</p></div></section>`
      : ""
  }
  ${layout?.introTitle ? `<section class="section"><h2 class="section__title">${esc(layout.introTitle)}</h2>${layout.introText ? `<p class="page-lede">${esc(layout.introText)}</p>` : ""}</section>` : ""}
  ${
    show("showCategories") && categories.length
      ? `<section class="section categories" id="categories" aria-labelledby="cat-title">
    <header class="section__head">
      <p class="kicker"><span class="kicker__line"></span>The Collection</p>
      <h2 class="section__title" id="cat-title">Shop by <em>category</em></h2>
    </header>
    <div class="cat-grid">
      ${categories
        .map((c, i) => {
          const art = CATEGORY_ART[c.slug] ?? CATEGORY_ART.sneakers;
          const count = products.filter((p) => p.category === c.id).length;
          return `
          <a class="cat-tile cat-tile--${i + 1}" href="/shop/${esc(c.slug)}">
            <span class="cat-tile__no">0${i + 1}</span>
            <span class="cat-tile__art">${illustration(art.style, art.color, { label: "" })}</span>
            <span class="cat-tile__text">
              <span class="cat-tile__name">${esc(c.name)}</span>
              ${c.blurb ? `<span class="cat-tile__blurb">${esc(c.blurb)}</span>` : ""}
              <span class="cat-tile__cta">Shop ${esc(c.name.toLowerCase())} · ${count} ${count === 1 ? "style" : "styles"} <span class="cat-tile__arrow" aria-hidden="true"></span></span>
            </span>
          </a>`;
        })
        .join("")}
    </div>
  </section>`
      : ""
  }

  ${
    products.length && (show("showNewArrivals") || show("showFeatured"))
      ? `<section class="section rail" aria-labelledby="rail-title">
    <header class="section__head section__head--split">
      <div>
        <p class="kicker"><span class="kicker__line"></span>Selected pairs</p>
        <h2 class="section__title" id="rail-title">The <em>edit</em></h2>
      </div>
      <div class="tabs" role="tablist" aria-label="Product selection">
        <button role="tab" id="tab-new" aria-controls="panel-new" aria-selected="true">New In</button>
        <button role="tab" id="tab-featured" aria-controls="panel-featured" aria-selected="false" tabindex="-1">Featured</button>
      </div>
    </header>
    <div role="tabpanel" id="panel-new" aria-labelledby="tab-new">${grid(newest)}</div>
    <div role="tabpanel" id="panel-featured" aria-labelledby="tab-featured" hidden>${featured.length ? grid(featured) : `<p class="muted">Nothing is featured right now.</p>`}</div>
    <a class="btn btn--ghost section__more" href="/shop">View all footwear</a>
  </section>`
      : ""
  }

  <section class="section story" aria-labelledby="story-title">
    <div class="story__mark" aria-hidden="true">
      ${illustration("wholecut", { hex: "#4e2e1c", sole: "#16120f" })}
    </div>
    <div class="story__text">
      <p class="kicker"><span class="kicker__line"></span>The Store</p>
      <h2 class="section__title" id="story-title">${esc(s.storeName || "Our store")}${city ? `, <em>${esc(city)}.</em>` : ""}</h2>
      ${s.address ? `<p class="story__visit">Visit us on <strong>${esc(s.address)}</strong>${phoneDigits ? ` · <a class="text-link" href="tel:+92${phoneDigits}">${esc(s.phone)}</a>` : ""}${s.instagram ? ` · <a class="text-link" href="${esc(s.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>` : ""}</p>` : ""}
      <a class="btn btn--ghost" href="/about">About the store</a>
    </div>
  </section>

  <section class="section how" aria-labelledby="how-title">
    <header class="section__head">
      <p class="kicker"><span class="kicker__line"></span>Ordering</p>
      <h2 class="section__title" id="how-title">Simple, <em>and personal.</em></h2>
    </header>
    <ol class="how__steps">
      <li><span class="how__no">I</span><h3>Choose your pair</h3><p>Pick a style, colour and size. Your bag is kept on this device as you browse.</p></li>
      <li><span class="how__no">II</span><h3>Check out</h3><p>Sign in, enter your delivery details and review the exact total, including delivery.</p></li>
      <li><span class="how__no">III</span><h3>Pay on delivery</h3><p>Your order is placed on the spot and you pay in cash when it arrives. Track it from your account.</p></li>
    </ol>
    <div class="how__info">
      <p><strong>Delivery</strong> Charges depend on your city and are shown before you order. <a class="text-link" href="/shipping">Shipping &amp; delivery</a></p>
      <p><strong>Questions</strong> We’re happy to help before you order. <a class="text-link" href="/contact">Contact</a></p>
    </div>
  </section>`;
  outlet.append(...sections.children);

  bindCardSwatches(outlet, products);

  // Accessible tabs (arrow keys move between them).
  const tabs = [...outlet.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });
}
