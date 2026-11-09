/** Activity log: who changed what, newest first, 25 at a time. Owner only (audit.read). */
import { esc } from "../../lib/format.js";
import { dataTable, formatWhen, errorState } from "../ui/kit.js";
import { listActivity, staffDirectory } from "../data.js";

const ACTIONS = {
  "staff.roles_set": (l) => {
    const after = l.changes?.after ?? [];
    return after.length ? `Staff roles set to: ${after.join(", ")}` : "Staff access removed";
  },
  "settings.updated": (l) => {
    const n = Object.keys(l.changes?.public ?? {}).length + Object.keys(l.changes?.private ?? {}).length;
    return `Store settings updated (${n} field${n === 1 ? "" : "s"})`;
  },
};

const WORDS = { created: "added", updated: "changed", deleted: "deleted", moderated: "moderated", suspended: "suspended", enabled: "re-enabled", status: "status changed" };

/** Plain-language description of one log entry. */
export const describeActivity = (l) => {
  if (ACTIONS[l.action]) return ACTIONS[l.action](l);
  const [what, verb] = String(l.action).split(".");
  return verb ? `${what.replace(/_/g, " ")} ${WORDS[verb] ?? verb.replace(/_/g, " ")}` : l.action;
};

export default async function activity({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Activity <em>log</em></h1>
        <p class="muted">Sensitive staff actions, recorded automatically. Entries can't be edited or deleted.</p>
      </header>
      <div data-table></div>
    </div>`;

  let names = {};
  const table = dataTable({
    caption: "Activity log",
    empty: { title: "No activity yet", text: "Role changes and settings updates will be listed here." },
    columns: [
      { key: "at", label: "When", render: (l) => esc(formatWhen(l.at)), className: "nowrap" },
      { key: "actor", label: "Who", render: (l) => esc(l.actorUid === "system" ? "System" : names[l.actorUid] ?? "Staff member") },
      { key: "what", label: "What", render: (l) => esc(describeActivity(l)) },
      { key: "entity", label: "Affected", render: (l) => esc(l.entityType === "staff" ? names[l.entityId] ?? "Staff member" : l.entityType) },
    ],
  });
  main.querySelector("[data-table]").append(table.el);

  let last = null;
  const load = async (more = false) => {
    try {
      const page = await listActivity({ after: more ? last : undefined });
      last = page.last;
      (more ? table.append : table.set)(page.items, page.hasMore);
    } catch {
      table.el.innerHTML = errorState();
      table.el.querySelector("[data-retry]")?.addEventListener("click", () => load(more));
    }
  };
  table.onMore(() => load(true));
  names = await staffDirectory().catch(() => ({}));
  await load();
}
