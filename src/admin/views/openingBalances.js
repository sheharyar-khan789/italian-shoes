/**
 * Opening balances: the owner enters what the business already had (cash, bank, stock value, what is owed to
 * suppliers, owner's capital …). Nothing is filled in or imported for you. You preview first; it can only be posted
 * when debits equal credits, as ONE identifiable journal ("Opening balances"). Supplier opening balances can be
 * entered per supplier so the payables report agrees with the supplier ledger.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, newKey, today } from "../ui/purchasing.js";
import { call, pageOf, getRow, listSuppliers } from "../purchData.js";

export default async function openingBalances({ main, user }) {
  const canManage = user.perms.includes("accounting.manage");
  main.innerHTML = `<div class="adm-page" data-page><p class="muted">Loading…</p></div>`;
  const page = /** @type {HTMLElement} */ (main.querySelector("[data-page]"));
  let accounts;
  let config;
  let suppliers = [];
  try {
    const [a, c] = await Promise.all([pageOf("accounts", { orderBy: ["code", "asc"], size: 300 }), getRow("accountingConfig", "main")]);
    suppliers = await listSuppliers().catch(() => []);
    accounts = a.rows.filter((x) => !x.isGroup && x.isActive !== false && ["asset", "liability", "equity"].includes(x.type));
    config = c;
  } catch {
    page.innerHTML = errorState();
    return;
  }
  if (!config) {
    page.innerHTML = `<p>Accounting isn't set up yet. <a class="text-link" href="/admin/accounting" data-link>Create the chart of accounts</a> first.</p>`;
    return;
  }
  const key = newKey();
  /** @type {{ accountCode: string, debit: string, credit: string, partyId: string }[]} */
  const lines = [{ accountCode: "", debit: "", credit: "", partyId: "" }, { accountCode: "", debit: "", credit: "", partyId: "" }, { accountCode: "", debit: "", credit: "", partyId: "" }];
  let date = today();
  let valid = false;

  const accountOptions = (sel) => `<option value="">Choose…</option>${accounts.map((a) => `<option value="${esc(a.code)}" ${a.code === sel ? "selected" : ""}>${esc(a.code)} · ${esc(a.name)}</option>`).join("")}`;
  const payable = (code) => config.accounts?.[code]?.control === "payable";

  function draw(result = null) {
    page.innerHTML = `
      <header class="adm-page__head"><h1 class="adm-h1">Opening <em>balances</em></h1>
        <p class="muted">Enter what the business had on the date you start using accounting. Assets (cash, bank, stock value, money owed to you) go in the debit column; liabilities (money you owe) and owner's capital go in the credit column. Total debits must equal total credits. Nothing is entered for you.</p></header>
      ${canManage ? "" : `<p class="form-alert">Only an owner-level manager can post opening balances; you can preview.</p>`}
      <div class="field"><label for="ob-date">Opening date</label><input id="ob-date" type="date" value="${esc(date)}" max="${today()}" /></div>
      <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account</th><th>Debit (Rs)</th><th>Credit (Rs)</th><th>Supplier (payables)</th></tr></thead><tbody>
        ${lines.map((l, i) => `<tr><td><select data-f="accountCode" data-i="${i}" aria-label="Account">${accountOptions(l.accountCode)}</select></td><td><input data-f="debit" data-i="${i}" inputmode="decimal" value="${esc(l.debit)}" aria-label="Debit" /></td><td><input data-f="credit" data-i="${i}" inputmode="decimal" value="${esc(l.credit)}" aria-label="Credit" /></td>
          <td>${payable(l.accountCode) ? `<select data-f="partyId" data-i="${i}" aria-label="Supplier"><option value="">— none —</option>${suppliers.map((s) => `<option value="${esc(s.id)}" ${s.id === l.partyId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>` : "—"}</td></tr>`).join("")}</tbody></table></div>
      <p><button type="button" class="btn btn--ghost" data-add>Add a line</button> <button type="button" class="btn btn--primary" data-preview><span>Preview</span></button></p>
      ${result ? previewBox(result) : ""}
      ${canManage && valid ? `<p><button type="button" class="btn btn--primary" data-post><span>Post opening balances</span></button></p>` : ""}
      <p class="muted">Once posted, an opening entry can only be corrected by reversing it (Journal Entries) and entering it again. Posting does not change any sale, purchase or supplier balance.</p>`;
  }
  function previewBox(r) {
    const ok = r.valid;
    return `<div class="adm-card"><p><strong>Debits ${esc(money(r.totalDebit))}</strong> · <strong>Credits ${esc(money(r.totalCredit))}</strong> · ${ok ? `<span class="tag">Balanced — ready to post</span>` : `<span class="tag tag--out">Not ready</span>`}</p>
      ${r.difference ? `<p>Difference: ${esc(money(Math.abs(r.difference)))} (${r.difference > 0 ? "more debits than credits" : "more credits than debits"}). ${r.difference > 0 && config.roles.owner_capital ? `<button type="button" class="text-btn" data-plug>Add it to Owner Capital as a credit</button>` : ""}</p>` : ""}
      ${r.errors.length ? `<ul>${r.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}</div>`;
  }
  const read = () => {
    date = /** @type {HTMLInputElement} */ (page.querySelector("#ob-date")).value;
    page.querySelectorAll("[data-f]").forEach((e) => {
      const el = /** @type {HTMLInputElement} */ (e);
      lines[Number(el.dataset.i)][/** @type {"accountCode" | "debit" | "credit" | "partyId"} */ (el.dataset.f)] = el.value;
    });
  };
  const payload = () => {
    const out = lines.filter((l) => l.accountCode || l.debit || l.credit).map((l) => ({ accountCode: l.accountCode, debit: toPaisa(l.debit) ?? 0, credit: toPaisa(l.credit) ?? 0, ...(l.partyId && payable(l.accountCode) ? { partyType: "supplier", partyId: l.partyId } : {}) }));
    if (out.some((l) => Number.isNaN(l.debit) || Number.isNaN(l.credit))) throw new Error("Enter amounts in rupees, e.g. 12500.");
    return out;
  };

  page.addEventListener("change", (e) => {
    read();
    valid = false;
    if (/** @type {HTMLElement} */ (e.target).dataset.f === "accountCode") draw();
  });
  page.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    read();
    if (t.closest("[data-add]")) {
      lines.push({ accountCode: "", debit: "", credit: "", partyId: "" });
      valid = false;
      return draw();
    }
    if (t.closest("[data-plug]")) {
      try {
        const r = await call("previewOpeningBalances", { date, lines: payload() });
        lines.push({ accountCode: config.roles.owner_capital, debit: "", credit: String(r.difference / 100), partyId: "" });
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
        return;
      }
    }
    if (t.closest("[data-preview]") || t.closest("[data-plug]")) {
      try {
        const r = await call("previewOpeningBalances", { date, lines: payload() });
        valid = r.valid;
        draw(r);
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
      return;
    }
    if (t.closest("[data-post]")) {
      if (!(await confirmDialog({ title: "Post the opening balances?", body: "This posts one journal entry. It can only be undone by reversing it.", confirm: "Post" }))) return;
      try {
        const r = await call("postOpeningBalances", { idempotencyKey: key, date, memo: "Opening balances", lines: payload() });
        toast(`${r.number} posted.`);
        page.innerHTML = `<header class="adm-page__head"><h1 class="adm-h1">Opening balances posted</h1></header><p>Journal ${esc(r.number)} was posted. <a class="text-link" href="/admin/trial-balance" data-link>View the trial balance</a>.</p>`;
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
    }
  });
  draw();
}
