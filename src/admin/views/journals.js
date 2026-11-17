/**
 * Journal entries: every journal (one page at a time), a manual journal form (save as a draft, or post), and the
 * automatic postings that failed (with a retry). A posted journal can't be edited or deleted; the way to correct it
 * is a reversal, which adds an opposite entry that points at it.
 */
import { esc } from "../../lib/format.js";
import { toast, errorState, dataTable, formatWhen, confirmDialog } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, formDialog, row, input, newKey, today } from "../ui/purchasing.js";
import { call, pageOf, getRow } from "../purchData.js";
import { createJournalInput, reverseJournalInput, fieldErrors } from "../../../shared/schemas/index.js";

const SOURCE_LABEL = { sale: "Sale", payment: "Customer payment", refund: "Refund", grn: "Goods received", supplierpayment: "Supplier payment", purchasereturn: "Purchase return", manual: "Manual", opening: "Opening balances", reversal: "Reversal" };

export default async function journals({ main, user }) {
  const canPost = user.perms.includes("accounting.post");
  const canReverse = user.perms.includes("accounting.reverse");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Journal <em>entries</em></h1>
        <p class="muted">Every entry has equal debits and credits. Sales, payments, purchases and returns post automatically; you can add manual entries. A posted entry is final — correct it with a reversal.</p>
        ${canPost ? `<p><button type="button" class="btn btn--primary" data-new><span>New journal entry</span></button></p>` : ""}
      </header>
      <div data-failed></div>
      <form class="adm-filters" data-filters novalidate>
        <label class="visually-hidden" for="jn-q">Journal number</label><input id="jn-q" type="search" placeholder="Journal number (JE-000012)" />
        <label class="visually-hidden" for="jn-src">Source</label><select id="jn-src"><option value="">All sources</option>${Object.entries(SOURCE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <label class="visually-hidden" for="jn-status">Status</label><select id="jn-status"><option value="">Posted and drafts</option><option value="draft">Drafts</option><option value="posted">Posted</option></select>
        <button type="submit" class="btn btn--primary"><span>Search</span></button>
      </form>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  const listEl = main.querySelector("[data-list]");
  const failedEl = /** @type {HTMLElement} */ (main.querySelector("[data-failed]"));
  const el = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id));
  const rows = new Map();
  let last = null;
  let ticket = 0;

  const table = dataTable({
    caption: "Journal entries",
    empty: { title: "No journal entries yet", text: "They appear here as sales, payments and purchases are posted." },
    columns: [
      { key: "number", label: "Number", render: (r) => `<strong>${esc(r.number ?? "Draft")}</strong>` },
      { key: "dateKey", label: "Date" },
      { key: "memo", label: "Description", render: (r) => esc(r.memo) },
      { key: "sourceType", label: "Source", render: (r) => esc(SOURCE_LABEL[r.sourceType] ?? r.sourceType) },
      { key: "totalDebit", label: "Amount", render: (r) => esc(money(r.totalDebit)) },
      { key: "status", label: "Status", render: (r) => `<span class="${r.status === "posted" ? "tag" : "tag tag--low"}">${esc(r.status === "posted" ? (r.reversalOf ? "Reversal" : "Posted") : "Draft")}</span>` },
      { key: "actions", label: "", render: (r) => `<button type="button" class="text-btn" data-view="${esc(r.id)}">View</button>` },
    ],
  });

  async function load(reset = true) {
    const mine = ++ticket;
    const q = el("#jn-q").value.trim().toUpperCase();
    const src = el("#jn-src").value;
    const status = el("#jn-status").value;
    /** @type {[string, any, any][]} */
    const where = [];
    /** @type {[string, "asc" | "desc"]} */
    let orderBy = ["dateKey", "desc"];
    if (q) {
      where.push(["number", "==", q]);
      orderBy = ["number", "asc"];
    } else if (src) where.push(["sourceType", "==", src]);
    else if (status) where.push(["status", "==", status]);
    try {
      const p = await pageOf("journalEntries", { where, orderBy, after: reset ? null : last });
      if (mine !== ticket || !alive()) return;
      last = p.last;
      const shown = p.rows.filter((r) => (!status || r.status === status) && (!src || r.sourceType === src));
      shown.forEach((r) => rows.set(r.id, r));
      if (reset) table.set(shown, p.hasMore);
      else table.append(shown, p.hasMore);
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }
  table.onMore(() => load(false));
  main.querySelector("[data-filters]").addEventListener("submit", (e) => {
    e.preventDefault();
    load(true);
  });

  async function loadFailed() {
    try {
      const p = await pageOf("accountingExceptions", { where: [["status", "==", "failed"]], size: 20 });
      if (!alive()) return;
      failedEl.innerHTML = p.rows.length
        ? `<div class="adm-card"><h2 class="adm-h2">Postings that failed</h2><p class="muted">The business event went through, but its journal could not be posted (for example an account was switched off). Fix the cause, then retry.</p><ul class="adm-feed">${p.rows.map((r) => `<li><span><strong>${esc(r.sourceType)}</strong> ${esc(r.sourceId)}<br /><span class="muted">${esc(r.reason)}</span></span>${canPost ? `<button type="button" class="text-btn" data-retry-post="${esc(r.id)}">Retry</button>` : ""}</li>`).join("")}</ul></div>`
        : "";
    } catch {
      /* the panel simply stays empty */
    }
  }

  function viewDialog(j) {
    const d = formDialog({
      title: `${j.number ?? "Draft"} · ${j.dateKey}`,
      intro: `${esc(j.memo)}<br />${esc(SOURCE_LABEL[j.sourceType] ?? j.sourceType)}${j.reversalOf ? ` · reverses ${esc(j.reversalOf)}` : ""}`,
      submit: "Close",
      wide: true,
      body: `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>${j.lines.map((l) => `<tr><td>${esc(l.accountCode)} ${esc(l.accountName ?? "")}${l.partyType ? `<br /><span class="muted">${esc(l.partyType)}: ${esc(l.partyName ?? l.partyId)}</span>` : ""}${l.memo ? `<br /><span class="muted">${esc(l.memo)}</span>` : ""}</td><td>${l.debit ? esc(money(l.debit)) : ""}</td><td>${l.credit ? esc(money(l.credit)) : ""}</td></tr>`).join("")}
        <tr><td><strong>Total</strong></td><td><strong>${esc(money(j.totalDebit))}</strong></td><td><strong>${esc(money(j.totalCredit))}</strong></td></tr></tbody></table></div>
        <p class="muted">${j.costMissing ? "This sale had no recorded cost, so no cost of goods sold was posted. " : ""}Posted ${esc(j.postedAt?.toDate ? formatWhen(j.postedAt) : "—")}.</p>
        <p data-actions></p>`,
      onSubmit: (_f, { close }) => close(),
    });
    d.querySelector("[data-close]")?.remove();
    const box = d.querySelector("[data-actions]");
    if (j.status === "draft" && canPost) {
      box.innerHTML = `<button type="button" class="btn btn--primary" data-post-draft>Post this entry</button> <button type="button" class="btn btn--ghost" data-del-draft>Delete draft</button>`;
      box.querySelector("[data-post-draft]").addEventListener("click", async () => {
        try {
          await call("postDraftJournal", { id: j.id, idempotencyKey: newKey() });
          d.close();
          toast("Posted.");
          load(true);
        } catch (error) {
          toast(/** @type {Error} */ (error).message, "error");
        }
      });
      box.querySelector("[data-del-draft]").addEventListener("click", async () => {
        try {
          await call("deleteDraftJournal", { id: j.id });
          d.close();
          toast("Draft deleted.");
          load(true);
        } catch (error) {
          toast(/** @type {Error} */ (error).message, "error");
        }
      });
    } else if (j.status === "posted" && !j.reversalOf && canReverse) {
      getRow("journalEntries", `reversal__${j.id}`).then((rev) => {
        if (rev) box.innerHTML = `<span class="tag tag--out">Reversed by ${esc(rev.number)}</span>`;
        else {
          box.innerHTML = `<button type="button" class="btn btn--ghost" data-reverse>Reverse this entry</button>`;
          box.querySelector("[data-reverse]").addEventListener("click", () => reverseDialog(j, d));
        }
      }).catch(() => {});
    }
  }

  function reverseDialog(j, parent) {
    formDialog({
      title: `Reverse ${j.number}`,
      intro: "Adds a new entry that is the exact opposite and points at this one. The original stays. This can be done once.",
      submit: "Reverse entry",
      body: row("reason", "Why is it being reversed?", input("reason", 'maxlength="200"')),
      async onSubmit(form, { show, close }) {
        const parsed = reverseJournalInput.safeParse({ journalId: j.id, reason: /** @type {any} */ (form.elements).reason.value });
        if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
        const r = await call("reverseJournal", parsed.data);
        close();
        parent.close();
        toast(`${r.number} posted.`);
        load(true);
      },
    });
  }

  function newDialog() {
    const key = newKey();
    const lines = [{}, {}];
    formDialog({
      title: "New journal entry",
      intro: "Enter debits and credits that balance. Save as a draft to finish later, or post it now.",
      submit: "Post entry",
      wide: true,
      body: `${row("date", "Date", input("date", `type="date" value="${today()}" max="${today()}"`))}
        ${row("memo", "Description", input("memo", 'maxlength="300"'))}
        <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Account code</th><th>Debit (Rs)</th><th>Credit (Rs)</th><th>Note</th></tr></thead><tbody data-lines></tbody></table></div>
        <p><button type="button" class="btn btn--ghost" data-addline>Add a line</button> <button type="button" class="btn btn--ghost" data-draft>Save as draft</button></p>
        <p class="muted" data-totals></p><div data-field="lines"><p class="field-error" hidden></p></div>`,
      onOpen(form) {
        const body = form.querySelector("[data-lines]");
        const totals = form.querySelector("[data-totals]");
        const draw = () => {
          body.innerHTML = lines.map((_, i) => `<tr><td><input name="ac-${i}" inputmode="numeric" maxlength="6" aria-label="Account code" /></td><td><input name="dr-${i}" inputmode="decimal" aria-label="Debit" /></td><td><input name="cr-${i}" inputmode="decimal" aria-label="Credit" /></td><td><input name="nt-${i}" maxlength="200" aria-label="Note" /></td></tr>`).join("");
        };
        const sum = () => {
          const f = /** @type {any} */ (form.elements);
          let dr = 0;
          let cr = 0;
          lines.forEach((_, i) => {
            dr += toPaisa(f[`dr-${i}`].value) || 0;
            cr += toPaisa(f[`cr-${i}`].value) || 0;
          });
          totals.textContent = `Debits ${money(dr)} · Credits ${money(cr)}${dr === cr && dr ? " · balanced" : ` · difference ${money(Math.abs(dr - cr))}`}`;
        };
        draw();
        form.addEventListener("input", sum);
        form.querySelector("[data-addline]").addEventListener("click", () => {
          const keep = [...form.querySelectorAll("[name]")].map((n) => [n.getAttribute("name"), /** @type {any} */ (n).value]);
          lines.push({});
          draw();
          keep.forEach(([n, v]) => {
            const e = /** @type {any} */ (form.elements.namedItem(n));
            if (e && /^(ac|dr|cr|nt)-/.test(n)) e.value = v;
          });
        });
        form.querySelector("[data-draft]").addEventListener("click", () => {
          form.dataset.draft = "1";
          form.requestSubmit();
        });
      },
      async onSubmit(form, { show, close }) {
        const f = /** @type {any} */ (form.elements);
        const asDraft = form.dataset.draft === "1";
        form.dataset.draft = "";
        const built = lines.map((_, i) => ({ accountCode: f[`ac-${i}`].value.trim(), debit: toPaisa(f[`dr-${i}`].value) ?? 0, credit: toPaisa(f[`cr-${i}`].value) ?? 0, memo: f[`nt-${i}`].value })).filter((l) => l.accountCode || l.debit || l.credit);
        if (built.some((l) => Number.isNaN(l.debit) || Number.isNaN(l.credit))) return show("Enter amounts in rupees, e.g. 12500.");
        const parsed = createJournalInput.safeParse({ idempotencyKey: key, date: f.date.value, memo: f.memo.value, lines: built, post: !asDraft });
        if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
        const r = await call("createJournal", parsed.data);
        close();
        toast(r.status === "posted" ? `${r.number} posted.` : "Draft saved.");
        load(true);
      },
    });
  }

  main.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("[data-new]")) return newDialog();
    const v = t.closest("[data-view]");
    if (v) {
      const j = rows.get(/** @type {HTMLElement} */ (v).dataset.view);
      if (j) viewDialog(j);
      return;
    }
    const retry = t.closest("[data-retry-post]");
    if (retry && (await confirmDialog({ title: "Retry this posting?", body: "It is posted with the same amounts as when the event happened, if the accounts are now usable.", confirm: "Retry" }))) {
      try {
        const r = await call("retryPosting", { id: /** @type {HTMLElement} */ (retry).dataset.retryPost });
        toast(r.status === "posted" ? `${r.number} posted.` : "Already posted.");
        loadFailed();
        load(true);
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
    }
  });
  await Promise.all([load(true), loadFailed()]);
}
