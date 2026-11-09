/**
 * Admin overview. Shows only real, database-derived figures. Where data can't exist yet (orders,
 * revenue, stock), it says so plainly instead of showing zeros or sample charts.
 */
import { esc } from "../../lib/format.js";
import { statCard, emptyState, formatWhen } from "../ui/kit.js";
import { countCustomers, countActiveStaff, loadSettings, listActivity } from "../data.js";
import { describeActivity } from "./activity.js";

export default async function overview({ main, user }) {
  const can = (p) => user.perms.includes(p);
  const first = (user.name || user.email || "").split(/[\s@]/)[0];

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Hello, <em>${esc(first)}</em></h1>
        <p class="muted">Here's the store at a glance. Every figure on this page comes from the live database.</p>
      </header>

      <section aria-labelledby="ov-stats" class="adm-section">
        <h2 id="ov-stats" class="adm-h2">People</h2>
        <div class="adm-stats" data-stats><p class="muted">Loading…</p></div>
      </section>

      <section aria-labelledby="ov-sales" class="adm-section">
        <h2 id="ov-sales" class="adm-h2">Orders &amp; revenue</h2>
        ${emptyState({
          title: "No orders yet",
          text: "Online ordering opens in Phase 6. Order counts, revenue and sales over time will appear here — calculated only from real orders.",
        })}
      </section>

      <section aria-labelledby="ov-setup" class="adm-section">
        <h2 id="ov-setup" class="adm-h2">Store setup</h2>
        <ul class="adm-checklist" data-checklist><li class="muted">Checking…</li></ul>
      </section>

      ${
        can("audit.read")
          ? `<section aria-labelledby="ov-activity" class="adm-section">
              <h2 id="ov-activity" class="adm-h2">Recent activity</h2>
              <div data-activity><p class="muted">Loading…</p></div>
              <p><a class="text-link" href="/admin/activity" data-link>See the full activity log</a></p>
            </section>`
          : ""
      }
    </div>`;

  // People — only the figures this role is allowed to see.
  const stats = /** @type {HTMLElement} */ (main.querySelector("[data-stats]"));
  const figures = [
    can("customers.read") && { label: "Registered customers", load: countCustomers },
    can("staff.manage") && { label: "Active staff", load: countActiveStaff },
  ].filter(Boolean);
  if (!figures.length) stats.innerHTML = `<p class="muted">Your role doesn't include customer or staff figures.</p>`;
  else {
    const results = await Promise.allSettled(figures.map((f) => f.load()));
    stats.innerHTML = results
      .map((r, i) => statCard({ label: figures[i].label, value: r.status === "fulfilled" ? r.value : "—", note: r.status === "fulfilled" ? "" : "Couldn't load — refresh to try again" }))
      .join("");
  }

  // Setup checklist — each item is a real check, or explicitly marked as a later phase.
  let settingsKnown = true;
  const settings = await loadSettings().catch(() => {
    settingsKnown = false;
    return { public: null, private: null };
  });
  const items = [
    { done: true, text: "Owner account and staff roles are set up" },
    {
      done: Boolean(settings.public),
      text: settingsKnown ? "Store details saved (name, contact, address)" : "Store details — couldn't check right now",
      href: can("settings.manage") ? "/admin/settings" : "",
    },
    { done: false, text: "Add products, sizes, colours and stock", later: "Phase 5" },
    { done: false, text: "Set delivery methods and charges", later: "Phase 7" },
    { done: false, text: "Open online ordering (Cash on Delivery)", later: "Phase 6" },
  ];
  main.querySelector("[data-checklist]").innerHTML = items
    .map(
      (i) => `<li class="adm-check ${i.done ? "is-done" : ""}">
        <span class="adm-check__mark" aria-hidden="true">${i.done ? "✓" : ""}</span>
        <span>${esc(i.text)}${i.later ? ` <span class="tag">${esc(i.later)}</span>` : ""}
          ${!i.done && i.href ? ` — <a class="text-link" href="${i.href}" data-link>do it now</a>` : ""}</span>
        <span class="visually-hidden">${i.done ? "done" : "not done yet"}</span>
      </li>`,
    )
    .join("");

  // Recent activity
  const act = main.querySelector("[data-activity]");
  if (act) {
    try {
      const { items: logs } = await listActivity({ pageSize: 5 });
      act.innerHTML = logs.length
        ? `<ul class="adm-feed">${logs.map((l) => `<li><span>${esc(describeActivity(l))}</span><span class="muted">${esc(formatWhen(l.at))}</span></li>`).join("")}</ul>`
        : emptyState({ title: "No activity yet", text: "Staff actions such as role changes and settings updates are recorded here." });
    } catch {
      act.innerHTML = `<p class="muted">Activity couldn't be loaded.</p>`;
    }
  }
}
