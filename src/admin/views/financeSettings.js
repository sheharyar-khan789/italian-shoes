/** Finance settings (finance.manage): income and expense categories, the approval limit, and recurring expenses. */
import { esc } from "../../lib/format.js";
import { METHOD_LABEL, FINANCE_METHODS } from "../../../shared/finance.js";
import { toast, errorState } from "../ui/kit.js";
import { formDialog, row, input, select } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { todayKey, money, toPaisa, messageOf, labelTables } from "../financeUi.js";

export default async function financeSettings({ main, user }) {
  const canManage = user.perms.includes("finance.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Finance <em>settings</em></h1>
        <p class="muted">Categories decide which account an entry posts to (by default Operating Expenses, Salaries or Other Income in your chart of accounts) and drive the category reports. ${canManage ? "" : "Only people who manage finance can change these."}</p></header>
      <div data-body><p class="muted">Loading…</p></div>
    </div>`;
  const body = /** @type {HTMLElement} */ (main.querySelector("[data-body]"));
  const alive = () => main.isConnected && main.querySelector("[data-body]") !== null;

  async function load() {
    try {
      const [c, s, r, a] = await Promise.all([call("listFinanceCategories", {}), call("getFinanceSettings", {}), call("listRecurring", {}), call("listMoneyAccounts", {})]);
      if (!alive()) return;
      const catTable = (kind) => {
        const list = c.categories.filter((x) => x.kind === kind);
        return `<h2 class="adm-h2">${kind === "income" ? "Income" : "Expense"} categories</h2>${canManage ? `<p><button type="button" class="btn btn--ghost" data-newcat="${kind}">Add category</button> <button type="button" class="btn btn--ghost" data-suggest="${kind}">Add suggested categories</button></p>` : ""}${
          list.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Posts to</th><th>Status</th><th></th></tr></thead><tbody>${list.map((x) => `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(x.accountCode ? `Account ${x.accountCode}` : x.role === "salaries" ? "Salaries account" : x.role === "other_income" ? "Other income account" : "Operating expenses account")}</td><td>${x.isActive === false ? `<span class="tag tag--out">Off</span>` : `<span class="tag">On</span>`}</td><td class="adm-actions">${canManage ? `<button type="button" class="text-btn" data-editcat="${esc(x.id)}">Edit</button> <button type="button" class="text-btn" data-togglecat="${esc(x.id)}" data-on="${x.isActive === false ? "1" : "0"}">${x.isActive === false ? "Switch on" : "Switch off"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">None yet.</p>`
        }`;
      };
      body.innerHTML = `
        ${catTable("expense")}${catTable("income")}
        <h2 class="adm-h2">Expense approval</h2>
        <p class="muted">Expenses at or above this amount, entered by someone who cannot approve, wait for another person to approve them before they are posted. 0 = no approval needed.</p>
        <p>Current limit: <strong>${s.approvalThreshold ? esc(money(s.approvalThreshold)) : "none"}</strong> ${canManage ? `<button type="button" class="btn btn--ghost" data-limit>Change</button>` : ""}</p>
        <h2 class="adm-h2">Recurring expenses</h2>
        <p class="muted">Nothing runs in the background: press “Create due expenses” to post the ones that have fallen due (each date is created once).</p>
        ${canManage ? `<p><button type="button" class="btn btn--ghost" data-newrec>Add recurring expense</button> <button type="button" class="btn btn--primary" data-run>Create due expenses</button></p>` : ""}
        ${r.recurring.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Expense</th><th>Amount</th><th>Repeats</th><th>Next date</th><th>Status</th><th></th></tr></thead><tbody>${r.recurring.map((x) => `<tr><td><strong>${esc(x.title)}</strong>${x.vendorName ? `<br /><span class="muted">${esc(x.vendorName)}</span>` : ""}</td><td>${esc(money(x.amount))}</td><td>${esc(x.frequency)}</td><td>${esc(x.nextDate)}</td><td>${x.isActive ? `<span class="tag">On</span>` : `<span class="tag tag--out">Off</span>`}</td><td class="adm-actions">${canManage ? `<button type="button" class="text-btn" data-togglerec="${esc(x.id)}" data-on="${x.isActive ? "0" : "1"}">${x.isActive ? "Switch off" : "Switch on"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No recurring expenses.</p>`}`;
      labelTables(body);
      wire(c.categories, a.accounts, s);
    } catch (e) {
      if (alive()) {
        body.innerHTML = errorState(messageOf(e));
        body.querySelector("[data-retry]")?.addEventListener("click", load);
      }
    }
  }

  function wire(categories, accounts, settings) {
    const act = (fn) => async (e) => {
      try {
        await fn(e);
      } catch (err) {
        toast(messageOf(err), "error");
      }
    };
    body.querySelectorAll("[data-suggest]").forEach((b) => b.addEventListener("click", act(async () => {
      const r = await call("addSuggestedCategories", { kind: /** @type {HTMLElement} */ (b).dataset.suggest });
      toast(r.created.length ? `Added: ${r.created.join(", ")}` : "They already exist.");
      load();
    })));
    const catDialog = (kind, existing = null) =>
      formDialog({
        title: existing ? "Edit category" : `Add ${kind} category`,
        intro: "Leave the account empty to use the default account for this kind of category.",
        body: row("name", "Name", input("name", `maxlength="60" value="${esc(existing?.name ?? "")}"`)) + row("accountCode", "Post to a specific account (optional)", input("accountCode", `inputmode="numeric" placeholder="e.g. 6010" value="${esc(existing?.accountCode ?? "")}"`)),
        submit: "Save",
        onSubmit: async (form, { show, close }) => {
          const f = new FormData(form);
          const name = String(f.get("name") ?? "").trim();
          if (name.length < 2) return show("Enter a name.", { name: "Required" });
          await call("saveFinanceCategory", { ...(existing ? { id: existing.id } : {}), kind, name, accountCode: String(f.get("accountCode") ?? "").trim() || null });
          close();
          toast("Saved");
          load();
        },
      });
    body.querySelectorAll("[data-newcat]").forEach((b) => b.addEventListener("click", () => catDialog(/** @type {HTMLElement} */ (b).dataset.newcat)));
    body.querySelectorAll("[data-editcat]").forEach((b) => b.addEventListener("click", () => { const c = categories.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.editcat); catDialog(c.kind, c); }));
    body.querySelectorAll("[data-togglecat]").forEach((b) => b.addEventListener("click", act(async () => {
      await call("setFinanceCategoryActive", { id: /** @type {HTMLElement} */ (b).dataset.togglecat, isActive: /** @type {HTMLElement} */ (b).dataset.on === "1" });
      load();
    })));
    body.querySelector("[data-limit]")?.addEventListener("click", () =>
      formDialog({
        title: "Approval limit",
        body: row("limit", "Approval needed from (Rs.) — 0 for never", input("limit", `inputmode="decimal" value="${settings.approvalThreshold / 100}"`)),
        submit: "Save",
        onSubmit: async (form, { show, close }) => {
          const v = toPaisa(new FormData(form).get("limit"));
          if (v === null) return show("Enter an amount.", { limit: "Required" });
          await call("saveFinanceSettings", { approvalThreshold: v });
          close();
          toast("Saved");
          load();
        },
      }),
    );
    body.querySelector("[data-run]")?.addEventListener("click", act(async () => {
      const r = await call("runRecurring", {});
      toast(r.failed.length ? `${r.created.length} created, ${r.failed.length} failed: ${r.failed[0].message}` : r.created.length ? `${r.created.length} expense(s) created` : "Nothing is due.", r.failed.length ? "error" : "ok");
      load();
    }));
    body.querySelectorAll("[data-togglerec]").forEach((b) => b.addEventListener("click", act(async () => {
      await call("setRecurringActive", { id: /** @type {HTMLElement} */ (b).dataset.togglerec, isActive: /** @type {HTMLElement} */ (b).dataset.on === "1" });
      load();
    })));
    body.querySelector("[data-newrec]")?.addEventListener("click", () => {
      const cats = categories.filter((c) => c.kind === "expense" && c.isActive !== false).map((c) => [c.id, c.name]);
      if (!cats.length) return toast("Add an expense category first.", "error");
      formDialog({
        title: "Add recurring expense",
        wide: true,
        body: row("title", "Title", input("title", 'maxlength="120"')) + row("amount", "Amount (Rs.)", input("amount", 'inputmode="decimal"')) + row("categoryId", "Category", select("categoryId", cats)) + row("method", "Payment method", select("method", FINANCE_METHODS.map((m) => [m, METHOD_LABEL[m]]))) + row("frequency", "Repeats", select("frequency", [["monthly", "Every month"], ["weekly", "Every week"]])) + row("startDate", "First date", input("startDate", `type="date" value="${todayKey()}"`)) + row("vendorName", "Vendor (optional)", input("vendorName", 'maxlength="120"')),
        submit: "Save",
        onSubmit: async (form, { show, close }) => {
          const f = new FormData(form);
          const amount = toPaisa(f.get("amount"));
          if (!amount) return show("Enter the amount.", { amount: "Required" });
          await call("saveRecurring", { title: String(f.get("title")).trim(), amount, categoryId: String(f.get("categoryId")), method: String(f.get("method")), frequency: String(f.get("frequency")), startDate: String(f.get("startDate")), vendorName: String(f.get("vendorName") ?? "").trim(), isActive: true });
          close();
          toast("Saved");
          load();
        },
      });
    });
    void accounts;
  }
  await load();
}
