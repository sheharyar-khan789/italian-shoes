/**
 * Cash & bank management: balances of every cash, bank and wallet account (from the books), transfers between them
 * (not income or expenses), cash counts with reconciliation and authorised adjustments, and the daily cash summary
 * (Closing = Opening + Cash in − Cash out).
 */
import { esc } from "../../lib/format.js";
import { closingCash } from "../../../shared/finance.js";
import { statCard, toast, errorState } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { todayKey, money, toPaisa, messageOf, tableHtml, labelTables } from "../financeUi.js";
import { addDays } from "../../../shared/finance.js";

const KIND = { cash: "Cash in hand", bank: "Bank", wallet: "Wallet clearing" };

export default async function moneyView({ main, user }) {
  const can = (p) => user.perms.includes(p);
  let accounts = [];
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Cash <em>&amp; bank management</em></h1>
        <p class="muted">Balances come from the books. A transfer between your own accounts (deposit, withdrawal, wallet settlement) moves money without being income or an expense. A cash count compares what is really there with what the books expect.</p></header>
      <p>${can("finance.write") ? `<button type="button" class="btn btn--primary" data-transfer><span>Transfer money</span></button> <button type="button" class="btn btn--ghost" data-count><span>Count / reconcile</span></button> ` : ""}${can("finance.manage") ? `<button type="button" class="btn btn--ghost" data-bank><span>Add bank account</span></button>` : ""}</p>
      <div data-balances><p class="muted">Loading…</p></div>
      <h2 class="adm-h2">Daily cash summary</h2>
      <form class="adm-filters" data-range novalidate>
        <div class="field"><label for="mn-from">From</label><input id="mn-from" type="date" value="${addDays(todayKey(), -7)}" /></div>
        <div class="field"><label for="mn-to">To</label><input id="mn-to" type="date" value="${todayKey()}" /></div>
        <button type="submit" class="btn btn--primary"><span>Show</span></button>
      </form>
      <div data-daily></div>
      <h2 class="adm-h2">Recent transfers and adjustments</h2>
      <div data-recent><p class="muted">Loading…</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLElement} */ (main.querySelector(s));
  const alive = () => main.isConnected && main.querySelector("[data-balances]") !== null;

  async function loadBalances() {
    try {
      const r = await call("listMoneyAccounts", {});
      if (!alive()) return;
      if (!r.enabled) return void ($("[data-balances]").innerHTML = errorState("Accounting isn't set up yet. Create the chart of accounts first (Accounting → Chart of Accounts)."));
      accounts = r.accounts;
      $("[data-balances]").innerHTML = `<div class="adm-stats">${statCard({ label: "Total", value: money(accounts.reduce((n, a) => n + a.balance, 0)) })}${accounts.map((a) => statCard({ label: a.name, value: money(a.balance), note: `${KIND[a.kind]} · ${a.code}${a.active ? "" : " · off"}` })).join("")}</div>`;
    } catch (e) {
      if (alive()) $("[data-balances]").innerHTML = errorState(messageOf(e));
    }
  }
  async function loadRecent() {
    try {
      const [t, a] = await Promise.all([call("listFinanceEntries", { type: "transfer", limit: 10 }), call("listFinanceEntries", { type: "adjustment", limit: 10 })]);
      const all = [...t.entries, ...a.entries].sort((x, y) => y.date.localeCompare(x.date));
      $("[data-recent]").innerHTML = all.length
        ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Ref</th><th>What</th><th>Reference</th><th>Amount</th><th>Status</th></tr></thead><tbody>${all.map((e) => `<tr><td>${esc(e.date)}</td><td><code>${esc(e.number)}</code></td><td>${esc(e.title)}</td><td>${esc(e.reference || "")}</td><td>${esc(money(e.amount))}</td><td>${esc(e.status)}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">No transfers or adjustments yet.</p>`;
      labelTables($("[data-recent]"));
    } catch (e) {
      $("[data-recent]").innerHTML = errorState(messageOf(e));
    }
  }
  async function loadDaily() {
    const box = $("[data-daily]");
    box.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const r = await call("financeReport", { report: "cashregister", from: /** @type {HTMLInputElement} */ ($("#mn-from")).value, to: /** @type {HTMLInputElement} */ ($("#mn-to")).value });
      const t = r.tables[0];
      const ok = t.totals && closingCash(t.totals.opening, t.totals.in, t.totals.out) === t.totals.closing;
      box.innerHTML = `${tableHtml(t)}<p class="muted">Closing cash = opening cash + cash in − cash out. ${ok ? "This period adds up." : "This period does not add up — see Accounting → Reconciliation."}</p>`;
      labelTables(box);
    } catch (e) {
      box.innerHTML = errorState(messageOf(e));
    }
  }

  const acctOptions = (/** @type {(a: any) => boolean} */ filter = () => true) => accounts.filter((a) => a.active && filter(a)).map((a) => [a.code, `${a.name} — ${money(a.balance)}`]);

  main.querySelector("[data-transfer]")?.addEventListener("click", () => {
    const idem = newKey();
    formDialog({
      title: "Transfer money",
      intro: "Cash to bank (deposit), bank to cash (withdrawal), bank to bank, or wallet to bank. This is not income or an expense.",
      body: row("fromAccount", "From", select("fromAccount", acctOptions())) + row("toAccount", "To", select("toAccount", acctOptions(), acctOptions()[1]?.[0] ?? "")) + row("amount", "Amount (Rs.)", input("amount", 'inputmode="decimal"')) + row("date", "Date", input("date", `type="date" value="${todayKey()}"`)) + row("reference", "Payment reference (optional)", input("reference", 'maxlength="80"')) + row("note", "Note (optional)", input("note", 'maxlength="200"')),
      submit: "Transfer",
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const amount = toPaisa(f.get("amount"));
        if (!amount) return show("Enter the amount as a number greater than zero.", { amount: "Required" });
        const r = await call("createTransfer", { idempotencyKey: idem, date: String(f.get("date")), fromAccount: String(f.get("fromAccount")), toAccount: String(f.get("toAccount")), amount, reference: String(f.get("reference") ?? "").trim(), note: String(f.get("note") ?? "").trim() });
        close();
        toast(`${r.number} recorded`);
        await Promise.all([loadBalances(), loadRecent(), loadDaily()]);
      },
    });
  });

  main.querySelector("[data-count]")?.addEventListener("click", () => {
    const idem = newKey();
    formDialog({
      title: "Count / reconcile an account",
      intro: "Enter what is really in the account (cash counted, or the bank statement balance) as of a date. The books' expected balance is worked out by the server. A difference is recorded; only someone who may authorise adjustments can post it.",
      body: row("accountCode", "Account", select("accountCode", acctOptions())) + row("date", "As of", input("date", `type="date" value="${todayKey()}"`)) + row("countedAmount", "Counted / statement balance (Rs.)", input("countedAmount", 'inputmode="decimal"')) + row("note", "Note (optional)", input("note", 'maxlength="300"')) + (can("finance.adjust") ? `<label class="check"><input type="checkbox" name="adjust" /> <span>Post the difference to the books (authorised adjustment)</span></label>` : ""),
      submit: "Record count",
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const counted = f.get("countedAmount") === "" ? null : toPaisa(f.get("countedAmount"));
        if (counted === null) return show("Enter the counted amount (0 if empty).", { countedAmount: "Required" });
        const r = await call("recordCashCount", { idempotencyKey: idem, accountCode: String(f.get("accountCode")), date: String(f.get("date")), countedAmount: counted, note: String(f.get("note") ?? "").trim(), adjust: f.get("adjust") === "on" });
        close();
        toast(r.status === "reconciled" ? `Matches the books (${money(r.expected)})` : r.status === "adjusted" ? `Difference of ${money(Math.abs(r.variance))} posted` : `Difference of ${money(Math.abs(r.variance))} recorded, not posted (expected ${money(r.expected)})`, r.status === "reconciled" ? "ok" : "error");
        await Promise.all([loadBalances(), loadRecent(), loadDaily()]);
      },
    });
  });

  main.querySelector("[data-bank]")?.addEventListener("click", () => {
    const idem = newKey();
    formDialog({
      title: "Add a bank account",
      intro: "Creates a new account under the bank heading in your chart of accounts (the next free code).",
      body: row("name", "Account name", input("name", 'maxlength="60" placeholder="e.g. HBL Current"')),
      submit: "Add account",
      onSubmit: async (form, { show, close }) => {
        const name = String(new FormData(form).get("name") ?? "").trim();
        if (name.length < 2) return show("Enter a name.", { name: "Required" });
        const r = await call("addBankAccount", { idempotencyKey: idem, name });
        close();
        toast(`Added account ${r.code}`);
        await loadBalances();
      },
    });
  });
  main.querySelector("[data-range]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    loadDaily();
  });
  await Promise.all([loadBalances(), loadRecent(), loadDaily()]);
}
