import { getHero } from "../ui/hero.js";
import { catalogReady, getCatalog } from "../app/state.js";
import { queryProducts } from "../lib/shop.js";
import { esc } from "../lib/format.js";
import { illustration } from "../ui/illustration.js";
import { grid, bindCardSwatches, arrow, placeholderNote } from "../ui/components.js";
import { STORE } from "../config.js";

const CATEGORY_ART = {
  sneakers: { style: "sneaker", color: { hex: "#c99389", sole: "#ece6dc" } },
  casual: { style: "loafer", color: { hex: "#6b4429", sole: "#2a1d14" } },
  formal: { style: "oxford", color: { hex: "#1f1d1b", sole: "#141210" } },
  boots: { style: "chelsea", color: { hex: "#8a6342", sole: "#1a1512" } },
  sandals: { style: "sandal", color: { hex: "#a8764b", sole: "#2a211a" } },
  women: { style: "heel", color: { hex: "#1f2740", sole: "#141210" } },
  kids: { style: "school", color: { hex: "#1b1a19", sole: "#141210" } },
};

export default async function home({ outlet }) {
  document.title = STORE.name ? `${STORE.name} — ${STORE.contact.address.split(",").pop().trim() || "Footwear"}` : "Footwear — Studio Edition";
  outlet.append(getHero());

  await catalogReady;
  const { products, categories } = getCatalog();
  const newest = queryProducts(products, { sort: "newest" }).slice(0, 4);
  const featured = queryProducts(products, { sort: "featured" }).filter((p) => p.featured).slice(0, 4);

  const sections = document.createElement("div");
  sections.innerHTML = `
  <section class="section categories" id="categories" aria-labelledby="cat-title">
    <header class="section__head">
      <p class="kicker"><span class="kicker__line"></span>The Collection</p>
      <h2 class="section__title" id="cat-title">Shop by <em>category</em></h2>
    </header>
    <div class="cat-grid">
      ${categories
        .map((c, i) => {
          const art = CATEGORY_ART[c.id] ?? CATEGORY_ART.sneakers;
          const count = products.filter((p) => p.category === c.id).length;
          return `
          <a class="cat-tile cat-tile--${i + 1}" href="/shop/${c.id}">
            <span class="cat-tile__no">0${i + 1}</span>
            <span class="cat-tile__art">${illustration(art.style, art.color, { label: "" })}</span>
            <span class="cat-tile__text">
              <span class="cat-tile__name">${esc(c.name)}</span>
              <span class="cat-tile__blurb">${esc(c.blurb)}</span>
              <span class="cat-tile__cta">Shop ${esc(c.name.toLowerCase())} · ${count} styles <span class="cat-tile__arrow" aria-hidden="true"></span></span>
            </span>
          </a>`;
        })
        .join("")}
    </div>
  </section>

  <section class="section rail" aria-labelledby="rail-title">
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
    <div role="tabpanel" id="panel-featured" aria-labelledby="tab-featured" hidden>${grid(featured)}</div>
    <a class="btn btn--ghost section__more" href="/shop">View all footwear</a>
  </section>

  <section class="section story" aria-labelledby="story-title">
    <div class="story__mark" aria-hidden="true">
      ${illustration("wholecut", { hex: "#4e2e1c", sole: "#16120f" })}
    </div>
    <div class="story__text">
      <p class="kicker"><span class="kicker__line"></span>The Store</p>
      <h2 class="section__title" id="story-title">${esc(STORE.name || "The store")}, <em>${esc(STORE.contact.address.split(",").pop().trim() || "in the owner’s words")}.</em></h2>
      ${STORE.contact.address ? `<p class="story__visit">Visit us on <strong>${esc(STORE.contact.address)}</strong>${STORE.contact.phone ? ` · <a class="text-link" href="tel:+92${esc(STORE.contact.phone.replace(/\D/g, "").replace(/^0/, ""))}">${esc(STORE.contact.phone)}</a>` : ""}${STORE.contact.instagram ? ` · <a class="text-link" href="${esc(STORE.contact.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ""}</p>` : ""}
      ${placeholderNote("The store’s own story — how it began and how it chooses its shoes — will go here, written with the owner rather than invented.")}
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
      <li><span class="how__no">II</span><h3>Review your order</h3><p>Check items and totals, then add your contact and delivery details.</p></li>
      <li><span class="how__no">III</span><h3>Confirm on WhatsApp</h3><p>Your order opens in WhatsApp, ready to send. The store replies to confirm availability, delivery and acceptance.</p></li>
    </ol>
    <div class="how__info">
      <p><strong>Delivery</strong> ${STORE.deliveryFee === null ? "Charges and timelines are confirmed by the store on WhatsApp." : "See shipping details for charges and timelines."} <a class="text-link" href="/shipping">Shipping &amp; delivery</a></p>
      <p><strong>Sizing</strong> EU sizes throughout. Unsure? <a class="text-link" href="/size-guide">Size guide</a></p>
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
