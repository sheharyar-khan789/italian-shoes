/**
 * Admin entry (admin.html): staff sign-in, first-time Owner setup, then the dashboard (shell.js).
 *
 * What this page shows is a convenience only. Every admin action is authorised again on the
 * server (security rules and secureCallable check the custom claims).
 */
import { esc } from "../lib/format.js";
import { field, formValues, showResult, busy } from "../ui/forms.js";
import { mountShell } from "./shell.js";
import * as session from "../app/session.js";
import { reloadWhenUpdated } from "../app/updateReload.js";

reloadWhenUpdated();

// A product photo that fails to load (broken address, file removed at the source) shows a plain grey placeholder, not a broken-image icon.
const NO_PHOTO = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#ece6d8"/><path d="M16 52c8-2 12-10 18-14 6 6 12 8 30 10v6H16z" fill="#bfb49b"/></svg>');
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.matches(".adm-thumb, .adm-photo img") && !img.dataset.failed) {
      img.dataset.failed = "1";
      img.src = NO_PHOTO;
    }
  },
  true,
);

// Offline shell: lets the till reload while the internet is down (see scripts/sw.template.js). Production builds only.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register);
}

const root = /** @type {HTMLElement} */ (document.getElementById("admin"));
const brand = `<a class="brand" href="/" aria-label="Back to the store"><span class="brand__mark" aria-hidden="true"></span><span class="brand__word">Italian Shoes</span></a>`;

function renderSignIn(message = "") {
  root.innerHTML = `
    <div class="admin-card">
      ${brand}
      <h1 class="admin-card__title">Store <em>admin</em></h1>
      <p class="muted">Staff only. Sign in with your store account.</p>
      <form class="auth-form" novalidate data-form>
        <p class="form-alert" role="alert" tabindex="-1" data-form-alert ${message ? "" : "hidden"}>${esc(message)}</p>
        ${field({ name: "email", label: "Email", type: "email", autocomplete: "username", required: true, maxlength: 254 }, "adm")}
        ${field({ name: "password", label: "Password", type: "password", autocomplete: "current-password", required: true, maxlength: 128 }, "adm")}
        <button type="submit" class="btn btn--primary btn--block"><span>Sign in</span></button>
        <p class="auth-form__aside"><a class="text-link" href="/account/forgot-password">Forgot your password?</a></p>
      </form>
    </div>`;
  const form = /** @type {HTMLFormElement} */ (root.querySelector("[data-form]"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await busy(form, () => session.signIn(/** @type {any} */ (formValues(form))), "Signing in…");
    showResult(form, result);
  });
  root.querySelector("input")?.focus();
}

/** Signed in, but not staff: explain, and offer first-time Owner setup. */
function renderNoAccess(user) {
  root.innerHTML = `
    <div class="admin-card">
      ${brand}
      <h1 class="admin-card__title">No admin <em>access</em></h1>
      <p>You're signed in as <strong>${esc(user.email ?? "")}</strong>, which isn't a staff account.</p>
      <p class="muted">If you work at the store, ask the Owner to give your account access.</p>
      <details class="accordion admin-claim">
        <summary>I'm the store owner, setting up for the first time</summary>
        <p class="muted">This works once, only for the email address configured on the server as the owner's, and only after that email is verified.</p>
        ${user.emailVerified ? "" : `<p class="notice">Verify your email first: open the link we sent to ${esc(user.email ?? "")}, then reload this page.</p>`}
        <p class="form-alert" role="alert" data-claim-alert hidden></p>
        <button type="button" class="btn btn--primary" data-claim ${user.emailVerified ? "" : "disabled"}><span>Claim ownership</span></button>
      </details>
      <p class="admin-card__links"><a class="text-link" href="/">Back to the store</a> · <button type="button" class="text-btn" data-sign-out>Sign out</button></p>
    </div>`;
  root.querySelector("[data-sign-out]").addEventListener("click", () => session.signOutUser());
  root.querySelector("[data-claim]")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    const result = await session.claimOwnership();
    const alert = /** @type {HTMLElement} */ (root.querySelector("[data-claim-alert]"));
    if (!result.ok) {
      alert.textContent = result.message;
      alert.hidden = false;
      btn.disabled = false;
    }
    // On success the session listener re-renders with the new Owner claims.
  });
}

let unmount = null;
let shownFor = undefined; // avoid re-mounting the dashboard on token refreshes

function render(user) {
  const key = user ? `${user.uid}|${user.isStaff}|${user.perms.join(",")}` : null;
  if (key === shownFor) return;
  shownFor = key;
  if (typeof unmount === "function") unmount();
  unmount = null;
  root.className = "admin-gate";
  if (!user) renderSignIn();
  else if (!user.isStaff) renderNoAccess(user);
  else unmount = mountShell(root, user);
  root.focus({ preventScroll: true });
}

session.startSession().then(render);
session.onSessionChange(render);
