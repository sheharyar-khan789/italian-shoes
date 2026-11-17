/**
 * Suppliers: the list (searchable, paged) and one supplier's page with details, ledger, purchase orders and
 * payments. The balance is what the store owes the supplier now, taken from the ledger the server keeps.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState, dataTable, formatWhen } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, formDialog, row, input, tag, PO_STATUS, PAY_STATUS } from "../ui/purchasing.js";
import { call, pageOf, getRow, forgetSuppliers } from "../purchData.js";
import { saveSupplierInput, fieldErrors } from "../../../shared/schemas/index.js";
import { paymentDialog, ledgerView, printPaymentReceipt, refundDialog, adjustmentDialog } from "./purchasingDialogs.js";
import { loadSettings } from "../data.js";
import { uploadReceipt } from "../financeUi.js";
import { privateFileButton, wirePrivateFiles } from "../privateFileUi.js";

const dateOf = (t) => (t?.toDate ? formatWhen(t) : "—");

/** Add or edit a supplier. @param {any | null} existing @param {(id: string) => void} onDone */
function supplierDialog(existing, onDone) {
  const v = existing ?? { name: "", contactPerson: "", phone: "", whatsapp: "", taxNumber: "", documents: [], email: "", address: "", notes: "", openingBalance: 0 };
  const docs = [...(v.documents ?? [])];
  formDialog({
    title: existing ? "Edit supplier" : "Add a supplier",
    submit: existing ? "Save changes" : "Add supplier",
    body: `
      ${row("name", "Business name", input("name", `maxlength="120" value="${esc(v.name)}"`))}
      ${row("contactPerson", "Contact person (optional)", input("contactPerson", `maxlength="120" value="${esc(v.contactPerson ?? "")}"`))}
      ${row("phone", "Phone (optional)", input("phone", `maxlength="30" value="${esc(v.phone ?? "")}" inputmode="tel"`))}
      ${row("whatsapp", "WhatsApp (optional)", input("whatsapp", `maxlength="30" value="${esc(v.whatsapp ?? "")}" inputmode="tel"`))}
      ${row("email", "Email (optional)", input("email", `type="email" maxlength="254" value="${esc(v.email ?? "")}"`))}
      ${row("address", "Address (optional)", input("address", `maxlength="300" value="${esc(v.address ?? "")}"`))}
      ${row("taxNumber", "Tax number — NTN / STRN (optional)", input("taxNumber", `maxlength="40" value="${esc(v.taxNumber ?? "")}"`))}
      <div class="field"><label for="pd-file">Documents — agreements, price lists (PDF or image, up to 5 MB)</label><input id="pd-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /><p class="field-hint" data-files>${docs.map((d) => esc(d.name)).join(", ")}</p></div>
      ${row("notes", "Notes (optional)", input("notes", `maxlength="1000" value="${esc(v.notes ?? "")}"`))}
      ${existing ? `<p class="muted">Opening balance: <strong>${money(v.openingBalance ?? 0)}</strong> (fixed once saved — it is the first ledger entry).</p>` : row("openingBalance", "Opening balance — what you already owe them (Rs)", input("openingBalance", 'inputmode="decimal" placeholder="0"'), "Leave empty if you owe them nothing")}`,
    onOpen(form) {
      const file = /** @type {HTMLInputElement | null} */ (form.querySelector("#pd-file"));
      file?.addEventListener("change", async () => {
        const picked = file.files?.[0];
        if (!picked) return;
        const note = /** @type {HTMLElement} */ (form.querySelector("[data-files]"));
        note.textContent = "Uploading…";
        try {
          docs.push(await uploadReceipt(picked));
          note.textContent = docs.map((d) => d.name).join(", ");
        } catch (err) {
          note.textContent = /** @type {Error} */ (err).message || "Upload failed.";
        }
        file.value = "";
      });
    },
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const opening = existing ? 0 : toPaisa(f.openingBalance.value) ?? 0;
      const parsed = saveSupplierInput.safeParse({ ...(existing ? { id: existing.id } : {}), name: f.name.value, contactPerson: f.contactPerson.value, phone: f.phone.value, email: f.email.value, address: f.address.value, whatsapp: f.whatsapp.value, taxNumber: f.taxNumber.value, documents: docs, notes: f.notes.value, openingBalance: opening });
      if (!parsed.success || Number.isNaN(opening)) return show("Please check the highlighted fields.", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(Number.isNaN(opening) ? { openingBalance: "Enter an amount in rupees, e.g. 12500" } : {}) });
      const r = await call("saveSupplier", parsed.data);
      forgetSuppliers();
      close();
      toast(existing ? "Saved." : "Supplier added.");
      onDone(r.id);
    },
  });
}

export default async function suppliers({ main, user, params, navigate }) {
  const canManage = user.perms.includes("suppliers.manage");
  const canPay = user.perms.includes("suppliers.pay");
  const canAdjust = user.perms.includes("suppliers.adjust");
  if (params[0]) return detail(params[0]);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Sup<em>pliers</em></h1>
        <p class="muted">The people and businesses you buy from, and what you owe each of them.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>Add supplier</span></button></p>` : ""}
      </header>
      <div class="adm-filters"><label class="visually-hidden" for="sup-search">Search</label><input id="sup-search" type="search" placeholder="Search by name (starts with…)" /></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const listEl = main.querySelector("[data-list]");
  const searchEl = /** @type {HTMLInputElement} */ (main.querySelector("#sup-search"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  let last = null;
  let ticket = 0;

  const table = dataTable({
    caption: "Suppliers",
    empty: { title: "No suppliers yet", text: canManage ? "Add the first one with “Add supplier”." : "" },
    columns: [
      { key: "name", label: "Supplier", render: (r) => `<a class="text-link" href="/admin/suppliers/${esc(r.id)}" data-link><strong>${esc(r.name)}</strong></a>${r.contactPerson ? `<br /><span class="muted">${esc(r.contactPerson)}</span>` : ""}` },
      { key: "phone", label: "Phone", render: (r) => esc(r.phone || "—") },
      { key: "isActive", label: "Status", render: (r) => (r.isActive === false ? `<span class="tag tag--out">Off</span>` : `<span class="tag">On</span>`) },
      { key: "balance", label: "We owe", render: (r) => `<strong>${esc(money(r.balance ?? 0))}</strong>` },
    ],
  });
  async function load(reset = true) {
    const mine = ++ticket;
    const q = searchEl.value.trim().toLowerCase();
    try {
      const page = await pageOf("suppliers", { where: q ? [["nameLower", ">=", q], ["nameLower", "<=", `${q}`]] : [], orderBy: ["nameLower", "asc"], after: reset ? null : last });
      if (mine !== ticket || !alive()) return;
      last = page.last;
      if (reset) table.set(page.rows, page.hasMore);
      else table.append(page.rows, page.hasMore);
      if (!listEl.contains(table.el)) listEl.replaceChildren(table.el);
    } catch {
      if (!alive()) return;
      listEl.innerHTML = errorState();
      listEl.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }
  table.onMore(() => load(false));
  let timer;
  searchEl.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(true), 350);
  });
  main.querySelector("[data-new]")?.addEventListener("click", () => supplierDialog(null, (id) => navigate(`/admin/suppliers/${id}`)));
  await load(true);

  /* ───── One supplier ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    const draw = async () => {
      let s;
      try {
        s = await getRow("suppliers", id);
      } catch {
        page.innerHTML = errorState();
        page.querySelector("[data-retry]")?.addEventListener("click", draw);
        return;
      }
      if (!s) {
        page.innerHTML = `<p>That supplier doesn't exist. <a class="text-link" href="/admin/suppliers" data-link>Back to suppliers</a></p>`;
        return;
      }
      page.innerHTML = `
        <p><a class="text-link" href="/admin/suppliers" data-link>← Suppliers</a></p>
        <header class="adm-page__head">
          <h1 class="adm-h1">${esc(s.name)} ${s.isActive === false ? `<span class="tag tag--out">Off</span>` : ""}</h1>
          <p>We owe: <strong>${esc(money(s.balance ?? 0))}</strong>${(s.balance ?? 0) < 0 ? ` <span class="muted">(they owe us)</span>` : ""}</p>
          <p>
            ${canPay && ((s.balance ?? 0) > 0 || canAdjust) ? `<button type="button" class="btn btn--primary" data-pay><span>${(s.balance ?? 0) > 0 ? "Record payment" : "Advance payment"}</span></button> ` : ""}
            ${canAdjust && (s.balance ?? 0) < 0 ? `<button type="button" class="btn btn--ghost" data-refund>Record refund</button> ` : ""}
            ${canAdjust ? `<button type="button" class="btn btn--ghost" data-adjust>Adjust balance</button> ` : ""}
            ${canManage ? `<button type="button" class="btn btn--ghost" data-edit>Edit</button> <button type="button" class="btn btn--ghost" data-toggle>${s.isActive === false ? "Switch on" : "Switch off"}</button>` : ""}
          </p>
        </header>
        <div class="adm-tabs" role="tablist" aria-label="Supplier">
          ${["Details", "Ledger", "Purchase orders", "Payments"].map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${t}</button>`).join("")}
        </div>
        <div data-panel></div>`;
      const panel = /** @type {HTMLElement} */ (page.querySelector("[data-panel]"));
      const tabs = [
        () => {
          panel.innerHTML = `<dl class="adm-card adm-details">
            <dt>Contact person</dt><dd>${esc(s.contactPerson || "—")}</dd><dt>Phone</dt><dd>${esc(s.phone || "—")}</dd><dt>WhatsApp</dt><dd>${esc(s.whatsapp || "—")}</dd><dt>Tax number</dt><dd>${esc(s.taxNumber || "—")}</dd>
            <dt>Documents</dt><dd>${(s.documents ?? []).length ? s.documents.map((d) => privateFileButton(d.url, d.name)).join(" · ") : "—"}</dd><dt>Email</dt><dd>${esc(s.email || "—")}</dd>
            <dt>Address</dt><dd>${esc(s.address || "—")}</dd><dt>Notes</dt><dd>${esc(s.notes || "—")}</dd>
            <dt>Opening balance</dt><dd>${esc(money(s.openingBalance ?? 0))}</dd><dt>Total purchased</dt><dd>${esc(money(s.totalPurchased ?? 0))}</dd>
            <dt>Total returned</dt><dd>${esc(money(s.totalReturned ?? 0))}</dd><dt>Total paid</dt><dd>${esc(money(s.totalPaid ?? 0))}</dd></dl>`;
          wirePrivateFiles(panel);
        },
        () => ledgerView(panel, id),
        () => pagedList(panel, "purchaseOrders", id, "Purchase orders", [
          { key: "number", label: "Order", render: (r) => `<a class="text-link" href="/admin/purchase-orders/${esc(r.id)}" data-link>${esc(r.number)}</a>` },
          { key: "createdAt", label: "Date", render: (r) => esc(dateOf(r.createdAt)) },
          { key: "total", label: "Total", render: (r) => esc(money(r.total)) },
          { key: "status", label: "Status", render: (r) => tag(PO_STATUS, r.status) },
          { key: "paymentStatus", label: "Payment", render: (r) => (r.receivedValue ? tag(PAY_STATUS, r.paymentStatus) : "—") },
        ]),
        () => pagedList(panel, "supplierPayments", id, "Supplier payments", [
          { key: "number", label: "Payment", render: (r) => esc(r.number) },
          { key: "paidAt", label: "Date paid", render: (r) => esc(r.paidAt?.toDate ? r.paidAt.toDate().toLocaleDateString("en-PK") : "—") },
          { key: "amount", label: "Amount", render: (r) => `<strong>${esc(money(r.amount))}</strong>` },
          { key: "method", label: "Method", render: (r) => esc(`${r.methodLabel ?? r.method}${r.reference ? ` · ${r.reference}` : ""}`) },
          { key: "actions", label: "", render: (r) => `<button type="button" class="text-btn" data-print="${esc(r.id)}">Print receipt</button>` },
        ]),
      ];
      tabs[0]();
      page.querySelector(".adm-tabs").addEventListener("click", (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
        if (!b) return;
        page.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        tabs[Number(/** @type {HTMLElement} */ (b).dataset.tab)]();
      });
      page.querySelector("[data-pay]")?.addEventListener("click", () => paymentDialog({ supplier: s, canAdvance: canAdjust, onDone: draw }));
      page.querySelector("[data-refund]")?.addEventListener("click", () => refundDialog({ supplier: s, onDone: draw }));
      page.querySelector("[data-adjust]")?.addEventListener("click", () => adjustmentDialog({ supplier: s, onDone: draw }));
      page.querySelector("[data-edit]")?.addEventListener("click", () => supplierDialog(s, draw));
      page.querySelector("[data-toggle]")?.addEventListener("click", async () => {
        const turnOn = s.isActive === false;
        if (!turnOn && !(await confirmDialog({ title: `Switch off ${s.name}?`, body: "No new purchase orders can be made for a switched-off supplier. History, the ledger and payments stay.", confirm: "Switch off" }))) return;
        try {
          await call("setSupplierActive", { id, isActive: turnOn });
          forgetSuppliers();
          toast(turnOn ? "Supplier is on." : "Supplier is off.");
          draw();
        } catch (error) {
          toast(/** @type {Error} */ (error).message, "error");
        }
      });
    };

    /** A paged list of one supplier's records from a collection. */
    async function pagedList(box, collection, supplierId, caption, columns) {
      const table = dataTable({ caption, empty: { title: "Nothing yet" }, columns });
      let after = null;
      const rows = new Map();
      const loadPage = async (reset) => {
        try {
          const p = await pageOf(collection, { where: [["supplierId", "==", supplierId]], after: reset ? null : after });
          after = p.last;
          p.rows.forEach((r) => rows.set(r.id, r));
          if (reset) table.set(p.rows, p.hasMore);
          else table.append(p.rows, p.hasMore);
          if (!box.contains(table.el)) box.replaceChildren(table.el);
        } catch {
          box.innerHTML = errorState();
          box.querySelector("[data-retry]")?.addEventListener("click", () => loadPage(true));
        }
      };
      table.onMore(() => loadPage(false));
      box.innerHTML = `<p class="muted">Loading…</p>`;
      box.onclick = async (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest("[data-print]");
        if (!b) return;
        const settings = await loadSettings().catch(() => ({ public: null }));
        printPaymentReceipt(rows.get(/** @type {HTMLElement} */ (b).dataset.print), settings.public?.storeName);
      };
      await loadPage(true);
    }
    await draw();
  }
}
