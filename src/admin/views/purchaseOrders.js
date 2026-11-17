/**
 * Purchase orders: a paged list, and one order's page (lines with ordered / received / rejected / pending
 * quantities, money, goods received, payments). Drafts are edited here; approving, receiving goods, closing,
 * cancelling and paying all go through the server, which recalculates every amount.
 */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState, dataTable, formatWhen } from "../ui/kit.js";
import { toPaisa, rupeesField } from "../ui/money.js";
import { money, formDialog, row, input, select, tag, PO_STATUS, PAY_STATUS } from "../ui/purchasing.js";
import { call, pageOf, getRow, listSuppliers } from "../purchData.js";
import { listWarehouses, listProducts, listVariants, VIRTUAL_DEFAULT_WAREHOUSE } from "../catalogData.js";
import { savePurchaseOrderInput, fieldErrors, DEFAULT_WAREHOUSE_ID } from "../../../shared/schemas/index.js";
import { priceOrder } from "../../../shared/purchase.js";
import { uploadReceipt } from "../financeUi.js";
import { privateFileButton, wirePrivateFiles } from "../privateFileUi.js";
import { receiveDialog, paymentDialog, printPaymentReceipt } from "./purchasingDialogs.js";
import { loadSettings } from "../data.js";

const dateOf = (t) => (t?.toDate ? formatWhen(t) : "—");
/** @type {any[] | null} */
let productCache = null;

/** New purchase order, or edit a draft. @param {any | null} existing @param {(id: string) => void} onDone */
/** The additional charges typed into the form (rows with an amount). @param {any} f */
function readCharges(f) {
  return [0, 1, 2]
    .map((i) => ({ label: String(f[`chargeLabel${i}`].value || "").trim() || "Additional charge", amount: toPaisa(f[`chargeAmt${i}`].value) ?? 0, has: String(f[`chargeAmt${i}`].value || "").trim() !== "" }))
    .filter((c) => c.has && c.amount > 0)
    .map(({ label, amount }) => ({ label, amount }));
}

async function editDialog(existing, onDone) {
  let suppliers;
  let warehouses;
  try {
    [suppliers, warehouses] = await Promise.all([listSuppliers(true), listWarehouses()]);
    productCache ??= (await listProducts()).filter((p) => p.status !== "archived");
  } catch {
    toast("Suppliers or products couldn't be loaded. Try again.", "error");
    return;
  }
  suppliers = suppliers.filter((s) => s.isActive !== false || s.id === existing?.supplierId);
  warehouses = (warehouses.some((w) => w.id === DEFAULT_WAREHOUSE_ID) ? warehouses : [VIRTUAL_DEFAULT_WAREHOUSE, ...warehouses]).filter((w) => w.isActive !== false);
  if (!suppliers.length) {
    toast("Add a supplier first (Suppliers → Add supplier).", "error");
    return;
  }
  const docs = [...(existing?.attachments ?? [])];
  const oldCharges = existing?.charges ?? [];
  /** @type {{ productId: string, variantId: string, qty: number, unitCost: number, discount: number, label: string }[]} */
  const lines = (existing?.lines ?? []).map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, unitCost: l.unitCost, discount: l.discount, label: `${l.productName} · ${l.variantLabel}` }));
  /** @type {any[]} */
  let variants = [];

  formDialog({
    title: existing ? `Edit ${esc(existing.number)}` : "New purchase order",
    intro: "Prices are what the supplier charges you per pair. Totals are calculated for you.",
    submit: "Save draft",
    wide: true,
    body: `
      ${row("supplierId", "Supplier", select("supplierId", suppliers.map((s) => [s.id, s.name]), existing?.supplierId ?? suppliers[0].id))}
      ${row("warehouseId", "Receive into warehouse", select("warehouseId", warehouses.map((w) => [w.id, w.name]), existing?.warehouseId ?? DEFAULT_WAREHOUSE_ID))}
      ${row("supplierReference", "Supplier's quotation / reference (optional)", input("supplierReference", `maxlength="60" value="${esc(existing?.supplierReference ?? "")}"`))}
      ${row("purchaseDate", "Purchase date (optional)", input("purchaseDate", `type="date" value="${esc(existing?.purchaseDate ?? "")}"`))}
      ${row("expectedDate", "Expected delivery date (optional)", input("expectedDate", `type="date" value="${esc(existing?.expectedDate ?? "")}"`))}
      ${row("note", "Note (optional)", input("note", `maxlength="300" value="${esc(existing?.note ?? "")}"`))}
      <fieldset class="field" data-field="lines"><legend>Items</legend>
        <div class="adm-inline">
          <select name="product" aria-label="Product"><option value="">Product…</option>${productCache.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
          <select name="variant" aria-label="Size and colour" disabled><option value="">Size / colour…</option></select>
          <input name="qty" type="number" min="1" step="1" value="1" aria-label="Pairs" title="Pairs" />
          <input name="unitCost" inputmode="decimal" placeholder="Cost each (Rs)" aria-label="Cost each in rupees" />
          <input name="lineDiscount" inputmode="decimal" placeholder="Discount (Rs)" aria-label="Line discount in rupees" />
          <button type="button" class="btn btn--ghost" data-add>Add</button>
        </div>
        <ul class="adm-feed" data-lines></ul>
        <p class="field-error" hidden></p>
      </fieldset>
      ${row("discount", "Discount on the whole order (Rs, optional)", input("discount", `inputmode="decimal" value="${esc(rupeesField(existing?.orderDiscount || null))}"`))}
      ${row("taxPercent", "Tax on the order (%, optional)", input("taxPercent", `inputmode="decimal" value="${existing?.taxPercent ? esc(String(existing.taxPercent)) : ""}"`), "Worked out on the order after discount and added to what the goods cost")}
      <fieldset class="adm-form__group"><legend>Additional charges (freight, packing, …)</legend>
        ${[0, 1, 2].map((i) => `<div class="pos-search"><input name="chargeLabel${i}" maxlength="60" placeholder="What for" aria-label="Charge ${i + 1} description" value="${esc(oldCharges[i]?.label ?? "")}" /><input name="chargeAmt${i}" inputmode="decimal" placeholder="Amount (Rs)" aria-label="Charge ${i + 1} amount" value="${oldCharges[i] ? esc(String(oldCharges[i].amount / 100)) : ""}" /></div>`).join("")}
      </fieldset>
      <div class="field"><label for="pd-file">Quotation / documents (PDF or image, up to 5 MB)</label><input id="pd-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /><p class="field-hint" data-files>${docs.map((d) => esc(d.name)).join(", ")}</p></div>
      <p data-totals class="muted"></p>`,
    onOpen(form, { show }) {
      const f = /** @type {any} */ (form.elements);
      const linesEl = form.querySelector("[data-lines]");
      const draw = () => {
        linesEl.innerHTML = lines.length ? lines.map((l, i) => `<li><span><strong>${l.qty}</strong> × ${esc(l.label)} @ ${esc(money(l.unitCost))}${l.discount ? ` − ${esc(money(l.discount))}` : ""}</span><button type="button" class="text-btn" data-remove="${i}">Remove</button></li>`).join("") : `<li class="muted">No items yet.</li>`;
        const orderDiscount = toPaisa(f.discount.value) ?? 0;
        let text = "";
        try {
          if (lines.length) {
            const t = priceOrder(lines, Number.isNaN(orderDiscount) ? 0 : orderDiscount, { taxPercent: Number(f.taxPercent.value || 0) || 0, charges: readCharges(f).reduce((n, c) => n + c.amount, 0) });
            text = `Subtotal ${money(t.subtotal)}${t.orderDiscount ? ` − discount ${money(t.orderDiscount)}` : ""}${t.taxTotal ? ` + tax ${money(t.taxTotal)}` : ""}${t.chargesTotal ? ` + charges ${money(t.chargesTotal)}` : ""} = Total ${money(t.total)}`;
          }
        } catch (error) {
          text = /** @type {Error} */ (error).message;
        }
        /** @type {HTMLElement} */ (form.querySelector("[data-totals]")).textContent = text;
      };
      f.product.addEventListener("change", async () => {
        f.variant.disabled = true;
        f.variant.innerHTML = `<option value="">Loading…</option>`;
        variants = f.product.value ? await listVariants(f.product.value).catch(() => []) : [];
        f.variant.innerHTML = `<option value="">Size / colour…</option>${variants.map((v) => `<option value="${esc(v.id)}">${esc(v.colorName)} · ${esc(v.sizeLabel)}</option>`).join("")}`;
        f.variant.disabled = !variants.length;
      });
      form.querySelector("[data-add]").addEventListener("click", () => {
        const qty = Number(f.qty.value);
        const unitCost = toPaisa(f.unitCost.value);
        const discount = toPaisa(f.lineDiscount.value) ?? 0;
        if (!f.product.value || !f.variant.value) return show("Choose a product and a size/colour first.");
        if (!Number.isInteger(qty) || qty < 1) return show("Enter a whole number of pairs, 1 or more.");
        if (!unitCost || Number.isNaN(unitCost)) return show("Enter what the supplier charges for one pair, in rupees.");
        if (Number.isNaN(discount) || discount > unitCost * qty) return show("The line discount can't be more than the line amount.");
        if (lines.some((l) => l.productId === f.product.value && l.variantId === f.variant.value)) return show("That size/colour is already on the order.");
        const v = variants.find((x) => x.id === f.variant.value);
        lines.push({ productId: f.product.value, variantId: f.variant.value, qty, unitCost, discount, label: `${productCache?.find((p) => p.id === f.product.value)?.name ?? "Product"} · ${v?.colorName} · ${v?.sizeLabel}` });
        f.unitCost.value = "";
        f.lineDiscount.value = "";
        show("");
        draw();
      });
      linesEl.addEventListener("click", (e) => {
        const rm = /** @type {HTMLElement} */ (e.target).closest("[data-remove]");
        if (!rm) return;
        lines.splice(Number(/** @type {HTMLElement} */ (rm).dataset.remove), 1);
        draw();
      });
      for (const el of [f.discount, f.taxPercent, ...[0, 1, 2].map((i) => f[`chargeAmt${i}`])]) el.addEventListener("input", draw);
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
      draw();
    },
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const discount = toPaisa(f.discount.value) ?? 0;
      const parsed = savePurchaseOrderInput.safeParse({
        ...(existing ? { id: existing.id } : {}),
        supplierId: f.supplierId.value,
        warehouseId: f.warehouseId.value,
        supplierReference: f.supplierReference.value,
        expectedDate: f.expectedDate.value,
        purchaseDate: f.purchaseDate.value,
        note: f.note.value,
        discount: Number.isNaN(discount) ? -1 : discount,
        taxPercent: Number(f.taxPercent.value || 0),
        charges: readCharges(f),
        attachments: docs,
        lines: lines.map(({ productId, variantId, qty, unitCost, discount: d }) => ({ productId, variantId, qty, unitCost, discount: d })),
      });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      const r = await call("savePurchaseOrder", parsed.data);
      close();
      toast("Draft saved. Approve it when you place the order with the supplier.");
      onDone(r.id);
    },
  });
}

export default async function purchaseOrders({ main, user, params, navigate }) {
  const canManage = user.perms.includes("purchases.manage");
  const canPay = user.perms.includes("suppliers.pay");
  if (params[0]) return detail(params[0]);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Purchase <em>orders</em></h1>
        <p class="muted">Orders you place with suppliers. A draft changes nothing; goods only add to stock when you receive them.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new><span>New purchase order</span></button></p>` : ""}
      </header>
      <div class="adm-filters"><label class="visually-hidden" for="po-status">Status</label>
        <select id="po-status"><option value="">All statuses</option>${Object.entries(PO_STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const listEl = main.querySelector("[data-list]");
  const statusEl = /** @type {HTMLSelectElement} */ (main.querySelector("#po-status"));
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  let last = null;
  let ticket = 0;
  const table = dataTable({
    caption: "Purchase orders",
    empty: { title: "No purchase orders", text: canManage ? "Create one with “New purchase order”." : "" },
    columns: [
      { key: "number", label: "Order", render: (r) => `<a class="text-link" href="/admin/purchase-orders/${esc(r.id)}" data-link><strong>${esc(r.number)}</strong></a>` },
      { key: "supplierName", label: "Supplier" },
      { key: "createdAt", label: "Date", render: (r) => esc(dateOf(r.createdAt)) },
      { key: "total", label: "Total", render: (r) => esc(money(r.total)) },
      { key: "status", label: "Status", render: (r) => tag(PO_STATUS, r.status) },
      { key: "paymentStatus", label: "Payment", render: (r) => (r.receivedValue ? tag(PAY_STATUS, r.paymentStatus) : "—") },
    ],
  });
  async function load(reset = true) {
    const mine = ++ticket;
    try {
      const page = await pageOf("purchaseOrders", { where: statusEl.value ? [["status", "==", statusEl.value]] : [], after: reset ? null : last });
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
  statusEl.addEventListener("change", () => load(true));
  main.querySelector("[data-new]")?.addEventListener("click", () => editDialog(null, (id) => navigate(`/admin/purchase-orders/${id}`)));
  await load(true);

  /* ───── One purchase order ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    const act = async (fn, { title, body, confirm, done }) => {
      if (!(await confirmDialog({ title, body, confirm }))) return;
      try {
        await call(fn, { id });
        toast(done);
      } catch (error) {
        toast(/** @type {Error} */ (error).message, "error");
      }
      draw();
    };
    async function draw() {
      let po;
      try {
        po = await getRow("purchaseOrders", id);
      } catch {
        page.innerHTML = errorState();
        page.querySelector("[data-retry]")?.addEventListener("click", draw);
        return;
      }
      if (!po) {
        page.innerHTML = `<p>That purchase order doesn't exist. <a class="text-link" href="/admin/purchase-orders" data-link>Back</a></p>`;
        return;
      }
      const owes = (po.receivedValue ?? 0) - (po.returnedValue ?? 0) - (po.paidTotal ?? 0);
      const canReceive = canManage && ["ordered", "partially_received"].includes(po.status);
      page.innerHTML = `
        <p><a class="text-link" href="/admin/purchase-orders" data-link>← Purchase orders</a></p>
        <header class="adm-page__head">
          <h1 class="adm-h1">${esc(po.number)} ${tag(PO_STATUS, po.status)}</h1>
          <p><a class="text-link" href="/admin/suppliers/${esc(po.supplierId)}" data-link>${esc(po.supplierName)}</a> → ${esc(po.warehouseName)}${po.supplierReference ? ` · ref ${esc(po.supplierReference)}` : ""}${po.purchaseDate ? ` · ordered ${esc(po.purchaseDate)}` : ""}${po.expectedDate ? ` · expected ${esc(po.expectedDate)}` : ""}</p>
          ${(po.attachments ?? []).length ? `<p>${po.attachments.map((a) => privateFileButton(a.url, a.name)).join(" · ")}</p>` : ""}
          ${po.note ? `<p class="muted">${esc(po.note)}</p>` : ""}
          <p>
            ${canManage && po.status === "draft" ? `<button type="button" class="btn btn--ghost" data-edit>Edit</button> <button type="button" class="btn btn--primary" data-approve><span>Approve &amp; mark ordered</span></button> ` : ""}
            ${canReceive ? `<button type="button" class="btn btn--primary" data-receive><span>Receive goods</span></button> ` : ""}
            ${canManage && po.status === "partially_received" ? `<button type="button" class="btn btn--ghost" data-close-po>Close (rest isn't coming)</button> ` : ""}
            ${canManage && ["draft", "ordered"].includes(po.status) ? `<button type="button" class="btn btn--ghost" data-cancel>Cancel order</button> ` : ""}
            ${canPay && owes > 0 ? `<button type="button" class="btn btn--ghost" data-pay>Record payment</button>` : ""}
          </p>
        </header>
        <div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Items</caption>
          <thead><tr><th>Item</th><th>Ordered</th><th>Received</th><th>Rejected</th><th>Pending</th><th>Cost each</th><th>Discount</th><th>Line total</th></tr></thead>
          <tbody>${po.lines.map((l) => `<tr><td>${esc(l.productName)}<br /><span class="muted">${esc(l.variantLabel)} · <code>${esc(l.sku ?? "")}</code></span></td><td>${l.qty}</td><td>${l.receivedQty}</td><td>${l.rejectedQty}</td><td>${["cancelled", "closed"].includes(po.status) ? 0 : l.qty - l.receivedQty - l.rejectedQty}</td><td>${esc(money(l.unitCost))}</td><td>${l.discount + l.allocatedDiscount ? esc(money(l.discount + l.allocatedDiscount)) : "—"}</td><td>${esc(money(l.effective))}</td></tr>`).join("")}</tbody></table></div>
        <dl class="adm-card adm-details">
          <dt>Subtotal</dt><dd>${esc(money(po.subtotal))}</dd>${po.orderDiscount ? `<dt>Order discount</dt><dd>− ${esc(money(po.orderDiscount))}</dd>` : ""}${po.taxTotal ? `<dt>Tax (${esc(String(po.taxPercent))}%)</dt><dd>${esc(money(po.taxTotal))}</dd>` : ""}${(po.charges ?? []).map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(money(c.amount))}</dd>`).join("")}
          <dt>Order total</dt><dd><strong>${esc(money(po.total))}</strong></dd>
          <dt>Goods received so far</dt><dd>${esc(money(po.receivedValue ?? 0))}</dd>${po.returnedValue ? `<dt>Returned to supplier</dt><dd>− ${esc(money(po.returnedValue))}</dd>` : ""}
          <dt>Paid</dt><dd>${esc(money(po.paidTotal ?? 0))} ${po.receivedValue ? tag(PAY_STATUS, po.paymentStatus) : ""}</dd>
          <dt>Still to pay on received goods</dt><dd><strong>${esc(money(Math.max(0, owes)))}</strong></dd></dl>
        <h2 class="adm-h2">Goods received</h2><div data-grns><p class="muted">Loading…</p></div>
        <h2 class="adm-h2">Payments</h2><div data-pays><p class="muted">Loading…</p></div>`;

      wirePrivateFiles(page);
      page.querySelector("[data-edit]")?.addEventListener("click", () => editDialog(po, draw));
      page.querySelector("[data-approve]")?.addEventListener("click", () => act("approvePurchaseOrder", { title: `Approve ${po.number}?`, body: "It becomes an order placed with the supplier. The items can't be changed afterwards.", confirm: "Approve", done: "Approved — goods can now be received." }));
      page.querySelector("[data-receive]")?.addEventListener("click", () => receiveDialog(po, draw));
      page.querySelector("[data-close-po]")?.addEventListener("click", () => act("closePurchaseOrder", { title: `Close ${po.number}?`, body: "Use this when the remaining pairs will not be delivered. Stock and money already recorded are unchanged.", confirm: "Close order", done: "Order closed." }));
      page.querySelector("[data-cancel]")?.addEventListener("click", () => act("cancelPurchaseOrder", { title: `Cancel ${po.number}?`, body: "Nothing has been received, so no stock or money changes.", confirm: "Cancel order", done: "Order cancelled." }));
      page.querySelector("[data-pay]")?.addEventListener("click", async () => {
        const supplier = await getRow("suppliers", po.supplierId).catch(() => null);
        if (supplier) paymentDialog({ supplier, purchaseOrder: po, onDone: draw });
      });

      const fill = async (sel, collection, render) => {
        const box = /** @type {HTMLElement} */ (page.querySelector(sel));
        try {
          const p = await pageOf(collection, { where: [["purchaseOrderId", "==", id]] });
          box.innerHTML = p.rows.length ? `<ul class="adm-feed">${p.rows.map(render).join("")}</ul>` : `<p class="muted">None yet.</p>`;
          return p.rows;
        } catch {
          box.innerHTML = `<p class="muted">Couldn't be loaded.</p>`;
          return [];
        }
      };
      await fill("[data-grns]", "goodsReceipts", (g) => `<li><span><strong>${esc(g.number)}</strong> · ${g.acceptedUnits} accepted${g.rejectedUnits ? `, ${g.rejectedUnits} rejected` : ""} · ${esc(money(g.value))}${g.supplierInvoiceNo ? ` · invoice ${esc(g.supplierInvoiceNo)}` : ""}</span><span class="muted">${esc(dateOf(g.createdAt))}</span></li>`);
      const pays = await fill("[data-pays]", "supplierPayments", (p) => `<li><span><strong>${esc(p.number)}</strong> · ${esc(money(p.amount))} · ${esc(p.methodLabel ?? p.method)}${p.reference ? ` · ${esc(p.reference)}` : ""} <button type="button" class="text-btn" data-print="${esc(p.id)}">Print receipt</button></span><span class="muted">${esc(dateOf(p.createdAt))}</span></li>`);
      page.querySelector("[data-pays]").addEventListener("click", async (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest("[data-print]");
        if (!b) return;
        const settings = await loadSettings().catch(() => ({ public: null }));
        printPaymentReceipt(pays.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.print), settings.public?.storeName);
      });
    }
    await draw();
  }
}
