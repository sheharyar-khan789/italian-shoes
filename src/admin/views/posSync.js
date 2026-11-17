/**
 * Offline sync dashboard. Shows this computer's queue of offline sales (kept in the browser until the server accepts
 * them) with pending / syncing / synced / held / failed status, the last sync time and the server's exact reason for
 * anything it refused. Held sales can be retried, accepted at the server's price (managers) or discarded (managers).
 * Managers also see the server's own record of every offline sale from every till.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { statCard, toast, errorState, formatWhen } from "../ui/kit.js";
import { formDialog, row, input } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { offlineRuntime } from "../offline.js";

const rs = (p) => formatPKR(p ?? 0);
const LABEL = { pending: ["Waiting to send", "tag tag--low"], syncing: ["Sending…", "tag tag--low"], synced: ["Synced", "tag"], conflict: ["Needs attention", "tag tag--out"], failed: ["Failed", "tag tag--out"], discarded: ["Discarded", "tag"] };
const CONFLICT = { stock: "Not enough stock on the server", price_changed: "Price changed while offline", register: "Register closed or unavailable", unavailable: "Product no longer for sale" };
const tag = (s) => `<span class="${LABEL[s]?.[1] ?? "tag"}">${esc(LABEL[s]?.[0] ?? s)}</span>`;
const when = (t) => (t ? formatWhen(new Date(t)) : "—");

export default async function posSync({ main, user }) {
  const can = (p) => user.perms.includes(p);
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Offline <em>sync</em></h1>
        <p class="muted">Sales made while the internet was down are kept on this computer and sent automatically when it returns. A sale stays here until the server has accepted it. Prices, discounts and stock are always checked again by the server.</p>
      </header>
      <div data-body><p class="muted">Loading…</p></div>
      ${can("pos.sessions.read") ? `<h2 class="adm-h2">Server record (all tills)</h2><div class="adm-filters"><div class="field"><label for="sy-status">Show</label><select id="sy-status"><option value="">Everything</option><option value="conflict">Needs attention</option><option value="failed">Failed</option><option value="synced">Synced</option><option value="discarded">Discarded</option></select></div></div><div data-server><p class="muted">Loading…</p></div>` : ""}
    </div>`;
  const body = /** @type {HTMLElement} */ (main.querySelector("[data-body]"));
  const alive = () => main.isConnected && main.querySelector("[data-body]") !== null;
  const rt = await offlineRuntime(user);
  if (!rt) {
    body.innerHTML = errorState("This browser can't keep offline sales (storage is blocked). Offline selling is unavailable here.");
    return;
  }
  const { engine } = rt;

  async function draw() {
    if (!alive()) return;
    const [c, items] = await Promise.all([engine.counts(), engine.list()]);
    const mine = items.filter((q) => q.uid === user.uid).reverse();
    body.innerHTML = `
      <div class="adm-stats">
        ${statCard({ label: "Waiting to send", value: String(c.pending + c.syncing) })}
        ${statCard({ label: "Synced", value: String(c.synced), note: "kept here for 7 days" })}
        ${statCard({ label: "Needs attention", value: String(c.conflict + c.failed), note: `${c.conflict} held · ${c.failed} failed` })}
        ${statCard({ label: "Last sync", value: c.lastSyncAt ? when(c.lastSyncAt) : "Never", note: rt.isOffline() ? "Offline now" : "Connected" })}
      </div>
      <p><button type="button" class="btn btn--primary" data-send ${rt.isOffline() ? "disabled" : ""}><span>Send now</span></button> <span class="muted">${rt.isOffline() ? "You're offline. Sending resumes automatically." : "Waiting sales are also sent automatically."}</span></p>
      ${
        mine.length
          ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Sale</th><th>Made</th><th>Total</th><th>Status</th><th>Tries</th><th>What happened</th><th></th></tr></thead><tbody>${mine
              .map(
                (q) => `<tr>
          <td><strong>${esc(q.result?.number ?? q.localRef ?? q.offlineId.slice(-8))}</strong><br /><span class="muted">${esc(q.payload.sale.items.reduce((n, l) => n + l.qty, 0))} pair(s)</span></td>
          <td>${esc(when(q.payload.recordedAt))}</td><td>${esc(rs(q.payload.expectedTotal))}</td><td>${tag(q.status)}</td><td>${q.attempts}</td>
          <td>${esc(q.warning ?? q.lastError ?? (q.status === "pending" && q.nextAttemptAt > Date.now() ? `Next try ${when(q.nextAttemptAt)}` : ""))}${q.conflict ? `<br /><span class="muted">${esc(CONFLICT[q.conflict] ?? q.conflict)}</span>` : ""}</td>
          <td class="adm-actions"><button type="button" class="text-btn" data-details="${esc(q.offlineId)}">Details</button>${["conflict", "failed"].includes(q.status) ? ` <button type="button" class="text-btn" data-retry="${esc(q.offlineId)}">Retry</button>` : ""}${q.status === "conflict" && q.conflict === "price_changed" && can("pos.override") ? ` <button type="button" class="text-btn" data-accept="${esc(q.offlineId)}">Accept server price</button>` : ""}${["conflict", "failed"].includes(q.status) && can("pos.override") ? ` <button type="button" class="text-btn" data-discard="${esc(q.offlineId)}">Discard</button>` : ""}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : `<p class="muted">No offline sales on this computer.</p>`
      }`;
    body.querySelector("[data-send]")?.addEventListener("click", async (e) => {
      /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
      const r = await engine.syncOnce({ force: true }).catch(() => null);
      toast(!r ? "Couldn't send. Will retry." : r.skipped ? "A sync is already running." : `${r.synced} sent, ${r.held} held, ${r.failed} failed${r.offline ? " — connection lost" : ""}`);
      draw();
      loadServer();
    });
    const find = (id) => items.find((q) => q.offlineId === id);
    body.querySelectorAll("[data-details]").forEach((b) => b.addEventListener("click", () => details(find(/** @type {HTMLElement} */ (b).dataset.details))));
    body.querySelectorAll("[data-retry]").forEach((b) =>
      b.addEventListener("click", async () => {
        await engine.retry(/** @type {HTMLElement} */ (b).dataset.retry).catch((err) => toast(err.message, "error"));
        draw();
      }),
    );
    body.querySelectorAll("[data-accept]").forEach((b) =>
      b.addEventListener("click", () => {
        const q = find(/** @type {HTMLElement} */ (b).dataset.accept);
        formDialog({
          title: "Accept the server's price",
          intro: `The till rang this up at ${esc(rs(q.details?.offlineTotal))}; the server's price is now ${esc(rs(q.details?.serverTotal))}. The sale is recorded at the server's price. This is only possible when the cash taken covers it, and it is written to the audit log.`,
          submit: "Accept and record sale",
          body: "",
          onSubmit: async (_f, { close }) => {
            const r = await engine.acceptServerPrice(q.offlineId);
            close();
            toast(r?.synced ? "Sale recorded at the server's price" : "The server still can't accept it. See the details.", r?.synced ? "ok" : "error");
            draw();
          },
        });
      }),
    );
    body.querySelectorAll("[data-discard]").forEach((b) =>
      b.addEventListener("click", () => {
        const q = find(/** @type {HTMLElement} */ (b).dataset.discard);
        formDialog({
          title: "Discard this offline sale",
          intro: "It will never be recorded as a sale. Use this only when the sale did not really go ahead (for example the goods were taken back and the cash returned). The reason is kept in the audit log.",
          submit: "Discard sale",
          body: row("reason", "Reason", input("reason", 'maxlength="200"')),
          onSubmit: async (form, { show, close }) => {
            const reason = String(new FormData(form).get("reason") ?? "").trim();
            if (reason.length < 3) return show("Give a reason.", { reason: "Required" });
            await engine.discard(q.offlineId, reason);
            close();
            toast("Discarded");
            draw();
            loadServer();
          },
        });
      }),
    );
  }

  function details(q) {
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide";
    const det = q.details ?? {};
    d.innerHTML = `<form method="dialog"><h2>${esc(q.result?.number ?? q.localRef ?? "Offline sale")}</h2>
      <dl class="pos-details">
        <dt>Status</dt><dd>${tag(q.status)}</dd>
        <dt>Offline id</dt><dd><code>${esc(q.offlineId)}</code></dd>
        <dt>Made at</dt><dd>${esc(when(q.payload.recordedAt))}</dd>
        <dt>Total on the till</dt><dd>${esc(rs(q.payload.expectedTotal))}</dd>
        <dt>Attempts</dt><dd>${q.attempts}${q.serverErrors ? ` (${q.serverErrors} server errors)` : ""}</dd>
        ${q.result ? `<dt>Server sale</dt><dd>${esc(q.result.number)} · ${esc(rs(q.result.total))}</dd>` : ""}
        ${q.conflict ? `<dt>Reason</dt><dd>${esc(CONFLICT[q.conflict] ?? q.conflict)}</dd>` : ""}
        ${q.lastError ? `<dt>Server message</dt><dd>${esc(q.lastError)}</dd>` : ""}
        ${det.available !== undefined ? `<dt>Stock on the server</dt><dd>${det.available}</dd>` : ""}
        ${det.serverTotal !== undefined ? `<dt>Server total</dt><dd>${esc(rs(det.serverTotal))} (till: ${esc(rs(det.offlineTotal))})</dd>` : ""}
        ${q.warning ? `<dt>Note</dt><dd>${esc(q.warning)}</dd>` : ""}
        <dt>Items</dt><dd>${q.payload.sale.items.map((l) => `${l.qty} × ${esc(l.productId.slice(0, 8))}…/${esc(l.variantId)}`).join("<br />")}</dd>
      </dl>
      <div class="adm-dialog__actions"><button class="btn btn--ghost" type="submit">Close</button></div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }

  async function loadServer() {
    const box = /** @type {HTMLElement | null} */ (main.querySelector("[data-server]"));
    if (!box) return;
    const status = /** @type {HTMLSelectElement} */ (main.querySelector("#sy-status")).value;
    try {
      const r = await call("posSyncList", status ? { status } : {});
      if (!alive()) return;
      box.innerHTML = r.entries.length
        ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Sale</th><th>Cashier</th><th>Made</th><th>Total</th><th>Status</th><th>Tries</th><th>Message</th></tr></thead><tbody>${r.entries
            .map((e) => `<tr><td><strong>${esc(e.number ?? e.offlineId.slice(-8))}</strong></td><td>${esc(e.cashierName ?? "")}</td><td>${esc(when(e.recordedAt))}</td><td>${esc(rs(e.expectedTotal))}</td><td>${tag(e.status)}</td><td>${e.attempts}</td><td>${esc(e.error ?? e.discardReason ?? "")}${e.conflict ? `<br /><span class="muted">${esc(CONFLICT[e.conflict] ?? e.conflict)}</span>` : ""}</td></tr>`)
            .join("")}</tbody></table></div>`
        : `<p class="muted">Nothing recorded yet.</p>`;
    } catch {
      box.innerHTML = errorState("Couldn't load the server record (are you offline?).");
    }
  }
  main.querySelector("#sy-status")?.addEventListener("change", loadServer);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const unsub = rt.subscribe(() => {
    if (!alive()) return unsub();
    draw();
    clearTimeout(timer); // the server's record follows a moment after the local one settles
    timer = setTimeout(loadServer, 1500);
  });
  await draw();
  loadServer();
}
