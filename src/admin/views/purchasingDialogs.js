/**
 * Dialogs and pieces used by more than one purchasing screen: record a supplier payment (and print its
 * receipt), receive goods against a purchase order, return goods to a supplier, and the supplier ledger table.
 */
import { esc } from "../../lib/format.js";
import { toast, dataTable, formatWhen, errorState } from "../ui/kit.js";
import { toPaisa } from "../ui/money.js";
import { money, formDialog, row, input, select, newKey, today, printDocument } from "../ui/purchasing.js";
import { call, pageOf, listSuppliers } from "../purchData.js";
import { receiveGoodsInput, supplierPaymentInput, purchaseReturnInput, supplierRefundInput, supplierAdjustmentInput, fieldErrors } from "../../../shared/schemas/index.js";
import { SUPPLIER_PAY_LABEL, SUPPLIER_PAY_METHODS } from "../../../shared/purchase.js";

const whenOf = (t) => (t?.toDate ? formatWhen(t) : "—");
const dateOf = (t) => (t?.toDate ? t.toDate().toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }) : "—");

/* ───────── Supplier payment ───────── */

/**
 * @param {{ supplier?: any, purchaseOrder?: any, canAdvance?: boolean, onDone?: (r: any) => void }} o
 * Without `supplier`, the dialog asks which supplier (only those the store owes money).
 */
export async function paymentDialog({ supplier = null, purchaseOrder = null, canAdvance = false, onDone = () => {} }) {
  const owing = supplier ? [supplier] : (await listSuppliers(true)).filter((s) => canAdvance || (s.balance ?? 0) > 0);
  if (!owing.length) {
    toast("No supplier is owed any money right now.", "error");
    return;
  }
  const key = newKey();
  const poOwes = purchaseOrder ? (purchaseOrder.receivedValue ?? 0) - (purchaseOrder.returnedValue ?? 0) - (purchaseOrder.paidTotal ?? 0) : null;
  formDialog({
    title: "Record a supplier payment",
    intro: "This <strong>records</strong> a payment you made yourself — cash handed over, or a bank, JazzCash or Easypaisa transfer you did in their own app. Nothing is sent or charged from here.",
    submit: "Record payment",
    body: `
      ${supplier ? `<p><strong>${esc(supplier.name)}</strong> · owed now: <strong>${money(supplier.balance ?? 0)}</strong>${purchaseOrder ? `<br /><span class="muted">${esc(purchaseOrder.number)} still owes ${money(Math.max(0, poOwes))}</span>` : ""}</p>` : row("supplierId", "Supplier", select("supplierId", owing.map((s) => [s.id, `${s.name} — owed ${money(s.balance ?? 0)}`])))}
      ${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal" autocomplete="off"'), "The most you can pay is what is owed")}
      ${row("method", "How was it paid?", select("method", SUPPLIER_PAY_METHODS.map((m) => [m, SUPPLIER_PAY_LABEL[m]])))}
      ${row("reference", "Reference / transaction number", input("reference", 'maxlength="80" autocomplete="off"'), "Needed for bank, JazzCash and Easypaisa")}
      ${row("paidAt", "Date paid", input("paidAt", `type="date" value="${today()}" max="${today()}"`))}
      ${canAdvance && !purchaseOrder ? `<label class="check"><input type="checkbox" name="advance" /> <span>Advance payment — more than is owed (the supplier then holds a credit with you)</span></label>` : ""}
      ${row("note", "Note (optional)", input("note", 'maxlength="300"'))}`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const amount = toPaisa(f.amount.value);
      const parsed = supplierPaymentInput.safeParse({
        idempotencyKey: key,
        supplierId: supplier?.id ?? f.supplierId.value,
        purchaseOrderId: purchaseOrder?.id ?? null,
        amount: amount ?? 0,
        method: f.method.value,
        reference: f.reference.value,
        paidAt: f.paidAt.value,
        note: f.note.value,
        advance: Boolean(f.advance?.checked),
      });
      if (!parsed.success || Number.isNaN(amount)) return show("Please check the highlighted fields.", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(Number.isNaN(amount) ? { amount: "Enter an amount in rupees, e.g. 12500" } : {}) });
      const r = await call("recordSupplierPayment", parsed.data);
      close();
      toast(`${r.number} recorded.`);
      onDone(r);
    },
  });
}

/** Printable receipt for a recorded supplier payment. @param {any} p @param {string} [storeName] */
export function printPaymentReceipt(p, storeName = "") {
  const ok = printDocument(
    `Payment ${p.number}`,
    `<h1>${esc(storeName || "Payment receipt")}</h1><p class="muted">Payment voucher — supplier payment (recorded)</p>
     <h2>${esc(p.number)}</h2>
     <table><tr><th>Paid to</th><td>${esc(p.supplierName)}</td></tr>
       <tr><th>Date paid</th><td>${esc(dateOf(p.paidAt))}</td></tr>
       <tr><th>Method</th><td>${esc(p.methodLabel ?? SUPPLIER_PAY_LABEL[p.method] ?? p.method)}</td></tr>
       ${p.reference ? `<tr><th>Reference</th><td>${esc(p.reference)}</td></tr>` : ""}
       ${p.purchaseOrderNumber ? `<tr><th>Against</th><td>${esc(p.purchaseOrderNumber)}</td></tr>` : ""}
       ${p.note ? `<tr><th>Note</th><td>${esc(p.note)}</td></tr>` : ""}
       <tr><th>Amount</th><td class="big">${esc(money(p.amount))}</td></tr></table>
     <p class="muted">Recorded ${esc(whenOf(p.createdAt))}. This is a record of a payment made outside the system.</p>
     <div class="sign"><span>Paid by</span><span>Received by</span></div>`,
  );
  if (!ok) toast("Allow pop-ups for this site to print.", "error");
}

/* ───────── Receive goods ───────── */

/** @param {any} po a purchase order (status ordered or partially_received) @param {(r: any) => void} [onDone] */
export function receiveDialog(po, onDone = () => {}) {
  const key = newKey();
  const open = po.lines.map((l, i) => ({ l, i, pending: l.qty - l.receivedQty - l.rejectedQty })).filter((x) => x.pending > 0);
  if (!open.length) {
    toast("Everything on this order has already been received.", "error");
    return;
  }
  formDialog({
    title: `Receive goods — ${po.number}`,
    intro: `From ${esc(po.supplierName)} into <strong>${esc(po.warehouseName)}</strong>. Only the <strong>accepted</strong> pairs are added to stock and owed for. Damaged or rejected pairs are recorded separately and are not stocked.`,
    submit: "Receive",
    wide: true,
    body: `
      <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Item</th><th>Pending</th><th>Accepted</th><th>Rejected / damaged</th><th>What happened</th><th>Reason if rejected</th></tr></thead><tbody>
      ${open.map((x) => `<tr><td>${esc(x.l.productName)}<br /><span class="muted">${esc(x.l.variantLabel)} · <code>${esc(x.l.sku ?? "")}</code></span></td><td>${x.pending}<br /><span class="muted">of ${x.l.qty}</span></td>
        <td><input name="acc-${x.i}" type="number" min="0" max="${x.pending}" step="1" value="${x.pending}" aria-label="Accepted ${esc(x.l.productName)}" /></td>
        <td><input name="rej-${x.i}" type="number" min="0" max="${x.pending}" step="1" value="0" aria-label="Rejected ${esc(x.l.productName)}" /></td>
        <td><select name="kind-${x.i}" aria-label="What happened"><option value="damaged">Damaged</option><option value="missing">Missing</option><option value="wrong_item">Wrong size / item</option></select></td>
        <td><input name="why-${x.i}" maxlength="200" aria-label="Reason" /></td></tr>`).join("")}
      </tbody></table></div>
      <div data-field="lines"><p class="field-error" hidden></p></div>
      ${row("supplierInvoiceNo", "Supplier's invoice / delivery note no. (optional)", input("supplierInvoiceNo", 'maxlength="60"'))}
      ${row("receivedDate", "Date received", input("receivedDate", `type="date" value="${today()}" max="${today()}"`))}
      ${row("note", "Note (optional)", input("note", 'maxlength="300"'))}`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const lines = open.map((x) => ({ lineIndex: x.i, acceptedQty: Number(f[`acc-${x.i}`].value || 0), rejectedQty: Number(f[`rej-${x.i}`].value || 0), rejectReason: f[`why-${x.i}`].value, rejectKind: f[`kind-${x.i}`].value })).filter((l) => l.acceptedQty + l.rejectedQty > 0);
      const parsed = receiveGoodsInput.safeParse({ idempotencyKey: key, purchaseOrderId: po.id, lines, supplierInvoiceNo: f.supplierInvoiceNo.value, receivedDate: f.receivedDate.value || undefined, note: f.note.value });
      if (!parsed.success) return show("Please check the quantities.", fieldErrors(parsed.error));
      const r = await call("receiveGoods", parsed.data);
      close();
      toast(r.existing ? `${r.number} was already recorded.` : `${r.number} received — stock updated.`);
      onDone(r);
    },
  });
}

/* ───────── Return goods to a supplier ───────── */

/** @param {{ grn?: any, onDone?: (r: any) => void }} o */
export async function returnDialog({ grn = null, onDone = () => {} }) {
  const key = newKey();
  let suppliers = [];
  if (!grn) {
    suppliers = (await listSuppliers(true)).filter((s) => (s.totalPurchased ?? 0) > 0);
    if (!suppliers.length) {
      toast("No goods have been received from any supplier yet, so there is nothing to return.", "error");
      return;
    }
  }
  /** @type {any[]} */
  let receipts = grn ? [grn] : [];
  let current = grn;
  const linesHtml = (g) => {
    const rows = (g?.lines ?? []).map((l, i) => ({ l, i, returnable: l.acceptedQty - (l.returnedQty ?? 0) })).filter((x) => x.returnable > 0);
    return rows.length
      ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Item</th><th>Received</th><th>Can return</th><th>Return</th></tr></thead><tbody>${rows
          .map((x) => `<tr><td>${esc(x.l.productName)}<br /><span class="muted">${esc(x.l.variantLabel)} · <code>${esc(x.l.sku ?? "")}</code></span></td><td>${x.l.acceptedQty}</td><td>${x.returnable}</td><td><input name="ret-${x.i}" type="number" min="0" max="${x.returnable}" step="1" value="0" aria-label="Return ${esc(x.l.productName)}" /></td></tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="muted">${g ? "Everything on this receipt has already been returned." : "Choose a goods receipt."}</p>`;
  };
  const d = formDialog({
    title: "Return goods to a supplier",
    intro: "Takes the pairs out of the warehouse they were received into and reduces what you owe the supplier by what they were valued at.",
    submit: "Record return",
    wide: true,
    body: `
      ${grn ? `<p><strong>${esc(grn.number)}</strong> · ${esc(grn.supplierName)} · ${esc(grn.warehouseName)}</p>` : `${row("supplierId", "Supplier", select("supplierId", [["", "Choose…"], ...suppliers.map((s) => [s.id, s.name])]))}${row("grnId", "Goods receipt", select("grnId", [["", "Choose a supplier first"]]))}`}
      <div data-lines>${linesHtml(grn)}</div>
      <div data-field="lines"><p class="field-error" hidden></p></div>
      ${row("reason", "Reason for the return", input("reason", 'maxlength="200"'))}
      ${row("supplierReference", "Supplier's return / credit-note no. (optional)", input("supplierReference", 'maxlength="80"'))}`,
    onOpen(form) {
      if (grn) return;
      const f = /** @type {any} */ (form.elements);
      f.supplierId.addEventListener("change", async () => {
        f.grnId.innerHTML = `<option value="">Loading…</option>`;
        receipts = f.supplierId.value ? (await pageOf("goodsReceipts", { where: [["supplierId", "==", f.supplierId.value]], size: 50 }).catch(() => ({ rows: [] }))).rows : [];
        f.grnId.innerHTML = `<option value="">Choose…</option>${receipts.map((g) => `<option value="${esc(g.id)}">${esc(g.number)} · ${esc(dateOf(g.createdAt))} · ${esc(g.purchaseOrderNumber)}</option>`).join("")}`;
        current = null;
        form.querySelector("[data-lines]").innerHTML = linesHtml(null);
      });
      f.grnId.addEventListener("change", () => {
        current = receipts.find((g) => g.id === f.grnId.value) ?? null;
        form.querySelector("[data-lines]").innerHTML = linesHtml(current);
      });
    },
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      if (!current) return show("Choose the goods receipt first.");
      const lines = current.lines.map((l, i) => ({ lineIndex: i, qty: Number(f[`ret-${i}`]?.value || 0) })).filter((l) => l.qty > 0);
      const parsed = purchaseReturnInput.safeParse({ idempotencyKey: key, grnId: current.id, reason: f.reason.value, supplierReference: f.supplierReference.value, lines });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      const r = await call("createPurchaseReturn", parsed.data);
      close();
      toast(r.existing ? `${r.number} was already recorded.` : `${r.number} recorded — ${money(r.value)} off what you owe.`);
      onDone(r);
    },
  });
  return d;
}

/* ───────── Supplier ledger ───────── */

const LEDGER_TYPE = { opening: "Opening balance", purchase: "Goods received", payment: "Payment", return: "Return (credit note)", refund: "Refund from supplier", adjustment: "Adjustment" };

/**
 * Ledger table for one supplier, newest first, one page at a time. debit reduces what is owed, credit increases it.
 * @param {HTMLElement} box @param {string} supplierId
 */
export function ledgerView(box, supplierId) {
  const table = dataTable({
    caption: "Supplier ledger",
    empty: { title: "No ledger entries yet", text: "Entries appear when goods are received, paid for or returned." },
    columns: [
      { key: "at", label: "Date", render: (r) => esc(whenOf(r.at)) },
      { key: "type", label: "Entry", render: (r) => `${esc(LEDGER_TYPE[r.type] ?? r.type)}<br /><span class="muted">${esc(r.refNumber)}${r.note ? ` · ${esc(r.note)}` : ""}</span>` },
      { key: "debit", label: "Debit (paid / returned)", render: (r) => (r.debit ? esc(money(r.debit)) : "—") },
      { key: "credit", label: "Credit (owed)", render: (r) => (r.credit ? esc(money(r.credit)) : "—") },
      { key: "balanceAfter", label: "Balance owed", render: (r) => `<strong>${esc(money(r.balanceAfter))}</strong>` },
    ],
  });
  let last = null;
  const load = async (reset) => {
    try {
      const page = await pageOf("supplierLedger", { where: [["supplierId", "==", supplierId]], orderBy: ["at", "desc"], after: reset ? null : last });
      last = page.last;
      if (reset) table.set(page.rows, page.hasMore);
      else table.append(page.rows, page.hasMore);
      if (!box.contains(table.el)) box.replaceChildren(table.el);
    } catch {
      box.innerHTML = errorState();
      box.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  };
  table.onMore(() => load(false));
  box.innerHTML = `<p class="muted">Loading…</p>`;
  return load(true);
}

/* ───────── Refund from a supplier, and balance adjustments ───────── */

/** The supplier gives money back (they owe the store after an advance or a return). @param {{ supplier: any, onDone?: (r: any) => void }} o */
export function refundDialog({ supplier, onDone = () => {} }) {
  const owed = -(supplier.balance ?? 0);
  if (owed <= 0) return toast(`${supplier.name} doesn't owe the store anything.`, "error");
  const key = newKey();
  formDialog({
    title: "Record a refund from the supplier",
    intro: `${esc(supplier.name)} holds a credit of <strong>${money(owed)}</strong> with you. This <strong>records</strong> money they gave back (cash received, or a transfer into your account); nothing is sent from here.`,
    submit: "Record refund",
    body: `
      ${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal" autocomplete="off"'), "At most their credit")}
      ${row("method", "How was it received?", select("method", SUPPLIER_PAY_METHODS.map((m) => [m, SUPPLIER_PAY_LABEL[m]])))}
      ${row("reference", "Reference / transaction number", input("reference", 'maxlength="80" autocomplete="off"'), "Needed for bank, JazzCash and Easypaisa")}
      ${row("receivedAt", "Date received", input("receivedAt", `type="date" value="${today()}" max="${today()}"`))}
      ${row("note", "Note (optional)", input("note", 'maxlength="300"'))}`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const amount = toPaisa(f.amount.value);
      const parsed = supplierRefundInput.safeParse({ idempotencyKey: key, supplierId: supplier.id, amount: amount ?? 0, method: f.method.value, reference: f.reference.value, receivedAt: f.receivedAt.value, note: f.note.value });
      if (!parsed.success || Number.isNaN(amount)) return show("Please check the highlighted fields.", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(Number.isNaN(amount) ? { amount: "Enter an amount in rupees" } : {}) });
      const r = await call("recordSupplierRefund", parsed.data);
      close();
      toast(`${r.number} recorded.`);
      onDone(r);
    },
  });
}

/** A manual correction to what is owed, posted against an account the person chooses. @param {{ supplier: any, onDone?: (r: any) => void }} o */
export async function adjustmentDialog({ supplier, onDone = () => {} }) {
  const key = newKey();
  /** @type {[string, string][]} */
  let accounts = [];
  try {
    const p = await pageOf("accounts", { orderBy: ["code", "asc"], size: 300 });
    accounts = p.rows.filter((a) => !a.isGroup && a.isActive !== false && a.role !== "accounts_payable").map((a) => [a.code, `${a.code} ${a.name}`]);
  } catch {
    /* the person can type the code instead */
  }
  formDialog({
    title: "Adjust the supplier's balance",
    intro: `Use this for a discount the supplier allowed, a correction, or a charge not on a goods receipt. <strong>Increase</strong> = you owe more. <strong>Decrease</strong> = you owe less. The other side is posted to the account you choose (for example Purchase Returns &amp; Allowances). Every adjustment is kept in the ledger and the audit log.`,
    submit: "Post adjustment",
    body: `
      ${row("direction", "Change", select("direction", [["decrease", "Decrease what we owe"], ["increase", "Increase what we owe"]]))}
      ${row("amount", "Amount (Rs)", input("amount", 'inputmode="decimal" autocomplete="off"'))}
      ${row("accountCode", "Post the other side to", accounts.length ? select("accountCode", accounts) : input("accountCode", 'inputmode="numeric" placeholder="Account code"'))}
      ${row("reason", "Reason", input("reason", 'maxlength="200"'))}
      ${row("date", "Date", input("date", `type="date" value="${today()}" max="${today()}"`))}`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const amount = toPaisa(f.amount.value);
      const parsed = supplierAdjustmentInput.safeParse({ idempotencyKey: key, supplierId: supplier.id, direction: f.direction.value, amount: amount ?? 0, accountCode: f.accountCode.value, reason: f.reason.value, date: f.date.value });
      if (!parsed.success || Number.isNaN(amount)) return show("Please check the highlighted fields.", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(Number.isNaN(amount) ? { amount: "Enter an amount in rupees" } : {}) });
      const r = await call("recordSupplierAdjustment", parsed.data);
      close();
      toast(`${r.number} posted.`);
      onDone(r);
    },
  });
}
