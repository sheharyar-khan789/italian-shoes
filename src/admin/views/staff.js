/**
 * Staff & roles (Owner only). Give a person who already has an account a role, change it, or remove
 * their access. Changes take effect immediately (their sessions are refreshed by the server).
 */
import { esc } from "../../lib/format.js";
import { DEFAULT_ROLES, PERMISSIONS } from "../../../shared/permissions.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, emptyState } from "../ui/kit.js";
import { call, listStaff, listRoles } from "../engageData.js";
import { setStaffRolesSchema, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

export default async function staff({ main, user }) {
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading…</p></div>`;
  let people, roles;
  try {
    [people, roles] = await Promise.all([listStaff(), listRoles()]);
  } catch {
    main.innerHTML = `<div class="adm-page">${errorState()}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => staff({ main, user }));
    return;
  }
  const reload = () => staff({ main, user });
  const roleName = (k) => roles.find((r) => r.id === k)?.name ?? DEFAULT_ROLES[k]?.name ?? k;
  const active = people.filter((p) => p.status === "active");

  const roleBoxes = (selected = []) =>
    `<fieldset class="adm-roles"><legend>Roles</legend>${roles
      .map(
        (r) => `<label class="check"><input type="checkbox" name="roles" value="${esc(r.id)}" ${selected.includes(r.id) ? "checked" : ""} /> <span><strong>${esc(r.name ?? r.id)}</strong>
        <span class="muted">${esc((r.permissions ?? []).map((p) => PERMISSIONS[p] ?? p).join(", "))}</span></span></label>`,
      )
      .join("")}</fieldset>`;

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Staff <em>&amp; roles</em></h1>
        <p class="muted">Only people with a role can use this admin panel. They must already have an account on the website.</p>
      </header>
      ${
        active.length
          ? `<div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Staff</caption><thead><tr><th scope="col">Person</th><th scope="col">Roles</th><th scope="col"></th></tr></thead><tbody>${active
              .map(
                (p) => `<tr><td data-label="Person">${esc(p.name || p.email || p.id)}${p.id === user.uid ? ` <span class="tag">You</span>` : ""}<br><span class="muted">${esc(p.email ?? "")}</span></td>
              <td data-label="Roles">${esc((p.roles ?? []).map(roleName).join(", "))}</td>
              <td class="adm-actions"><button type="button" class="text-btn" data-edit="${esc(p.id)}">Change roles</button></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : emptyState({ title: "No staff yet", text: "Add the first person below." })
      }
      <section class="adm-section adm-card" data-slot>
        <h2 class="adm-h2">Add staff</h2>
        <form class="adm-form" novalidate data-staff-form>
          <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
          ${field({ name: "email", label: "Their account email", type: "email", required: true, maxlength: 254, autocomplete: "off" }, "st")}
          ${roleBoxes()}
          <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save</span></button></div>
        </form>
      </section>
    </div>`;

  async function save(form, who) {
    const fd = new FormData(form);
    const r = fd.getAll("roles").map(String);
    const parsed = setStaffRolesSchema.safeParse({ ...who, roles: r });
    if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
    if (!r.length && !(await confirmDialog({ title: "Remove all access?", body: "They won't be able to use the admin panel any more.", confirm: "Remove access", danger: true }))) return;
    const result = await busy(form, async () => {
      try {
        await call("setStaffRoles", parsed.data);
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast("Staff access updated.");
      reload();
    }
  }

  main.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    save(form, form.dataset.uid ? { uid: form.dataset.uid } : { email: new FormData(form).get("email") });
  });
  main.addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-edit]");
    if (!b) return;
    const p = active.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.edit);
    const slot = main.querySelector("[data-slot]");
    slot.innerHTML = `<h2 class="adm-h2">Roles for ${esc(p.name || p.email || p.id)}</h2>
      <form class="adm-form" novalidate data-staff-form data-uid="${esc(p.id)}"><p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
      ${roleBoxes(p.roles)}<div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save roles</span></button></div></form>`;
    slot.scrollIntoView({ block: "center" });
  });
}
