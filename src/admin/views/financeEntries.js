/**
 * Income and expense entries (one screen, two modes). Add, edit, delete (void), approve; attach receipts. Every change
 * is a server call that validates the input and posts the journal; a deleted entry is kept as "void" with its reversal.
 */
import { esc } from "../../lib/format.js";
import { METHOD_LABEL, FINANCE_METHODS, METHOD_KIND, ENTRY_STATUS_LABEL } from "../../../shared/finance.js";
import { toast, errorState, confirmDialog, formatWhen } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { privateFileButton, wirePrivateFiles } from "../privateFileUi.js";
import { todayKey, money, toPaisa, messageOf, uploadReceipt, labelTables } from "../financeUi.js";

const TAG = { posted: "tag", pending: "tag tag--low", rejected: "tag tag--out", void: "tag tag--out" };

/** @param {"income" | "expense"} kind */
export function makeEntriesView(kind) {
  const word = kind === "income" ? "income" : "expense";
  return async function entriesView({ main, user }) {
    const can = (p) => user.perms.includes(p);
    let categories = [];
    let accounts = [];
    let rows = [];
    let next = null;
    let filter = { from: "", to: "", status: "" };
    main.innerHTML = `
      <div class="adm-page">
        <header class="adm-page__head"><h1 class="adm-h1">${kind === "income" ? "Income" : "<em>Expenses</em>"}${kind === "income" ? " <em>entries</em>" : ""}</h1>
          <p class="muted">${kind === "income" ? "Income from sales is recognised automatically when a sale is recorded. Use this screen for other income (commission, rent received, …)." : "Every expense is posted to the books when it is saved. Large expenses may wait for approval."} Editing or deleting reverses the earlier posting; nothing posted is changed.</p></header>
        ${can("finance.write") ? `<p><button type="button" class="btn btn--primary" data-add><span>Add ${word}</span></button></p>` : ""}
        <form class="adm-filters" data-filter novalidate>
          <div class="field"><label for="fe-from">From</label><input id="fe-from" type="date" /></div>
          <div class="field"><label for="fe-to">To</label><input id="fe-to" type="date" /></div>
          <div class="field"><label for="fe-status">Status</label><select id="fe-status"><option value="">All</option>${Object.entries(ENTRY_STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <button type="submit" class="btn btn--ghost"><span>Filter</span></button>
        </form>
        <div data-list><p class="muted">Loading…</p></div>
      </div>`;
    const list = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
    const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;

    async function loadRefs() {
      const [c, a] = await Promise.all([call("listFinanceCategories", {}), call("listMoneyAccounts", {})]);
      categories = c.categories.filter((x) => x.kind === kind);
      accounts = a.accounts.filter((x) => x.active);
    }

    const draw = () => {
      list.innerHTML = rows.length
        ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Ref</th><th>${kind === "income" ? "Source" : "Expense"}</th><th>Category</th><th>Paid ${kind === "income" ? "into" : "from"}</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows
            .map(
              (e) => `<tr><td>${esc(e.date)}</td><td><code>${esc(e.number)}</code></td><td><strong>${esc(e.title)}</strong>${e.vendor?.name ? `<br /><span class="muted">${esc(e.vendor.name)}</span>` : ""}${e.reference ? `<br /><span class="muted">Ref: ${esc(e.reference)}</span>` : ""}${e.attachments?.length ? `<br />${e.attachments.map((a) => privateFileButton(a.url, a.name)).join(" · ")}` : ""}</td><td>${esc(e.categoryName)}</td><td>${esc(e.accountName)} <span class="muted">(${esc(METHOD_LABEL[e.method] ?? e.method)})</span></td><td><strong>${esc(money(e.amount))}</strong></td><td><span class="${TAG[e.status] ?? "tag"}">${esc(ENTRY_STATUS_LABEL[e.status] ?? e.status)}</span></td>
          <td class="adm-actions"><button type="button" class="text-btn" data-hist="${esc(e.id)}">History</button>${["posted", "pending"].includes(e.status) && can("finance.write") ? ` <button type="button" class="text-btn" data-edit="${esc(e.id)}">Edit</button>` : ""}${e.status === "pending" && can("finance.approve") ? ` <button type="button" class="text-btn" data-approve="${esc(e.id)}">Approve</button> <button type="button" class="text-btn" data-reject="${esc(e.id)}">Reject</button>` : ""}${e.status !== "void" && can("finance.void") ? ` <button type="button" class="text-btn" data-void="${esc(e.id)}">Delete</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>${next ? `<p class="adm-table__more"><button type="button" class="btn btn--ghost" data-more>Load more</button></p>` : ""}`
        : `<p class="muted">No ${word} entries ${filter.from || filter.status ? "match these filters" : "yet"}.</p>`;
      labelTables(list);
      wirePrivateFiles(list);
    };

    async function load(more = false) {
      try {
        if (!categories.length && !more) await loadRefs();
        const r = await call("listFinanceEntries", { type: kind, limit: 50, ...(filter.from ? { from: filter.from } : {}), ...(filter.to ? { to: filter.to } : {}), ...(filter.status ? { status: filter.status } : {}), ...(more && next ? { after: next } : {}) });
        if (!alive()) return;
        rows = more ? rows.concat(r.entries) : r.entries;
        next = r.next;
        draw();
      } catch (e) {
        if (alive()) {
          list.innerHTML = errorState(messageOf(e));
          list.querySelector("[data-retry]")?.addEventListener("click", () => load());
        }
      }
    }

    function entryDialog(existing = null) {
      const attachments = [...(existing?.attachments ?? [])];
      const sel = (id) => (id ? `selected` : "");
      const catOptions = categories.filter((c) => c.isActive !== false || c.id === existing?.categoryId).map((c) => [c.id, c.name]);
      if (!catOptions.length) return toast(`Add a ${word} category first (Finance settings).`, "error");
      const methodOpts = FINANCE_METHODS.map((m) => [m, METHOD_LABEL[m]]);
      const acctOpts = [["", "Default account for the method"], ...accounts.map((a) => [a.code, `${a.name} (${a.kind})`])];
      const idem = newKey();
      formDialog({
        title: existing ? `Edit ${existing.number}` : `Add ${word}`,
        intro: existing ? `Saving reverses the earlier posting and posts the new one. Version ${existing.version}.` : "",
        wide: true,
        body: row("title", kind === "income" ? "Income description" : "Expense title", input("title", `maxlength="120" value="${esc(existing?.title ?? "")}"`)) +
          row("amount", "Amount (Rs.)", input("amount", `inputmode="decimal" value="${existing ? existing.amount / 100 : ""}"`)) +
          row("date", "Date", input("date", `type="date" value="${esc(existing?.date ?? todayKey())}"`)) +
          row("categoryId", "Category", select("categoryId", catOptions, existing?.categoryId ?? catOptions[0][0])) +
          row("method", "Payment method", select("method", methodOpts, existing?.method ?? "cash")) +
          row("accountCode", "Account", select("accountCode", acctOpts, existing?.accountCode ?? "")) +
          row("reference", "Payment reference (optional)", input("reference", `maxlength="80" value="${esc(existing?.reference ?? "")}"`)) +
          (kind === "expense" ? row("vendorName", "Vendor / supplier (optional)", input("vendorName", `maxlength="120" value="${esc(existing?.vendor?.name ?? "")}"`)) : "") +
          row("description", "Description (optional)", input("description", `maxlength="500" value="${esc(existing?.description ?? "")}"`)) +
          (kind === "expense" ? `<div class="field"><label for="pd-file">Receipt or invoice (PDF or image, up to 5 MB)</label><input id="pd-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /><p class="field-hint" data-files>${attachments.map((a) => esc(a.name)).join(", ")}</p></div>` : ""),
        submit: existing ? "Save changes" : `Save ${word}`,
        onOpen: (form) => {
          const file = /** @type {HTMLInputElement | null} */ (form.querySelector("#pd-file"));
          file?.addEventListener("change", async () => {
            const f = file.files?.[0];
            if (!f) return;
            const note = /** @type {HTMLElement} */ (form.querySelector("[data-files]"));
            note.textContent = "Uploading…";
            try {
              attachments.push(await uploadReceipt(f));
              note.textContent = attachments.map((a) => a.name).join(", ");
            } catch (err) {
              note.textContent = /** @type {Error} */ (err).message || "Upload failed.";
            }
            file.value = "";
          });
        },
        onSubmit: async (form, { show, close }) => {
          const f = new FormData(form);
          const amount = toPaisa(f.get("amount"));
          if (!amount) return show("Enter the amount as a number greater than zero.", { amount: "Required" });
          if (METHOD_KIND[String(f.get("method"))] === undefined) return show("Choose a payment method.");
          const payload = { type: kind, date: String(f.get("date")), amount, title: String(f.get("title")).trim(), description: String(f.get("description") ?? "").trim(), categoryId: String(f.get("categoryId")), method: String(f.get("method")), accountCode: String(f.get("accountCode")) || null, reference: String(f.get("reference") ?? "").trim(), vendorName: String(f.get("vendorName") ?? "").trim(), attachments };
          const r = await call("saveFinanceEntry", existing ? { ...payload, id: existing.id, expectedVersion: existing.version } : { ...payload, idempotencyKey: idem });
          close();
          toast(r.status === "pending" ? `${r.number} saved — waiting for approval` : `${r.number} saved`);
          await load();
        },
      });
      void sel;
    }

    main.querySelector("[data-add]")?.addEventListener("click", async () => {
      if (!categories.length) await loadRefs().catch(() => {});
      entryDialog();
    });
    main.querySelector("[data-filter]")?.addEventListener("submit", (e) => {
      e.preventDefault();
      filter = { from: /** @type {HTMLInputElement} */ (main.querySelector("#fe-from")).value, to: /** @type {HTMLInputElement} */ (main.querySelector("#fe-to")).value, status: /** @type {HTMLSelectElement} */ (main.querySelector("#fe-status")).value };
      load();
    });
    list.addEventListener("click", async (e) => {
      const t = /** @type {HTMLElement} */ (e.target).closest("button");
      if (!t) return;
      const id = t.dataset.edit ?? t.dataset.void ?? t.dataset.approve ?? t.dataset.reject ?? t.dataset.hist;
      const entry = rows.find((x) => x.id === id);
      if (t.hasAttribute("data-more")) return load(true);
      if (!entry) return;
      try {
        if (t.dataset.edit) return entryDialog(entry);
        if (t.dataset.hist) {
          const d = document.createElement("dialog");
          d.className = "adm-dialog adm-dialog--wide";
          d.innerHTML = `<form method="dialog"><h2>${esc(entry.number)} history</h2><ul class="pos-history">${(entry.history ?? []).map((h) => `<li>${esc(formatWhen(new Date(h.at)))} · ${esc(h.byName)} · ${esc(h.action)}${h.note ? ` — ${esc(h.note)}` : ""}</li>`).join("")}</ul><div class="adm-dialog__actions"><button class="btn btn--ghost" type="submit">Close</button></div></form>`;
          document.body.append(d);
          d.addEventListener("close", () => d.remove());
          return d.showModal();
        }
        if (t.dataset.void) {
          formDialog({
            title: `Delete ${entry.number}`,
            intro: "The entry stays on record as void and its posting is reversed in the books. The reason is kept in the audit log.",
            body: row("reason", "Reason", input("reason", 'maxlength="200"')),
            submit: "Delete entry",
            onSubmit: async (form, { show, close }) => {
              const reason = String(new FormData(form).get("reason") ?? "").trim();
              if (reason.length < 3) return show("Give a reason.", { reason: "Required" });
              await call("voidFinanceEntry", { id: entry.id, reason });
              close();
              toast("Entry deleted (reversed in the books)");
              await load();
            },
          });
          return;
        }
        if (t.dataset.approve) {
          if (!(await confirmDialog({ title: `Approve ${entry.number}?`, body: `${entry.title}: ${money(entry.amount)} will be posted to the books.`, confirm: "Approve" }))) return;
          await call("decideExpense", { id: entry.id, decision: "approve" });
          toast("Approved and posted");
          return load();
        }
        if (t.dataset.reject) {
          if (!(await confirmDialog({ title: `Reject ${entry.number}?`, body: "Nothing will be posted.", confirm: "Reject", danger: true }))) return;
          await call("decideExpense", { id: entry.id, decision: "reject" });
          toast("Rejected");
          return load();
        }
      } catch (err) {
        toast(messageOf(err), "error");
      }
    });
    await load();
  };
}
