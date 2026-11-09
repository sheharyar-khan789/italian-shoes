/**
 * Customers: who has an account, their contact details and orders. Passwords are held by Firebase
 * only and are never visible. Staff can suspend or re-enable an account.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { dataTable, toast, confirmDialog, errorState, formatWhen } from "../ui/kit.js";
import { call, listCustomers, customerOrders } from "../engageData.js";
import { fnResult } from "./catalogue.js";

export default async function customers({ main, user }) {
  const canManage = user.perms.includes("customers.manage");
  const canSeeOrders = user.perms.includes("orders.read");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Customers</h1>
        <p class="muted">People who created an account on the website. Select a name to see their details and orders.</p>
      </header>
      <form class="adm-filters adm-filters--one" role="search" data-search>
        <label class="visually-hidden" for="cu-q">Search by email</label>
        <input id="cu-q" type="search" placeholder="Search by email address (start of the address)" maxlength="100" autocomplete="off" />
      </form>
      <div class="adm-split"><div data-table></div><aside data-detail class="adm-card" hidden></aside></div>
    </div>`;

  let people = [];
  const table = dataTable({
    caption: "Customers",
    empty: { title: "No customers yet", text: "Accounts appear here as people sign up." },
    columns: [
      { key: "name", label: "Name", render: (c) => `<button type="button" class="text-btn" data-open="${esc(c.id)}">${esc(c.name ?? "—")}</button>${c.disabled ? ` <span class="tag">Suspended</span>` : ""}` },
      { key: "email", label: "Email", render: (c) => esc(c.email ?? "—") },
      { key: "phone", label: "Phone", render: (c) => esc(c.phone || "—"), className: "nowrap" },
      { key: "createdAt", label: "Joined", render: (c) => esc(formatWhen(c.createdAt)), className: "nowrap" },
    ],
  });
  main.querySelector("[data-table]").append(table.el);

  let last = null;
  let search = "";
  const load = async (more = false) => {
    try {
      const page = await listCustomers({ search, after: more ? last : undefined });
      last = page.last;
      people = more ? people.concat(page.items) : page.items;
      (more ? table.append : table.set)(page.items, page.hasMore);
    } catch {
      table.el.innerHTML = errorState();
      table.el.querySelector("[data-retry]")?.addEventListener("click", () => load(more));
    }
  };
  table.onMore(() => load(true));
  main.querySelector("[data-search]").addEventListener("submit", (e) => {
    e.preventDefault();
    search = /** @type {HTMLInputElement} */ (main.querySelector("#cu-q")).value;
    load();
  });

  const detail = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
  const open = async (id) => {
    const c = people.find((p) => p.id === id);
    if (!c) return;
    detail.hidden = false;
    detail.innerHTML = `
      <h2 class="adm-h2">${esc(c.name ?? "Customer")}</h2>
      <p>${esc(c.email ?? "")}<br>${esc(c.phone || "No phone saved")}</p>
      <p class="muted">Joined ${esc(formatWhen(c.createdAt))}</p>
      ${c.disabled ? `<p class="notice">This account is suspended.${c.disabledReason ? ` Reason: ${esc(c.disabledReason)}` : ""}</p>` : ""}
      ${canManage ? `<p><button type="button" class="btn btn--ghost" data-toggle>${c.disabled ? "Re-enable account" : "Suspend account"}</button></p>` : ""}
      ${canSeeOrders ? `<h3 class="adm-h3">Recent orders</h3><div data-orders><p class="muted">Loading…</p></div>` : ""}`;
    detail.querySelector("[data-toggle]")?.addEventListener("click", async () => {
      const disable = !c.disabled;
      if (disable && !(await confirmDialog({ title: "Suspend this account?", body: "They'll be signed out everywhere and can't sign in until you re-enable it.", confirm: "Suspend", danger: true }))) return;
      try {
        await call("setCustomerDisabled", { uid: c.id, disabled: disable, reason: disable ? "Suspended by staff" : "" });
        toast(disable ? "Account suspended." : "Account re-enabled.");
        c.disabled = disable;
        open(id);
        load();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    });
    if (canSeeOrders) {
      const slot = detail.querySelector("[data-orders]");
      try {
        const { items } = await customerOrders(id);
        slot.innerHTML = items.length
          ? `<ul class="adm-list">${items.map((o) => `<li><a href="/admin/orders/${esc(o.id)}">${esc(o.number)}</a> · ${esc(o.status)} · ${esc(formatPKR(o.grandTotal))}</li>`).join("")}</ul>`
          : `<p class="muted">No orders yet.</p>`;
      } catch {
        slot.innerHTML = `<p class="muted">Orders couldn't be loaded.</p>`;
      }
    }
  };
  main.addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-open]");
    if (b) open(/** @type {HTMLElement} */ (b).dataset.open);
  });
  await load();
}
