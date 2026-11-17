/**
 * Period close: lock the books up to a day. Nothing can be posted dated on or before the closed day; corrections go
 * into the open period. The Owner can reopen, with a reason that is kept.
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, confirmDialog, formatWhen } from "../ui/kit.js";
import { newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function periodClose({ main, user }) {
  const canClose = user.perms.includes("accounting.close");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Period <em>close</em></h1>
        <p class="muted">Closing locks the books through a day: no journal, expense or automatic posting can be dated on or before it. Use it after you have checked the month's reports and reconciled the bank.</p></header>
      <div data-state><p class="muted">Loading…</p></div>
      ${canClose ? `<form class="adm-filters" data-close novalidate>
        <div class="field"><label for="pc-through">Close the books through</label><input id="pc-through" type="date" value="${ymd(new Date(Date.now() - 86400000))}" max="${ymd(new Date(Date.now() - 86400000))}" /></div>
        <button type="button" class="btn btn--ghost" data-check>Check readiness</button>
        <button type="submit" class="btn btn--primary"><span>Close period</span></button>
      </form><div data-checks role="status"></div>` : `<p class="muted">Only people allowed to close periods see the controls.</p>`}
      <h2 class="adm-h2">History</h2>
      <div data-history></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-state]") !== null;
  const stateEl = /** @type {HTMLElement} */ (main.querySelector("[data-state]"));
  const hist = /** @type {HTMLElement} */ (main.querySelector("[data-history]"));
  const checksEl = main.querySelector("[data-checks]");

  async function draw() {
    try {
      const r = await call("listPeriods", {});
      if (!alive()) return;
      stateEl.innerHTML = r.closedThrough
        ? `<p>The books are <strong>closed through ${esc(r.closedThrough)}</strong>. ${canClose ? `<button type="button" class="text-btn" data-reopen>Reopen…</button>` : ""}</p>`
        : `<p>No period is closed yet.</p>`;
      hist.innerHTML = r.history.length
        ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>When</th><th>Action</th><th>Through</th><th>By</th><th>Note</th></tr></thead><tbody>${r.history.map((h) => `<tr><td>${esc(formatWhen(h.at))}</td><td>${h.type === "close" ? "Closed" : "Reopened"}</td><td>${esc(h.through ?? "everything")}</td><td>${esc(h.byName ?? "")}</td><td>${esc(h.note ?? "")}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Nothing yet.</p>`;
      stateEl.querySelector("[data-reopen]")?.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: "Reopen the books?", body: "Entries dated in the reopened days become possible again. The reason is recorded.", confirm: "Reopen", danger: true }))) return;
        const reason = window.prompt("Why are you reopening? (at least 5 letters)") ?? "";
        if (reason.trim().length < 5) return toast("A reason is needed.", "error");
        try {
          await call("reopenPeriod", { idempotencyKey: newKey(), through: null, reason: reason.trim() });
          toast("Reopened");
          draw();
        } catch (error) {
          toast(/** @type {Error} */ (error).message, "error");
        }
      });
    } catch (error) {
      stateEl.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : /** @type {Error} */ (error).message);
    }
  }
  const through = () => /** @type {HTMLInputElement} */ (main.querySelector("#pc-through")).value;
  main.querySelector("[data-check]")?.addEventListener("click", async () => {
    try {
      const c = await call("periodChecks", { through: through() });
      if (checksEl) checksEl.innerHTML = c.ok ? `<p>Ready to close through ${esc(c.through)}: the trial balance balances, no drafts, nothing waiting in Exceptions.</p>` : `<ul>${c.problems.map((p) => `<li>${esc(p.message)}</li>`).join("")}</ul>`;
    } catch (error) {
      toast(/** @type {Error} */ (error).message, "error");
    }
  });
  main.querySelector("[data-close]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await confirmDialog({ title: `Close the books through ${through()}?`, body: "Nothing can be posted into these days afterwards unless the Owner reopens them.", confirm: "Close period" }))) return;
    try {
      await call("closePeriod", { idempotencyKey: newKey(), through: through() });
      toast("Period closed");
      if (checksEl) checksEl.innerHTML = "";
      draw();
    } catch (error) {
      toast(/** @type {Error} */ (error).message, "error");
    }
  });
  await draw();
}
