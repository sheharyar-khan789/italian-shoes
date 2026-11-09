/**
 * Customer account pages: sign in, create account, forgot password, profile, addresses, password.
 * Data access goes through src/app/session.js; security rules make sure each customer can only
 * ever read or change their own documents.
 */
import { esc } from "../lib/format.js";
import { arrow } from "../ui/components.js";
import { field, formValues, showResult, busy } from "../ui/forms.js";
import { navigate } from "../app/router.js";
import { PASSWORD_MIN } from "../../shared/schemas/account.js";
import { CITY_SUGGESTIONS } from "../config.js";
import * as session from "../app/session.js";

export const shell = (kicker, title, body, { narrow = true } = {}) => `
  <div class="page ${narrow ? "page--narrow" : ""} account">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>${kicker}</p>
      <h1 class="page-title">${title}</h1>
    </header>
    ${body}
  </div>`;

const alertBox = `<p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>`;
const submit = (label) => `<button type="submit" class="btn btn--primary btn--block"><span>${label}</span>${arrow}</button>`;

/** Redirect signed-out visitors to sign-in, returning here afterwards. */
export async function requireUser() {
  await session.whenReady();
  const user = session.currentUser();
  if (!user) {
    navigate(`/account/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    return null;
  }
  return user;
}

/* ───────── Sign in ───────── */

export async function loginView({ outlet, query }) {
  document.title = "Sign in";
  const next = session.safeNext(query.get("next"));
  await session.whenReady();
  if (session.currentUser()) return navigate(next, { replace: true });

  outlet.innerHTML = shell(
    "Account",
    "Sign <em>in</em>",
    `<form class="auth-form" novalidate data-form>
      ${alertBox}
      ${field({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true, maxlength: 254 }, "login")}
      ${field({ name: "password", label: "Password", type: "password", autocomplete: "current-password", required: true, maxlength: 128 }, "login")}
      <p class="auth-form__aside"><a class="text-link" href="/account/forgot-password">Forgot your password?</a></p>
      ${submit("Sign in")}
      <p class="auth-form__switch">New here? <a class="text-link" href="/account/register${next !== "/account" ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a></p>
    </form>`,
  );
  const form = outlet.querySelector("[data-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await busy(form, () => session.signIn(/** @type {any} */ (formValues(form))), "Signing in…");
    showResult(form, result);
    if (result.ok) navigate(next, { replace: true });
  });
}

/* ───────── Create account ───────── */

export async function registerView({ outlet, query }) {
  document.title = "Create an account";
  const next = session.safeNext(query.get("next"));
  await session.whenReady();
  if (session.currentUser()) return navigate(next, { replace: true });

  outlet.innerHTML = shell(
    "Account",
    "Create an <em>account</em>",
    `<form class="auth-form" novalidate data-form>
      ${alertBox}
      ${field({ name: "name", label: "Full name", autocomplete: "name", required: true, maxlength: 80 }, "reg")}
      ${field({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true, maxlength: 254 }, "reg")}
      ${field({ name: "phone", label: "Mobile number", type: "tel", inputmode: "tel", autocomplete: "tel", required: false, maxlength: 20, hint: "e.g. 0300 1234567" }, "reg")}
      ${field({ name: "password", label: "Password", type: "password", autocomplete: "new-password", required: true, maxlength: 128, hint: `At least ${PASSWORD_MIN} characters, with letters and a number` }, "reg")}
      <p class="fine">By creating an account you agree to the <a class="text-link" href="/terms">terms</a> and <a class="text-link" href="/privacy">privacy policy</a>.</p>
      ${submit("Create account")}
      <p class="auth-form__switch">Already have an account? <a class="text-link" href="/account/login">Sign in</a></p>
    </form>`,
  );
  const form = outlet.querySelector("[data-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await busy(form, () => session.signUp(/** @type {any} */ (formValues(form))), "Creating account…");
    showResult(form, result);
    if (result.ok) navigate(next === "/account" ? "/account?welcome=1" : next, { replace: true });
  });
}

/* ───────── Forgot password ───────── */

export async function forgotView({ outlet }) {
  document.title = "Reset your password";
  outlet.innerHTML = shell(
    "Account",
    "Reset your <em>password</em>",
    `<form class="auth-form" novalidate data-form>
      ${alertBox}
      <p class="page-lede">Enter the email you signed up with and we'll send you a link to choose a new password.</p>
      ${field({ name: "email", label: "Email", type: "email", autocomplete: "email", required: true, maxlength: 254 }, "fp")}
      ${submit("Send reset link")}
      <p class="auth-form__switch"><a class="text-link" href="/account/login">Back to sign in</a></p>
    </form>`,
  );
  const form = outlet.querySelector("[data-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email } = /** @type {any} */ (formValues(form));
    const result = await busy(form, () => session.requestPasswordReset(email), "Sending…");
    showResult(form, result);
    if (result.ok) {
      form.innerHTML = `<div class="notice notice--ok" role="status" tabindex="-1">
        <strong>Check your inbox.</strong> If an account exists for ${esc(String(email).trim())}, a reset link is on its way. It expires after a short time.
      </div><p class="auth-form__switch"><a class="text-link" href="/account/login">Back to sign in</a></p>`;
      form.querySelector(".notice")?.focus();
    }
  });
}

/* ───────── Account overview + profile ───────── */

export const accountNav = (active) => `
  <nav class="account-nav" aria-label="Account">
    <a href="/account" ${active === "profile" ? 'aria-current="page"' : ""}>Profile</a>
    <a href="/account/orders" ${active === "orders" ? 'aria-current="page"' : ""}>Orders</a>
    <a href="/account/wishlist" ${active === "wishlist" ? 'aria-current="page"' : ""}>Wishlist</a>
    <a href="/account/addresses" ${active === "addresses" ? 'aria-current="page"' : ""}>Addresses</a>
    <a href="/account/password" ${active === "password" ? 'aria-current="page"' : ""}>Password</a>
    <button type="button" class="text-btn" data-sign-out>Sign out</button>
  </nav>`;

export function bindSignOut(outlet) {
  outlet.querySelector("[data-sign-out]")?.addEventListener("click", async () => {
    await session.signOutUser();
    navigate("/", { replace: true });
  });
}

export async function accountView({ outlet, query }) {
  document.title = "Your account";
  const user = await requireUser();
  if (!user) return;
  const profile = (await session.loadProfile().catch(() => null)) ?? { name: user.name ?? "", phone: "" };

  const verify = user.emailVerified
    ? ""
    : `<div class="notice" role="note" data-verify>
        <strong>Please verify your email.</strong> We sent a link to ${esc(user.email ?? "")}.
        <span class="notice__actions"><button type="button" class="text-btn" data-resend>Send again</button>
        <button type="button" class="text-btn" data-verified>I've verified it</button></span>
      </div>`;

  outlet.innerHTML = shell(
    "Account",
    `Hello, <em>${esc((profile.name || user.name || "there").split(" ")[0])}</em>`,
    `${query.get("welcome") ? `<div class="notice notice--ok" role="status">Your account is ready.</div>` : ""}
     ${verify}
     ${accountNav("profile")}
     <section class="account-section" aria-labelledby="profile-title">
       <h2 class="account-section__title" id="profile-title">Your details</h2>
       <form class="auth-form" novalidate data-form>
         ${alertBox}
         ${field({ name: "name", label: "Full name", autocomplete: "name", required: true, maxlength: 80, value: profile.name }, "prof")}
         <div class="field"><span class="field-label">Email</span><p class="field-static">${esc(user.email ?? "")}</p></div>
         ${field({ name: "phone", label: "Mobile number", type: "tel", inputmode: "tel", autocomplete: "tel", required: false, maxlength: 20, value: profile.phone, hint: "e.g. 0300 1234567" }, "prof")}
         <button type="submit" class="btn btn--primary"><span>Save changes</span></button>
         <p class="fine" data-saved role="status"></p>
       </form>
     </section>
     <section class="account-section" aria-labelledby="orders-title">
       <h2 class="account-section__title" id="orders-title">Orders</h2>
       <p class="muted">See your orders, follow their progress, or cancel one that hasn't been confirmed yet.</p>
       <p><a class="btn btn--ghost" href="/account/orders">View my orders</a></p>
     </section>
     ${user.isStaff ? `<p><a class="btn btn--ghost" href="/admin">Open the store admin</a></p>` : ""}`,
    { narrow: true },
  );

  bindSignOut(outlet);
  const form = outlet.querySelector("[data-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await busy(form, () => session.saveProfile(/** @type {any} */ (formValues(form))), "Saving…");
    showResult(form, result);
    outlet.querySelector("[data-saved]").textContent = result.ok ? "Saved." : "";
  });
  outlet.querySelector("[data-resend]")?.addEventListener("click", async (e) => {
    const r = await session.resendVerification();
    /** @type {HTMLElement} */ (e.target).textContent = r.ok ? "Sent — check your inbox" : r.message;
  });
  outlet.querySelector("[data-verified]")?.addEventListener("click", async () => {
    await session.refreshUser();
    if (session.currentUser()?.emailVerified) outlet.querySelector("[data-verify]")?.remove();
    else outlet.querySelector("[data-verify] strong").textContent = "Not verified yet — open the link in your email, then try again.";
  });
}

/* ───────── Addresses ───────── */

export async function addressesView({ outlet }) {
  document.title = "Your addresses";
  const user = await requireUser();
  if (!user) return;

  const render = async (editing = null) => {
    const list = await session.listAddresses().catch(() => []);
    const current = editing ? list.find((a) => a.id === editing) : null;
    outlet.innerHTML = shell(
      "Account",
      "Delivery <em>addresses</em>",
      `${accountNav("addresses")}
       <section class="account-section" aria-labelledby="saved-title">
         <h2 class="account-section__title" id="saved-title">Saved addresses</h2>
         ${
           list.length
             ? `<ul class="address-list">${list
                 .map(
                   (a) => `<li class="address-card">
                     <p class="address-card__name">${esc(a.label || a.name)}${a.isDefault ? ` <span class="tag">Default</span>` : ""}</p>
                     <p>${esc(a.name)} · ${esc(a.phone)}</p>
                     <p>${esc(a.line1)}</p>
                     <p>${esc(a.area)}, ${esc(a.city)}</p>
                     <p class="address-card__actions">
                       <button type="button" class="text-btn" data-edit="${esc(a.id)}">Edit</button>
                       <button type="button" class="text-btn" data-delete="${esc(a.id)}">Delete</button>
                     </p>
                   </li>`,
                 )
                 .join("")}</ul>`
             : `<p class="muted">No saved addresses yet. Add one below to speed up checkout.</p>`
         }
       </section>
       <section class="account-section" aria-labelledby="addr-form-title">
         <h2 class="account-section__title" id="addr-form-title">${current ? "Edit address" : "Add an address"}</h2>
         <form class="auth-form" novalidate data-form>
           ${alertBox}
           ${field({ name: "label", label: "Label", required: false, maxlength: 40, hint: "e.g. Home, Office", value: current?.label }, "addr")}
           ${field({ name: "name", label: "Recipient name", autocomplete: "name", required: true, maxlength: 80, value: current?.name ?? user.name ?? "" }, "addr")}
           ${field({ name: "phone", label: "Mobile number", type: "tel", inputmode: "tel", autocomplete: "tel", required: true, maxlength: 20, value: current?.phone }, "addr")}
           ${field({ name: "city", label: "City", autocomplete: "address-level2", required: true, maxlength: 60, value: current?.city }, "addr")}
           ${field({ name: "area", label: "Area / locality", autocomplete: "address-level3", required: true, maxlength: 80, value: current?.area }, "addr")}
           ${field({ name: "line1", label: "Complete address", autocomplete: "street-address", required: true, maxlength: 300, textarea: true, hint: "House / flat, street, nearby landmark", value: current?.line1 }, "addr")}
           <label class="check"><input type="checkbox" name="isDefault" ${current?.isDefault || !list.length ? "checked" : ""} /> Use as my default address</label>
           <div class="form-actions">
             <button type="submit" class="btn btn--primary"><span>${current ? "Save address" : "Add address"}</span></button>
             ${current ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel</button>` : ""}
           </div>
         </form>
       </section>`,
    );
    outlet.querySelector("#addr-city")?.setAttribute("list", "city-suggestions");
    outlet.insertAdjacentHTML("beforeend", `<datalist id="city-suggestions">${CITY_SUGGESTIONS.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>`);
    bindSignOut(outlet);

    const form = outlet.querySelector("[data-form]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const result = await busy(form, () => session.saveAddress(/** @type {any} */ (formValues(form)), current?.id), "Saving…");
      showResult(form, result);
      if (result.ok) render();
    });
    outlet.querySelector("[data-cancel]")?.addEventListener("click", () => render());
    outlet.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => render(/** @type {HTMLElement} */ (b).dataset.edit)));
    outlet.querySelectorAll("[data-delete]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!window.confirm("Delete this address?")) return;
        await session.deleteAddress(/** @type {HTMLElement} */ (b).dataset.delete);
        render();
      }),
    );
  };
  await render();
}

/* ───────── Change password ───────── */

export async function passwordView({ outlet }) {
  document.title = "Change your password";
  const user = await requireUser();
  if (!user) return;
  outlet.innerHTML = shell(
    "Account",
    "Change <em>password</em>",
    `${accountNav("password")}
     <section class="account-section">
       <form class="auth-form" novalidate data-form>
         ${alertBox}
         ${field({ name: "currentPassword", label: "Current password", type: "password", autocomplete: "current-password", required: true, maxlength: 128 }, "pw")}
         ${field({ name: "newPassword", label: "New password", type: "password", autocomplete: "new-password", required: true, maxlength: 128, hint: `At least ${PASSWORD_MIN} characters, with letters and a number` }, "pw")}
         <button type="submit" class="btn btn--primary"><span>Change password</span></button>
         <p class="fine" data-saved role="status"></p>
       </form>
     </section>`,
  );
  bindSignOut(outlet);
  const form = outlet.querySelector("[data-form]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = await busy(form, () => session.changePassword(/** @type {any} */ (formValues(form))), "Changing…");
    showResult(form, result);
    if (result.ok) {
      form.reset();
      outlet.querySelector("[data-saved]").textContent = "Password changed.";
    }
  });
}
