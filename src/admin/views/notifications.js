/** Notifications for the permissions this person holds, live, with "mark as read". */
import { esc } from "../../lib/format.js";
import { emptyState, errorState, formatWhen, toast } from "../ui/kit.js";
import { watchNotifications, markRead } from "../data.js";

export default async function notifications({ main, user }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head adm-page__head--row">
        <div>
          <h1 class="adm-h1">Notifications</h1>
          <p class="muted">New orders, stock alerts, staff and settings changes — whatever your role covers.</p>
        </div>
        <button type="button" class="btn btn--ghost" data-read-all hidden>Mark all as read</button>
      </header>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const list = main.querySelector("[data-list]");
  const readAll = /** @type {HTMLButtonElement} */ (main.querySelector("[data-read-all]"));
  let current = [];

  const draw = () => {
    const unread = current.filter((n) => !n.readBy?.includes(user.uid));
    readAll.hidden = unread.length === 0;
    list.innerHTML = current.length
      ? `<ul class="adm-notes">${current
          .map((n) => {
            const isUnread = !n.readBy?.includes(user.uid);
            return `<li class="adm-note ${isUnread ? "is-unread" : ""}">
              <div>
                <p class="adm-note__title">${isUnread ? `<span class="visually-hidden">Unread: </span>` : ""}${esc(n.title)}</p>
                ${n.body ? `<p class="muted">${esc(n.body)}</p>` : ""}
                <p class="adm-note__meta">${esc(formatWhen(n.createdAt))}${n.link?.startsWith("/admin") ? ` · <a class="text-link" href="${esc(n.link)}" data-link>Open</a>` : ""}</p>
              </div>
              ${isUnread ? `<button type="button" class="text-btn" data-read="${esc(n.id)}">Mark as read</button>` : ""}
            </li>`;
          })
          .join("")}</ul>`
      : emptyState({ title: "No notifications", text: "You'll see new orders, stock alerts and important changes here." });
  };

  list.addEventListener("click", async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-read]");
    if (!btn) return;
    try {
      await markRead(/** @type {HTMLElement} */ (btn).dataset.read, user.uid);
    } catch {
      toast("Couldn't update that notification.", "error");
    }
  });
  readAll.addEventListener("click", async () => {
    const unread = current.filter((n) => !n.readBy?.includes(user.uid));
    const results = await Promise.allSettled(unread.map((n) => markRead(n.id, user.uid)));
    if (results.some((r) => r.status === "rejected")) toast("Some notifications couldn't be updated.", "error");
  });

  const unwatch = await watchNotifications(
    user.perms,
    (items) => {
      current = items;
      draw();
    },
    () => {
      list.innerHTML = errorState();
      list.querySelector("[data-retry]")?.addEventListener("click", () => notifications({ main, user }));
    },
  );
  return unwatch;
}
