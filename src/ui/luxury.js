/**
 * Premium motion layer. Purely visual: scroll progress, staggered reveals, cursor light, card tilt,
 * magnetic buttons and drifting gold dust in the hero. Everything respects "reduce motion", touch
 * devices skip the pointer effects, and with JavaScript off the page is simply static and fully visible.
 */

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Elements that fade/slide in as they enter the viewport. */
const REVEAL = ".section__head, .page-head, .cat-tile, .card, .how__steps li, .story__text, .story__mark, .banner, .review, .pdp .gallery, .pdp .buy, .adm-card, .order-card, .empty, .section__more, .how__info";

export function initLuxury() {
  progressBar();
  if (!reduce) {
    reveals();
    dustWatcher();
  }
  if (fine && !reduce) {
    cursorLight();
    tiltCards();
    magnetic();
  }
}

/* ───────── Gold scroll-progress hairline ───────── */
function progressBar() {
  const bar = document.createElement("div");
  bar.className = "lux-progress";
  bar.setAttribute("aria-hidden", "true");
  document.body.append(bar);
  let ticking = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    ticking = false;
  };
  addEventListener("scroll", () => ticking || ((ticking = true), requestAnimationFrame(update)), { passive: true });
  addEventListener("resize", update);
  update();
}

/* ───────── Staggered reveal on scroll (also for pages rendered later by the router) ───────── */
function reveals() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px 18% 0px", threshold: 0 },
  );
  const seen = new WeakSet();
  const scan = (root = document) => {
    let n = 0;
    root.querySelectorAll(REVEAL).forEach((el) => {
      if (seen.has(el) || el.closest("dialog")) return;
      seen.add(el);
      el.classList.add("lux-reveal");
      el.style.setProperty("--d", `${(n++ % 6) * 80}ms`);
      io.observe(el);
    });
  };
  const outlet = document.getElementById("main") ?? document.body;
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan(outlet);
    });
  }).observe(outlet, { childList: true, subtree: true });
  scan(outlet);
}

/* ───────── A soft gold light that follows the cursor ───────── */
function cursorLight() {
  const glow = document.createElement("div");
  glow.className = "lux-glow";
  glow.setAttribute("aria-hidden", "true");
  document.body.append(glow);
  let x = 0;
  let y = 0;
  let queued = false;
  addEventListener(
    "pointermove",
    (e) => {
      x = e.clientX;
      y = e.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        glow.classList.add("is-on");
        queued = false;
      });
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => glow.classList.remove("is-on"));
}

/* ───────── 3D tilt + moving highlight on product cards ───────── */
function tiltCards() {
  document.addEventListener(
    "pointermove",
    (e) => {
      const media = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest(".card__media, .cat-tile") : null);
      if (!media) return;
      const r = media.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      media.style.setProperty("--rx", `${((0.5 - py) * 7).toFixed(2)}deg`);
      media.style.setProperty("--ry", `${((px - 0.5) * 9).toFixed(2)}deg`);
      media.style.setProperty("--px", `${(px * 100).toFixed(1)}%`);
      media.style.setProperty("--py", `${(py * 100).toFixed(1)}%`);
      media.classList.add("is-tilting");
    },
    { passive: true },
  );
  document.addEventListener(
    "pointerout",
    (e) => {
      const media = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest(".card__media, .cat-tile") : null);
      if (!media || media.contains(/** @type {Node | null} */ (e.relatedTarget))) return;
      media.classList.remove("is-tilting");
      media.style.removeProperty("--rx");
      media.style.removeProperty("--ry");
    },
    { passive: true },
  );
}

/* ───────── Magnetic primary buttons ───────── */
function magnetic() {
  document.addEventListener(
    "pointermove",
    (e) => {
      const btn = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest(".btn--primary") : null);
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      btn.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * 0.12).toFixed(1)}px, ${((e.clientY - r.top - r.height / 2) * 0.2).toFixed(1)}px)`;
    },
    { passive: true },
  );
  document.addEventListener(
    "pointerout",
    (e) => {
      const btn = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest(".btn--primary") : null);
      if (btn && !btn.contains(/** @type {Node | null} */ (e.relatedTarget))) btn.style.transform = "";
    },
    { passive: true },
  );
}

/* ───────── Drifting gold dust in the hero (canvas, paused when off-screen) ───────── */
function dustWatcher() {
  const attach = () => {
    const hero = document.querySelector(".hero:not([data-dust])");
    if (!hero) return;
    hero.setAttribute("data-dust", "");
    dust(/** @type {HTMLElement} */ (hero));
  };
  attach();
  new MutationObserver(attach).observe(document.getElementById("main") ?? document.body, { childList: true, subtree: true });
}

function dust(hero) {
  const canvas = document.createElement("canvas");
  canvas.className = "lux-dust";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const COUNT = innerWidth < 700 ? 22 : 48;
  let w = 0;
  let h = 0;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const resize = () => {
    w = hero.clientWidth;
    h = hero.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener("resize", resize);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const motes = Array.from({ length: COUNT }, () => ({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.4, 1.7), vy: rnd(-0.09, -0.02), vx: rnd(-0.03, 0.05), a: rnd(0.15, 0.7), p: rnd(0, 6.28) }));
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(hero);
  let t = 0;
  const frame = () => {
    requestAnimationFrame(frame);
    if (!visible || document.hidden || !hero.isConnected) return;
    t += 0.016;
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.x += m.vx;
      m.y += m.vy;
      if (m.y < -4) m.y = h + 4;
      if (m.x > w + 4) m.x = -4;
      if (m.x < -4) m.x = w + 4;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.4 + m.p);
      ctx.beginPath();
      ctx.fillStyle = `rgba(217, 190, 130, ${(m.a * tw).toFixed(3)})`;
      ctx.shadowColor = "rgba(217, 190, 130, 0.9)";
      ctx.shadowBlur = 6;
      ctx.arc(m.x, m.y, m.r, 0, 6.283);
      ctx.fill();
    }
  };
  frame();
}
