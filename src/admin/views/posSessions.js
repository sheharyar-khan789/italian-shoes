/**
 * Register sessions: one page at a time from Firestore (rules allow only `pos.sessions.read`), newest first,
 * with each session's cash movements. Staff who manage staff can also create the Cashier / POS Manager roles.
 */
import { esc } from "../../lib/format.js";
import { dataTable, toast, errorState, formatWhen } from "../ui/kit.js";
import { money } from "../ui/purchasing.js";
import { call, pageOf } from "../purchData.js";
import { CASH_REASON_LABEL } from "../../../shared/pos.js";

const varianceText = (v) => (v === null || v === undefined ? "—" : v === 0 ? "Exact" : v < 0 ? `Shortage ${money(-v)}` : `Excess ${money(v)}`);
const when = (ts) => (ts?.toDate ? formatWhen(ts.toDate()) : "—");

export default async function posSessions({ main, user }) {
  const canRoles = user.perms.includes("staff.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Register <em>sessions</em></h1>
        <p class="muted">Every register opened at the counter: who, where, the cash expected and counted, and the difference.</p>
        ${canRoles ? `<p><button type="button" class="btn btn--ghost" data-roles>Create the Cashier and POS Manager roles</button> <span class="muted">Creates them only if they don't exist yet. Then assign them to staff in Staff &amp; Roles.</span></p>` : ""}
      </header>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const box = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;

  main.querySelector("[data-roles]")?.addEventListener("click", async () => {
    try {
      const r = await call("createPosRoles", {});
      toast(r.created.length ? `Created: ${r.created.join(", ")}` : "Both roles already exist; nothing was changed.");
    } catch (e) {
      toast(e?.message ?? "Couldn't create the roles.", "error");
    }
  });

  const table = dataTable({
    caption: "Register sessions",
    empty: { title: "No register sessions yet", text: "They appear here when a cashier opens a register." },
    columns: [
      { key: "number", label: "Register", render: (r) => `<strong>${esc(r.number)}</strong><br /><span class="muted">${esc(r.warehouseName ?? "")}</span>` },
      { key: "cashierName", label: "Cashier" },
      { key: "openedAt", label: "Opened", render: (r) => esc(when(r.openedAt)) },
      { key: "closedAt", label: "Closed", render: (r) => (r.status === "open" ? `<span class="tag">Open</span>` : esc(when(r.closedAt))) },
      { key: "salesTotal", label: "Sales", render: (r) => `${r.saleCount ?? 0} · ${esc(money(r.salesTotal ?? 0))}` },
      { key: "expectedCash", label: "Expected cash", render: (r) => esc(r.status === "closed" ? money(r.expectedCash) : "—") },
      { key: "countedCash", label: "Counted", render: (r) => esc(r.status === "closed" ? money(r.countedCash) : "—") },
      { key: "variance", label: "Difference", render: (r) => (r.status === "closed" ? `<span class="${r.variance < 0 ? "tag tag--out" : r.variance > 0 ? "tag tag--low" : "tag"}">${esc(varianceText(r.variance))}</span>` : "—") },
      { key: "actions", label: "", className: "adm-actions", render: (r) => `<button type="button" class="text-btn" data-moves="${esc(r.id)}">Cash movements</button>` },
    ],
  });
  let last = null;
  async function more(first) {
    try {
      const p = await pageOf("registerSessions", { orderBy: ["openedAt", "desc"], after: first ? null : last, size: 25 });
      if (!alive()) return;
      last = p.last;
      if (first) {
        box.innerHTML = "";
        box.append(table.el);
        table.set(p.rows, p.hasMore);
      } else table.append(p.rows, p.hasMore);
    } catch {
      if (alive()) {
        box.innerHTML = errorState();
        box.querySelector("[data-retry]")?.addEventListener("click", () => more(true));
      }
    }
  }
  table.onMore(() => more(false));
  box.addEventListener("click", async (e) => {
    const id = /** @type {HTMLElement} */ (e.target).closest("[data-moves]")?.getAttribute("data-moves");
    if (!id) return;
    try {
      const p = await pageOf("registerMovements", { where: [["sessionId", "==", id]], orderBy: ["at", "asc"], size: 100 });
      const d = document.createElement("dialog");
      d.className = "adm-dialog adm-dialog--wide";
      d.innerHTML = `<form method="dialog"><h2>Cash movements</h2><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>When</th><th>Type</th><th>Reason</th><th>Amount</th><th>By</th><th>Note</th></tr></thead><tbody>${p.rows
        .map((m) => `<tr><td>${esc(when(m.at))}</td><td>${esc(m.type.replace("_", " "))}</td><td>${esc(CASH_REASON_LABEL[m.reason] ?? m.reason ?? "")}</td><td>${esc(money(m.amount))}</td><td>${esc(m.staffName ?? "")}</td><td>${esc(m.note ?? "")}</td></tr>`)
        .join("")}</tbody></table></div><div class="adm-dialog__actions"><button class="btn btn--ghost" type="submit">Close</button></div></form>`;
      document.body.append(d);
      d.addEventListener("close", () => d.remove());
      d.showModal();
    } catch {
      toast("Couldn't load the movements.", "error");
    }
  });
  await more(true);
}
