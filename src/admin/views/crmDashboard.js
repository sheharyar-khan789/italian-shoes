/** CRM dashboard: customer counts by group, sales through customers, loyalty points owed, top customers and recent activity. */
import { esc } from "../../lib/format.js";
import { statCard, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { messageOf, labelTables } from "../financeUi.js";

export default async function crmDashboard({ main, user }) {
  const canManage = user.perms.includes("crm.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Customer <em>dashboard</em></h1>
        <p class="muted">A summary of your registered customers and their real purchases.</p>
        ${canManage ? `<p><button type="button" class="btn btn--ghost" data-refresh>Recalculate all customers</button></p>` : ""}
      </header>
      <div data-out><p class="muted">Loading…</p></div>
    </div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;

  async function show() {
    try {
      const d = await call("crmDashboard", {});
      if (!alive()) return;
      out.innerHTML = `
        <div class="adm-stats">
          ${statCard({ label: "Customers", value: d.total, note: d.archived ? `${d.archived} archived` : "", href: "/admin/crm" })}
          ${statCard({ label: "New customers", value: d.newCustomers, note: "recently joined" })}
          ${statCard({ label: "Returning", value: d.returning })}
          ${statCard({ label: "VIP", value: d.vip })}
          ${statCard({ label: "High value", value: d.highValue })}
          ${statCard({ label: "Inactive", value: d.inactive })}
          ${statCard({ label: "Sales to customers", value: money(d.totalSales), note: `${d.orders} orders` })}
          ${statCard({ label: "Average order", value: money(d.averageOrder) })}
          ${d.loyaltyEnabled ? statCard({ label: "Loyalty points outstanding", value: d.loyaltyOutstanding === null ? "—" : d.loyaltyOutstanding, note: d.loyaltyValue === null ? "" : `worth ${money(d.loyaltyValue)}` }) : statCard({ label: "Loyalty programme", value: "Off", note: "Switch it on in Customer settings", href: "/admin/crm-settings" })}
          ${statCard({ label: "Open complaints", value: d.openComplaints })}
          ${statCard({ label: "Follow-ups due", value: d.followUpsDue })}
        </div>
        <p class="muted">${esc(d.statsNote)}</p>
        <h2 class="adm-h2">Top customers</h2>
        ${d.topCustomers.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Customer</th><th>Orders</th><th>Spent</th><th>Tier</th></tr></thead><tbody>${d.topCustomers.map((c) => `<tr><td><a class="text-link" href="/admin/crm/${esc(c.id)}" data-link>${esc(c.name)}</a> <span class="muted">${esc(c.reference ?? "")}</span></td><td>${c.orders}</td><td>${esc(money(c.spent))}</td><td>${esc(c.tier ?? "—")}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No customer sales yet", text: "Top customers appear here once sales are saved against customers." })}
        <h2 class="adm-h2">Recent activity</h2>
        ${d.recentActivity.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>What</th><th>Customer</th><th>Detail</th><th>When</th></tr></thead><tbody>${d.recentActivity.map((a) => `<tr><td>${esc(a.kind)}</td><td>${esc(a.customer ?? "—")}</td><td>${esc(a.text ?? "")}${a.points ? ` <span class="muted">(${a.points > 0 ? "+" : ""}${a.points} pts)</span>` : ""}</td><td>${esc(formatWhen(a.at))}</td></tr>`).join("")}</tbody></table></div>` : emptyState({ title: "No activity yet" })}`;
      labelTables(out);
    } catch (err) {
      if (!alive()) return;
      out.innerHTML = errorState(messageOf(err));
      out.querySelector("[data-retry]")?.addEventListener("click", show);
    }
  }
  main.querySelector("[data-refresh]")?.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
    btn.disabled = true;
    try {
      await call("refreshCrmStats", {});
    } catch (err) {
      out.insertAdjacentHTML("afterbegin", `<p class="form-alert" role="alert">${esc(messageOf(err))}</p>`);
    }
    btn.disabled = false;
    await show();
  });
  await show();
}
