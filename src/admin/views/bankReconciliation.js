/**
 * Bank reconciliation: tick the lines that appear on the statement until the difference is exactly zero.
 * The server re-checks everything (the ticked lines must add up to the statement balance to the paisa).
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, confirmDialog } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default async function bankReconciliation({ main }) {
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Bank <em>reconciliation</em></h1>
        <p class="muted">Match the books to your bank or wallet statement. Choose the account, enter the statement's date and ending balance, then tick every line that appears on the statement. You can finish when the difference is zero.</p></header>
      <form class="adm-filters" data-start novalidate>
        <div class="field"><label for="br-acc">Account</label><select id="br-acc"></select></div>
        <div class="field"><label for="br-date">Statement date</label><input id="br-date" type="date" value="${ymd(new Date())}" /></div>
        <div class="field"><label for="br-bal">Statement ending balance (Rs)</label><input id="br-bal" inputmode="decimal" /></div>
        <button type="submit" class="btn btn--primary"><span>Load lines</span></button>
      </form>
      <div data-work></div>
      <h2 class="adm-h2">Past reconciliations</h2>
      <div data-history><p class="muted">Choose an account.</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-work]") !== null;
  const acc = /** @type {HTMLSelectElement} */ (main.querySelector("#br-acc"));
  const work = /** @type {HTMLElement} */ (main.querySelector("[data-work]"));
  const history = /** @type {HTMLElement} */ (main.querySelector("[data-history]"));

  try {
    const r = await call("listMoneyAccounts", {});
    const list = r.accounts.filter((a) => a.kind === "bank" || a.kind === "wallet");
    acc.innerHTML = list.length ? list.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join("") : `<option value="">No bank or wallet accounts</option>`;
  } catch (error) {
    work.innerHTML = errorState(/set up/i.test(/** @type {Error} */ (error).message) ? "Accounting isn't set up yet." : /** @type {Error} */ (error).message);
    return;
  }

  async function loadHistory() {
    if (!acc.value) return;
    try {
      const r = await call("listReconciliations", { accountCode: acc.value });
      if (!alive()) return;
      const latest = r.reconciliations.find((x) => x.status === "finished");
      history.innerHTML = r.reconciliations.length
        ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Statement date</th><th>Statement balance</th><th>Lines</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>${r.reconciliations.map((x) => `<tr><td>${esc(x.statementDate)}</td><td>${esc(money(x.statementBalance))}</td><td>${x.lines}</td><td>${esc(x.byName ?? "")}</td><td>${x.status === "finished" ? "Finished" : "Undone"}</td><td>${latest && x.id === latest.id ? `<button type="button" class="text-btn" data-undo="${esc(x.id)}">Undo</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Nothing reconciled yet for this account.</p>`;
      history.querySelector("[data-undo]")?.addEventListener("click", async (e) => {
        if (!(await confirmDialog({ title: "Undo the latest reconciliation?", body: "Its lines become unmatched again. The books are not changed.", confirm: "Undo", danger: true }))) return;
        const reason = window.prompt("Why are you undoing it? (at least 5 letters)") ?? "";
        if (reason.trim().length < 5) return toast("A reason is needed.", "error");
        try {
          await call("undoReconciliation", { idempotencyKey: newKey(), id: /** @type {HTMLElement} */ (e.currentTarget).dataset.undo, reason: reason.trim() });
          toast("Undone");
          work.innerHTML = "";
          loadHistory();
        } catch (err) {
          toast(/** @type {Error} */ (err).message, "error");
        }
      });
    } catch (error) {
      history.innerHTML = errorState(/** @type {Error} */ (error).message);
    }
  }

  async function load() {
    const statementBalance = toPaisa(/** @type {HTMLInputElement} */ (main.querySelector("#br-bal")).value);
    const statementDate = /** @type {HTMLInputElement} */ (main.querySelector("#br-date")).value;
    if (!acc.value || statementBalance === null || Number.isNaN(statementBalance)) return toast("Choose an account and enter the statement's ending balance in rupees.", "error");
    work.innerHTML = `<p class="muted">Loading…</p>`;
    let w;
    try {
      w = await call("reconWorkspace", { accountCode: acc.value, statementDate });
    } catch (error) {
      work.innerHTML = errorState(/** @type {Error} */ (error).message);
      return;
    }
    if (!alive()) return;
    work.innerHTML = `
      <p class="muted">Already reconciled up to ${w.lastStatementDate ? esc(w.lastStatementDate) : "— (first time)"} · cleared balance ${esc(money(w.clearedBalance))}${w.more ? " · <strong>more than 400 lines are waiting; reconcile in smaller steps (earlier statement date)</strong>" : ""}</p>
      ${w.entries.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Match</th><th>Date</th><th>Entry</th><th>Description</th><th>Money in</th><th>Money out</th></tr></thead><tbody>${w.entries.map((e) => `<tr><td><input type="checkbox" data-line="${esc(e.id)}" data-amount="${e.debit - e.credit}" aria-label="On the statement" /></td><td>${esc(e.dateKey)}</td><td><code>${esc(e.number ?? "")}</code></td><td>${esc(e.memo ?? "")}</td><td>${e.debit ? esc(money(e.debit)) : ""}</td><td>${e.credit ? esc(money(e.credit)) : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No unmatched lines up to this date.</p>`}
      <p data-summary role="status"></p>
      <p><button type="button" class="btn btn--primary" data-finish disabled><span>Finish reconciliation</span></button></p>`;
    const boxes = [...work.querySelectorAll("[data-line]")];
    const summary = /** @type {HTMLElement} */ (work.querySelector("[data-summary]"));
    const finish = /** @type {HTMLButtonElement} */ (work.querySelector("[data-finish]"));
    const refresh = () => {
      const ticked = boxes.filter((b) => /** @type {HTMLInputElement} */ (b).checked);
      const cleared = w.clearedBalance + ticked.reduce((n, b) => n + Number(/** @type {HTMLElement} */ (b).dataset.amount), 0);
      const diff = statementBalance - cleared;
      summary.innerHTML = `Ticked ${ticked.length} · cleared balance <strong>${esc(money(cleared))}</strong> · statement <strong>${esc(money(statementBalance))}</strong> · difference <strong>${esc(money(diff))}</strong>${diff === 0 ? " — it matches" : ""}`;
      finish.disabled = diff !== 0 || !ticked.length;
    };
    boxes.forEach((b) => b.addEventListener("change", refresh));
    refresh();
    finish.addEventListener("click", async () => {
      finish.disabled = true;
      try {
        const ids = boxes.filter((b) => /** @type {HTMLInputElement} */ (b).checked).map((b) => /** @type {HTMLElement} */ (b).dataset.line);
        const r = await call("finishReconciliation", { idempotencyKey: newKey(), accountCode: acc.value, statementDate, statementBalance, entryIds: ids });
        toast(`Reconciled ${r.lines} lines`);
        work.innerHTML = "";
        loadHistory();
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
        refresh();
      }
    });
  }

  main.querySelector("[data-start]").addEventListener("submit", (e) => {
    e.preventDefault();
    load();
  });
  acc.addEventListener("change", () => {
    work.innerHTML = "";
    loadHistory();
  });
  loadHistory();
}
