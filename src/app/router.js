/**
 * Minimal History-API router. Views are functions ({ outlet, params, query }) that render into
 * <main> and may return a cleanup function.
 */
const routes = [];
const outlet = document.getElementById("main");
let cleanup = null;
let first = true;
const listeners = new Set();

history.scrollRestoration = "manual";

export function route(pattern, view, name) {
  routes.push({ pattern, view, name });
}

export const onRouteChange = (fn) => listeners.add(fn);

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.href);
  // Remember where we were so Back returns to the same scroll position.
  history.replaceState({ ...history.state, scroll: window.scrollY }, "");
  history[replace ? "replaceState" : "pushState"]({ scroll: 0 }, "", url.pathname + url.search + url.hash);
  render({ restore: false });
}

function scrollToHash(hash, smooth) {
  const el = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
  if (!el) return false;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  return true;
}

async function render({ restore }) {
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const match = routes.map((r) => ({ r, m: path.match(r.pattern) })).find((x) => x.m);
  const { r, m } = match ?? { r: routes.find((x) => x.name === "notfound"), m: [] };

  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());

  document.body.dataset.route = r.name;
  outlet.replaceChildren();
  cleanup = await r.view({ outlet, params: m.slice(1).map((p) => p && decodeURIComponent(p)), query: url.searchParams });

  listeners.forEach((fn) => fn(r.name, url));

  if (restore && history.state?.scroll) window.scrollTo(0, history.state.scroll);
  else if (!scrollToHash(url.hash, false)) window.scrollTo(0, 0);

  if (!first) outlet.focus({ preventScroll: true });
  first = false;
}

export function startRouter() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    // Same page, only a hash: smooth-scroll instead of re-rendering.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) {
      scrollToHash(url.hash, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      return;
    }
    navigate(url.href);
  });
  window.addEventListener("popstate", () => render({ restore: true }));
  return render({ restore: false });
}
