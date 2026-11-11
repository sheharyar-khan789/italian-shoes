/**
 * Admin dashboard frame: sidebar, top bar (notifications, account), content area and the
 * /admin/* router. Mounted by main.js once a staff member is signed in.
 */
import { esc } from "../lib/format.js";
import { DEFAULT_ROLES } from "../../shared/permissions.js";
import { visibleModules, moduleForPath, subPath } from "./modules.js";
import { watchNotifications } from "./data.js";
import { loading, errorState } from "./ui/kit.js";
import * as session from "../app/session.js";

/** @param {HTMLElement} root @param {import("../app/session.js").SessionUser} user */
export function mountShell(root, user) {
  const modules = visibleModules(user.perms);
  const roleNames = user.roles.map((r) => DEFAULT_ROLES[r]?.name ?? r).join(", ");

  root.className = "adm";
  root.innerHTML = `
    <a class="skip-link" href="#adm-main">Skip to content</a>
    <header class="adm-top">
      <button type="button" class="adm-top__menu" aria-expanded="false" aria-controls="adm-nav" data-nav-toggle>
        <span class="visually-hidden">Menu</span><span class="menu-toggle__bars" aria-hidden="true"><i></i><i></i></span>
      </button>
      <a class="brand" href="/admin" data-link aria-label="Admin home"><span class="brand__mark" aria-hidden="true"></span><span class="brand__word">Italian Shoes</span></a>
      <span class="adm-top__tag">Admin</span>
      <div class="adm-top__right">
        <a class="adm-bell" href="/admin/notifications" data-link aria-label="Notifications">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
          <span class="adm-bell__count" data-unread hidden></span>
        </a>
        <span class="adm-top__user"><strong>${esc(user.name || user.email || "")}</strong><span class="muted">${esc(roleNames)}</span></span>
        <a class="text-link adm-top__store" href="/">View store</a>
        <button type="button" class="text-btn" data-sign-out>Sign out</button>
      </div>
    </header>
    <nav class="adm-nav" id="adm-nav" aria-label="Admin">
      <ul>
        ${modules
          .map((m) =>
            m.soon
              ? `<li><span class="adm-nav__item is-soon" aria-disabled="true">${esc(m.label)}<span class="adm-nav__soon">Soon</span></span></li>`
              : `<li><a class="adm-nav__item" href="${m.path}" data-link data-module="${m.key}">${esc(m.label)}</a></li>`,
          )
          .join("")}
      </ul>
    </nav>
    <main class="adm-main" id="adm-main" tabindex="-1"></main>`;

  const main = /** @type {HTMLElement} */ (root.querySelector("#adm-main"));
  const nav = /** @type {HTMLElement} */ (root.querySelector("#adm-nav"));
  const toggle = /** @type {HTMLButtonElement} */ (root.querySelector("[data-nav-toggle]"));
  let cleanup = null;

  const setNav = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("is-open", open);
  };
  toggle.addEventListener("click", () => setNav(toggle.getAttribute("aria-expanded") !== "true"));
  // Mobile menu: Escape or a tap outside closes it.
  const onKey = (e) => {
    if (e.key === "Escape" && nav.classList.contains("is-open")) {
      setNav(false);
      toggle.focus();
    }
  };
  const onOutside = (e) => {
    if (nav.classList.contains("is-open") && !nav.contains(/** @type {Node} */ (e.target)) && !toggle.contains(/** @type {Node} */ (e.target))) setNav(false);
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onOutside);
  root.querySelector("[data-sign-out]").addEventListener("click", () => session.signOutUser());

  async function render() {
    if (typeof cleanup === "function") cleanup();
    cleanup = null;
    setNav(false);
    const mod = moduleForPath(location.pathname);
    const allowed = mod && !mod.soon && mod.load && (!mod.perm || user.perms.includes(mod.perm));
    nav.querySelectorAll("[data-module]").forEach((a) => a.toggleAttribute("aria-current", a.getAttribute("data-module") === mod?.key));
    nav.querySelectorAll("[aria-current]").forEach((a) => a.setAttribute("aria-current", "page"));

    if (!allowed) {
      document.title = "Not available — Admin";
      main.innerHTML = `<div class="adm-page"><h1 class="adm-h1">Not available</h1><p class="muted">${
        mod?.soon ? `${esc(mod.label)} arrives in ${esc(mod.soon)}.` : "This page doesn't exist, or your role doesn't include it."
      }</p><p><a class="text-link" href="/admin" data-link>Back to the overview</a></p></div>`;
      return;
    }
    document.title = `${mod.label} — Admin`;
    // Each page draws into its OWN container. If the person opens another page while this one is still
    // loading (slow connections), the old page keeps writing into a container that is no longer shown.
    const page = document.createElement("div");
    page.innerHTML = loading();
    main.replaceChildren(page);
    try {
      const view = (await mod.load()).default;
      const result = await view({ main: page, user, params: subPath(location.pathname, mod), navigate: go });
      if (page.isConnected) cleanup = result;
      else if (typeof result === "function") result();
    } catch (error) {
      console.error(error);
      if (page.isConnected) {
        page.innerHTML = errorState();
        page.querySelector("[data-retry]")?.addEventListener("click", render);
      }
    }
    main.focus({ preventScroll: true });
  }

  /** Navigate inside the admin without a full reload. @param {string} path */
  function go(path) {
    if (path !== location.pathname) history.pushState({}, "", path);
    render();
  }

  // In-admin navigation without full reloads.
  root.addEventListener("click", (e) => {
    const a = /** @type {HTMLAnchorElement | null} */ (/** @type {Element} */ (e.target).closest("a[data-link]"));
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(a.pathname);
  });
  window.addEventListener("popstate", render);

  // Unread notification count in the top bar (live).
  const badge = /** @type {HTMLElement} */ (root.querySelector("[data-unread]"));
  const bell = root.querySelector(".adm-bell");
  let unwatch = () => {};
  watchNotifications(
    user.perms,
    (items) => {
      const unread = items.filter((n) => !n.readBy?.includes(user.uid)).length;
      badge.textContent = unread > 9 ? "9+" : String(unread);
      badge.hidden = unread === 0;
      bell.setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
    },
    () => (badge.hidden = true),
  ).then((fn) => (unwatch = fn));

  render();
  return () => {
    unwatch();
    if (typeof cleanup === "function") cleanup();
    window.removeEventListener("popstate", render);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onOutside);
  };
}
