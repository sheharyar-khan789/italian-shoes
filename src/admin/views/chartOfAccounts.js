/**
 * Chart of accounts: the accounts as a tree, with add / rename / switch on-off / delete (an account that has ever
 * been posted to can only be switched off), and the "posting accounts" — which account each automatic job uses.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState } from "../ui/kit.js";
import { formDialog, row, input, select } from "../ui/purchasing.js";
import { call, pageOf } from "../purchData.js";
import { saveAccountInput, fieldErrors } from "../../../shared/schemas/index.js";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, ROLES, normalBalanceOf } from "../../../shared/accounting.js";

export default async function chartOfAccounts({ main, user }) {
  const canManage = user.perms.includes("accounting.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Chart of <em>accounts</em></h1>
        <p class="muted">Codes are unique and can't change. Headings group accounts; only accounts take postings. An account that has been posted to can be switched off but never deleted.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>Add an account</span></button> <a class="btn btn--ghost" href="/admin/opening-balances" data-link>Opening balances</a></p>` : ""}
      </header>
      <div data-list><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Posting accounts</h2>
      <p class="muted">Which account each automatic posting uses. Change one if, for example, your bank account is a different account.</p>
      <div data-roles></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const rolesEl = /** @type {HTMLElement} */ (main.querySelector("[data-roles]"));
  /** @type {any[]} */
  let accounts = [];
  let roles = {};

  async function load() {
    try {
      const [page, cfg] = await Promise.all([pageOf("accounts", { orderBy: ["code", "asc"], size: 300 }), call("accountingOverview", {}).then(() => null).catch((e) => (/set up/i.test(e.message) ? "off" : null))]);
      if (!alive()) return;
      if (cfg === "off") {
        listEl.innerHTML = `<p>Accounting isn't set up yet. <a class="text-link" href="/admin/accounting" data-link>Create the chart of accounts</a>.</p>`;
        return;
      }
      accounts = page.rows;
      const { getRow } = await import("../purchData.js");
      roles = (await getRow("accountingConfig", "main"))?.roles ?? {};
      draw();
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }

  const depth = (a) => (a.parentCode ? 1 + depth(accounts.find((x) => x.code === a.parentCode) ?? { parentCode: null }) : 0);
  function draw() {
    listEl.innerHTML = ACCOUNT_TYPES.map((t) => {
      const rows = accounts.filter((a) => a.type === t);
      return `<h3 class="adm-h3">${esc(ACCOUNT_TYPE_LABEL[t])}</h3><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Code</th><th>Name</th><th>Normal balance</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((a) => `<tr><td><code>${esc(a.code)}</code></td><td style="padding-left:${depth(a) * 18 + 8}px">${a.isGroup ? `<strong>${esc(a.name)}</strong>` : esc(a.name)}${a.contra ? ` <span class="tag">contra</span>` : ""}${a.description ? `<br /><span class="muted">${esc(a.description)}</span>` : ""}</td><td>${a.isGroup ? "—" : esc(normalBalanceOf(a.type, a.contra))}</td><td>${a.isActive === false ? `<span class="tag tag--out">Off</span>` : `<span class="tag">On</span>`}</td>
        <td class="adm-actions">${canManage ? `<button type="button" class="text-btn" data-edit="${esc(a.code)}">Edit</button> ${a.isGroup ? "" : `<button type="button" class="text-btn" data-toggle="${esc(a.code)}">${a.isActive === false ? "Switch on" : "Switch off"}</button> `}<button type="button" class="text-btn" data-delete="${esc(a.code)}">Delete</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }).join("");
    rolesEl.innerHTML = `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Job</th><th>Account</th></tr></thead><tbody>${Object.entries(ROLES)
      .map(([role, spec]) => {
        const options = accounts.filter((a) => a.type === spec.type && Boolean(a.contra) === Boolean(spec.contra) && !a.isGroup && a.isActive !== false);
        return `<tr><td>${esc(spec.label)}</td><td>${canManage ? `<select data-role="${esc(role)}" aria-label="${esc(spec.label)}">${options.map((a) => `<option value="${esc(a.code)}" ${a.code === roles[role] ? "selected" : ""}>${esc(a.code)} · ${esc(a.name)}</option>`).join("")}</select>` : esc(roles[role] ?? "—")}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  }

  function accountDialog(existing) {
    const v = existing ?? { code: "", name: "", type: "asset", parentCode: "", isGroup: false, contra: false, description: "" };
    const groups = accounts.filter((a) => a.isGroup);
    formDialog({
      title: existing ? `Edit ${esc(existing.code)}` : "Add an account",
      submit: existing ? "Save" : "Add account",
      body: `${row("code", "Code (3–6 digits)", input("code", `value="${esc(v.code)}" inputmode="numeric" maxlength="6" ${existing ? "disabled" : ""}`))}
        ${row("name", "Name", input("name", `value="${esc(v.name)}" maxlength="80"`))}
        ${row("type", "Type", select("type", ACCOUNT_TYPES.map((t) => [t, ACCOUNT_TYPE_LABEL[t]]), v.type, existing ? "disabled" : ""))}
        ${row("parentCode", "Inside heading (optional)", select("parentCode", [["", "— Top level —"], ...groups.map((g) => [g.code, `${g.code} · ${g.name}`])], v.parentCode ?? ""))}
        ${existing ? "" : `<label class="check"><input type="checkbox" name="isGroup" /> This is a heading that groups other accounts</label><label class="check"><input type="checkbox" name="contra" /> Contra account (reduces its type, e.g. discounts)</label>`}
        ${row("description", "Note (optional)", input("description", `value="${esc(v.description ?? "")}" maxlength="200"`))}`,
      async onSubmit(form, { show, close }) {
        const f = /** @type {any} */ (form.elements);
        const parsed = saveAccountInput.safeParse({ code: existing ? existing.code : f.code.value, name: f.name.value, type: existing ? existing.type : f.type.value, parentCode: f.parentCode.value || null, isGroup: existing ? Boolean(existing.isGroup) : f.isGroup.checked, contra: existing ? Boolean(existing.contra) : f.contra.checked, description: f.description.value });
        if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
        await call("saveAccount", parsed.data);
        close();
        toast(existing ? "Saved." : "Account added.");
        load();
      },
    });
  }

  main.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("[data-new]")) return accountDialog(null);
    const pick = (a) => accounts.find((x) => x.code === t.closest(`[${a}]`)?.getAttribute(a));
    const edit = t.closest("[data-edit]") && pick("data-edit");
    if (edit) return accountDialog(edit);
    const tog = t.closest("[data-toggle]") && pick("data-toggle");
    if (tog) {
      try {
        await call("setAccountActive", { code: tog.code, isActive: tog.isActive === false });
        toast("Updated.");
        load();
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
      return;
    }
    const del = t.closest("[data-delete]") && pick("data-delete");
    if (del && (await confirmDialog({ title: `Delete ${del.code} ${del.name}?`, body: "Only accounts that have never been posted to can be deleted.", confirm: "Delete", danger: true }))) {
      try {
        await call("deleteAccount", { code: del.code });
        toast("Deleted.");
        load();
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
    }
  });
  main.addEventListener("change", async (e) => {
    const s = /** @type {HTMLSelectElement} */ (e.target).closest("[data-role]");
    if (!s) return;
    try {
      await call("setAccountRole", { role: /** @type {HTMLElement} */ (s).dataset.role, code: /** @type {HTMLSelectElement} */ (s).value });
      toast("Posting account updated.");
      load();
    } catch (error) {
      toast(/** @type {Error} */ (error).message, "error");
      load();
    }
  });
  await load();
}
