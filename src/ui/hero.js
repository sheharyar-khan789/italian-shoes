/**
 * The approved homepage hero — markup, entrance, scroll drift and 3D stage — unchanged in design.
 * It is built once and the same DOM node (with its live WebGL canvas) is re-attached whenever
 * the visitor returns to the homepage, so the model never reloads. The scene pauses itself while
 * the hero is detached or off-screen.
 */

const TEMPLATE = `
<section class="hero" aria-labelledby="hero-title">
  <div class="hero__light" aria-hidden="true"></div>
  <canvas class="hero__canvas" aria-hidden="true"></canvas>

  <!-- Shown only when WebGL is unavailable: an honest, abstract stage — not a fake 3D shoe. -->
  <div class="hero__fallback" aria-hidden="true">
    <div class="fallback__plinth"></div>
  </div>

  <div class="hero__grid">
    <div class="hero__copy">
      <p class="eyebrow" data-reveal>
        <span class="eyebrow__line" aria-hidden="true"></span>
        Studio Edition <span class="eyebrow__no">Nº 01</span>
      </p>

      <h1 class="headline" id="hero-title">
        <span class="headline__row"><span data-reveal>Every step,</span></span>
        <span class="headline__row headline__row--indent"><em data-reveal>considered.</em></span>
      </h1>
    </div>

    <div class="hero__stage" aria-hidden="true"></div>

    <div class="hero__aside">
      <p class="lede" data-reveal>
        Sneakers, formal and casual shoes for men, women and children — chosen for every hour of the day.
      </p>
      <div class="ctas" data-reveal>
        <a class="btn btn--primary" href="/shop">
          <span>Explore the Collection</span>
          <span class="btn__arrow" aria-hidden="true"></span>
        </a>
        <a class="btn btn--ghost" href="#categories">Shop by Category</a>
      </div>
    </div>

    <div class="hero__foot">
      <a class="scroll-cue" href="#categories" data-reveal>
        <span class="scroll-cue__track" aria-hidden="true"><span></span></span>
        <span>Scroll to explore</span>
      </a>

      <p class="drag-hint" data-reveal aria-hidden="true">
        <span class="drag-hint__icon"></span> Drag to turn
      </p>

      <div class="specimen" data-reveal>
        <p class="specimen__label">
          <span class="specimen__fig">Fig. 01</span>
          <a class="specimen__link" href="/shop">Low-top sneaker</a>
          <span class="specimen__status" aria-live="polite">Preparing the studio…</span>
        </p>
        <div class="finishes" role="group" aria-label="Choose a finish" hidden></div>
      </div>
    </div>
  </div>

  <div class="loader" aria-hidden="true"><span></span></div>
</section>`;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let hero = null;

const hasWebGL = () => {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
};

function build() {
  const tpl = document.createElement("template");
  tpl.innerHTML = TEMPLATE.trim();
  hero = tpl.content.firstElementChild;

  // Stagger index for the entrance choreography, in document order.
  hero.querySelectorAll("[data-reveal]").forEach((el, i) => el.style.setProperty("--i", i + 1));

  /* Scroll-linked copy drift */
  if (!reducedMotion) {
    let ticking = false;
    window.addEventListener(
      "scroll",
      () => {
        if (ticking || !hero.isConnected) return;
        ticking = true;
        requestAnimationFrame(() => {
          const p = Math.min(1, Math.max(0, window.scrollY / hero.offsetHeight));
          hero.style.setProperty("--scroll", p.toFixed(4));
          ticking = false;
        });
      },
      { passive: true },
    );
  }

  // The specimen link goes to the shop: the 3D model is a showcase, not a product in the catalogue.

  const status = hero.querySelector(".specimen__status");
  return status;
}

function startStage(status) {
  if (!hasWebGL()) {
    document.body.classList.add("no-webgl", "is-lit");
    status.textContent = "Interactive view unavailable on this device";
    return;
  }
  import("../scene.js")
    .then(({ createStage }) =>
      createStage({
        hero,
        canvas: hero.querySelector(".hero__canvas"),
        anchor: hero.querySelector(".hero__stage"),
        finishes: hero.querySelector(".finishes"),
        status,
        reducedMotion,
      }),
    )
    .catch((err) => {
      console.error(err);
      document.body.classList.add("no-webgl", "is-lit");
      status.textContent = "Interactive view unavailable";
    });
}

/** Returns the hero element, building it and starting the 3D stage on first use. */
export function getHero() {
  if (hero) {
    hero.style.setProperty("--scroll", "0");
    return hero;
  }
  const status = build();
  // The stage measures the layout, so start it once the hero is in the document.
  queueMicrotask(() => startStage(status));
  return hero;
}
