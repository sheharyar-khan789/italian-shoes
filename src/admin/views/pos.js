/**
 * Point of sale (physical store). Everything that matters is decided on the server: prices, stock, discounts,
 * totals, payments and the register's cash. This screen only says which pairs, how many and how they were paid,
 * and shows what the server answers. Barcode scanners that type like a keyboard work in the search box (they
 * type the SKU and press Enter).
 */
import { esc } from "../../lib/format.js";
import { rupeesToPaisa, percentOf, formatPKR } from "../../../shared/money.js";
import { CASH_REASON_LABEL, CASH_IN_REASONS, CASH_OUT_REASONS, POS_TENDER_METHODS } from "../../../shared/pos.js";
import { toast, errorState } from "../ui/kit.js";
import { formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { receiptDocument, printReceiptHtml, RECEIPT_WIDTH_LABEL } from "../../ui/posReceipt.js";
import { offlineRuntime } from "../offline.js";
import { searchLocal, pendingQuantities } from "../../lib/offlineCatalog.js";

// The api layer reports "functions/unavailable"; tests of the engine use the bare "unavailable".
const isNetworkError = (e) => /^(functions[/])?unavailable$/.test(String(e?.code ?? ""));

const METHOD_LABEL = { cash: "Cash", bank_transfer: "Bank transfer", jazzcash: "JazzCash", easypaisa: "Easypaisa" };
const rs = (paisa) => formatPKR(paisa ?? 0);
const rupees = (v) => {
  try {
    return rupeesToPaisa(String(v).trim());
  } catch {
    return null;
  }
};
const messageOf = (e) => (e?.code && e.code !== "functions/internal" ? e.message : "Something went wrong. Please try again.");

export default async function pos({ main, user }) {
  const can = (p) => user.perms.includes(p);
  let ctx = null;
  /** @type {{ productId: string, variantId: string, name: string, label: string, sku: string, price: number, listPrice: number, available: number, qty: number, unitPrice?: number, overrideReason?: string }[]} */
  let cart = [];
  let customer = null; // { id, name, phone }
  let walkIn = { name: "", phone: "" };
  let discount = null; // { type, value, reason }
  // Customer benefits (CRM): the server works out the amounts; the till only shows its preview.
  let perks = { applyDiscount: false, redeem: "" };
  /** @type {{ print: string, subtotal: number, customerDiscount: { name: string, amount: number } | null, redeem: { points: number, value: number } | null, error: string | null } | null} */
  let quote = null;
  let quoting = false;
  /** @type {any[]} */
  let found = [];
  /** @type {{ method: string, amount: string, reference: string, cashReceived: string }[]} */
  let tenders = [{ method: "cash", amount: "", reference: "", cashReceived: "" }];
  let attempt = { key: newKey(), print: "" };
  let results = [];
  let busy = false;
  let notice = "";
  /** @type {Awaited<ReturnType<typeof offlineRuntime>>} */
  let off = null;
  let wasOffline = false;
  let refreshing = false;
  const isOffline = () => Boolean(off?.isOffline());

  main.innerHTML = `<div class="adm-page pos"><p class="muted">Loading…</p></div>`;
  const page = /** @type {HTMLElement} */ (main.querySelector(".pos"));
  const alive = () => main.isConnected && page.isConnected;

  async function load() {
    if (!off) {
      off = await offlineRuntime(user);
      const unsub = off?.subscribe(() => (alive() ? paintStatus() : unsub?.()));
    }
    try {
      ctx = await call("posContext", {});
      await off?.store.setMeta(`ctx:${user.uid}`, ctx).catch(() => {});
    } catch (e) {
      // Offline: carry on with the register that was open the last time we were connected.
      const cached = isNetworkError(e) && off ? await off.store.getMeta(`ctx:${user.uid}`).catch(() => null) : null;
      if (!cached?.session) {
        page.innerHTML = errorState(isNetworkError(e) ? "You're offline and no open register was saved on this computer. Connect once to open a register and download the offline catalogue." : messageOf(e));
        return;
      }
      ctx = cached;
    }
    if (!alive()) return;
    if (ctx.session) {
      drawSell();
      refreshCatalog(false);
    } else drawOpen();
  }

  /* ───────── Offline mode ───────── */
  async function paintStatus() {
    const banner = /** @type {HTMLElement | null} */ (page.querySelector("[data-offline-banner]"));
    if (!banner || !off) return;
    const offline = isOffline();
    const c = await off.engine.counts();
    const cat = ctx?.session ? await off.store.getCatalog(ctx.session.warehouseId).catch(() => null) : null;
    const when = cat ? new Date(cat.fetchedAt).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }) : "";
    const catalog = cat ? `Offline catalogue: ${cat.products.length} products, updated ${esc(when)}.` : "No offline catalogue yet — it downloads when you are connected.";
    const unsent = c.pending + c.syncing;
    banner.innerHTML = `${offline ? `<p class="notice pos-offline" role="status"><strong>Offline mode.</strong> Sales are saved on this computer and sent automatically when the connection returns. Cash only, paid in full. Prices and stock come from the saved catalogue and are checked again when sent.${unsent ? ` <strong>${unsent}</strong> waiting.` : ""}</p>` : c.unsent ? `<p class="notice" role="status">${unsent ? `${unsent} offline sale${unsent === 1 ? "" : "s"} syncing. ` : ""}${c.conflict + c.failed ? `<strong>${c.conflict + c.failed} need attention.</strong> ` : ""}<a href="/admin/pos-sync">View sync status</a></p>` : ""}
      <p class="muted pos-catalog-note">${catalog} ${offline ? "" : `<button type="button" class="text-btn" data-refresh>Update catalogue</button>`}</p>`;
    banner.querySelector("[data-refresh]")?.addEventListener("click", () => refreshCatalog(true));
    page.querySelectorAll("[data-close], [data-cash]").forEach((b) => /** @type {HTMLButtonElement} */ (b).toggleAttribute("disabled", offline));
    if (offline !== wasOffline) {
      wasOffline = offline;
      drawPay();
    }
  }

  /** Download the catalogue for this register's warehouse (a page at a time) so the till can work offline. */
  async function refreshCatalog(force) {
    if (!off || refreshing || isOffline() || !ctx?.session) return;
    const wid = ctx.session.warehouseId;
    const cur = await off.store.getCatalog(wid).catch(() => null);
    if (!force && cur && Date.now() - Date.parse(cur.fetchedAt) < 12 * 3600 * 1000) return void paintStatus();
    refreshing = true;
    try {
      const all = [];
      let after = null;
      let pages = 0;
      do {
        const p = await call("posCatalog", { warehouseId: wid, after });
        all.push(...p.products);
        after = p.next;
        pages += 1;
      } while (after && pages < 200);
      await off.store.putCatalog(wid, { products: all, fetchedAt: new Date().toISOString() });
      if (force) toast(`Offline catalogue updated (${all.length} products)`);
    } catch (e) {
      if (force) toast(isNetworkError(e) ? "Couldn't update the catalogue: no connection." : messageOf(e), "error");
    } finally {
      refreshing = false;
      if (alive()) paintStatus();
    }
  }

  /** Search the saved catalogue (offline). Unsent offline sales are already taken off the stock shown. */
  async function lookupOffline(q, exactFirst) {
    const cat = off ? await off.store.getCatalog(ctx.session.warehouseId).catch(() => null) : null;
    if (!cat) throw Object.assign(new Error("No offline catalogue is saved on this computer yet. Connect once to download it."), { code: "no-catalogue" });
    const held = pendingQuantities(await off.engine.list());
    const r = exactFirst ? searchLocal(cat.products, q, { exact: true, held }) : null;
    return r && r.match !== "none" ? r : searchLocal(cat.products, q, { exact: false, held });
  }

  /* ───────── Open a register ───────── */
  function drawOpen() {
    const canOpen = can("pos.register");
    page.innerHTML = `
      <header class="adm-page__head"><h1 class="adm-h1">Point of <em>sale</em></h1><p class="muted">Open your register to start selling. Each cashier has one open register, tied to one warehouse.</p></header>
      ${
        !canOpen
          ? `<p class="notice">You don't have permission to open a register.</p>`
          : !ctx.warehouses.length
            ? `<p class="notice">There is no active warehouse. Add or switch on a warehouse first.</p>`
            : `<form class="adm-form pos-open" data-open novalidate>
        <p class="form-alert" role="alert" data-alert hidden></p>
        <div class="field"><label for="po-wh">Sell from warehouse</label><select id="po-wh" name="warehouseId">${ctx.warehouses.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="po-float">Opening cash in the drawer (Rs.)</label><input id="po-float" name="openingFloat" inputmode="decimal" value="0" /></div>
        <div class="field"><label for="po-note">Note (optional)</label><input id="po-note" name="note" maxlength="200" /></div>
        <button class="btn btn--primary" type="submit"><span>Open register</span></button>
      </form>`
      }`;
    const form = page.querySelector("[data-open]");
    const openKey = newKey();
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const alert = /** @type {HTMLElement} */ (form.querySelector("[data-alert]"));
      const f = new FormData(/** @type {HTMLFormElement} */ (form));
      const amount = rupees(f.get("openingFloat"));
      if (amount === null) {
        alert.textContent = "Enter the opening cash as a number, for example 5000.";
        alert.hidden = false;
        return;
      }
      try {
        await call("openRegister", { idempotencyKey: openKey, warehouseId: String(f.get("warehouseId")), openingFloat: amount, note: String(f.get("note") ?? "") });
        toast("Register opened");
        await load();
      } catch (err) {
        alert.textContent = messageOf(err);
        alert.hidden = false;
      }
    });
  }

  /* ───────── Totals (a preview; the server's figures are final) ───────── */
  const lineUnit = (l) => l.unitPrice ?? l.price;
  const subtotal = () => cart.reduce((n, l) => n + lineUnit(l) * l.qty, 0);
  const discountAmount = () => {
    if (!discount) return 0;
    const sub = subtotal();
    return Math.min(sub, discount.type === "percent" ? percentOf(sub, discount.value) : discount.value * 100);
  };
  const wantsPerks = () => Boolean(customer) && (perks.applyDiscount || Number(perks.redeem) > 0);
  const quotePrint = () => JSON.stringify([cart.map((l) => [l.productId, l.variantId, l.qty, l.unitPrice ?? null]), discount, customer?.id ?? null, perks.applyDiscount, Number(perks.redeem) || 0]);
  const quoteFresh = () => !wantsPerks() || (quote !== null && quote.print === quotePrint());
  const perkSaving = () => (wantsPerks() && quote && quote.print === quotePrint() && !quote.error ? (quote.customerDiscount?.amount ?? 0) + (quote.redeem?.value ?? 0) : 0);
  const taxAmount = () => (ctx.tax.enabled ? percentOf(subtotal() - discountAmount() - perkSaving(), ctx.tax.ratePercent) : 0);
  const total = () => subtotal() - discountAmount() - perkSaving() + taxAmount();

  /** Ask the server what the customer discount and points are worth for this cart (a preview; checkout decides again). */
  async function refreshQuote() {
    if (!wantsPerks() || !cart.length || quoteFresh() || quoting || isOffline()) return;
    quoting = true;
    const print = quotePrint();
    try {
      const r = await call("posCrmQuote", { customerId: customer.id, items: cart.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}) })), ...(discount ? { discount } : {}), applyCustomerDiscount: perks.applyDiscount, redeemPoints: Number(perks.redeem) || 0 });
      quote = { print, subtotal: r.subtotal, customerDiscount: r.customerDiscount, redeem: r.redeem, error: r.error };
    } catch (e) {
      quote = { print, subtotal: 0, customerDiscount: null, redeem: null, error: messageOf(e) };
    }
    quoting = false;
    drawPay();
  }
  const tenderPaisa = (t) => rupees(t.amount) ?? 0;
  const tendered = () => tenders.reduce((n, t) => n + tenderPaisa(t), 0);

  const fingerprint = () => JSON.stringify([cart.map((l) => [l.productId, l.variantId, l.qty, l.unitPrice ?? null]), discount, customer?.id ?? null, perks, tenders]);
  const keyForAttempt = () => {
    const print = fingerprint();
    if (attempt.print !== print) attempt = { key: newKey(), print };
    return attempt.key;
  };

  /* ───────── Sell screen ───────── */
  function drawSell() {
    const s = ctx.session;
    page.innerHTML = `
      <header class="pos-bar">
        <div><strong>${esc(s.number)}</strong> · ${esc(whName(s.warehouseId))} · ${esc(s.cashierName)}<br /><span class="muted">Cash expected in drawer: <strong data-expected>${esc(rs(s.expectedCash))}</strong> · ${s.saleCount ?? 0} sale${s.saleCount === 1 ? "" : "s"}</span></div>
        <div class="pos-bar__actions">
          ${can("pos.cash") ? `<button type="button" class="btn btn--ghost" data-cash>Cash in / out</button>` : ""}
          <button type="button" class="btn btn--ghost" data-close>Close register</button>
        </div>
      </header>
      <div data-offline-banner></div>
      <p class="notice" data-notice role="status" ${notice ? "" : "hidden"}>${esc(notice)}</p>
      <div class="pos-grid">
        <section class="pos-find" aria-label="Find a product">
          <form data-search class="pos-search" novalidate>
            <label class="visually-hidden" for="pos-q">Search by name or scan a SKU</label>
            <input id="pos-q" name="q" type="search" placeholder="Scan a barcode / SKU or type a name, then Enter" autocomplete="off" autofocus />
            <button class="btn btn--primary" type="submit"><span>Find</span></button>
          </form>
          <div data-results class="pos-results"></div>
        </section>
        <section class="pos-cart" aria-label="Current sale">
          <div data-cart></div>
          <div data-customer></div>
          <div data-pay></div>
        </section>
      </div>`;
    drawResults();
    drawCart();
    paintStatus();
    page.querySelector("[data-close]")?.addEventListener("click", closeRegisterDialog);
    page.querySelector("[data-cash]")?.addEventListener("click", cashDialog);
    const form = /** @type {HTMLFormElement} */ (page.querySelector("[data-search]"));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = String(new FormData(form).get("q") ?? "").trim();
      if (!q) return;
      form.reset(); // ready for the next scan straight away
      /** @type {HTMLInputElement} */ (form.querySelector("#pos-q")).focus();
      await search(q, true);
    });
  }

  const whName = (id) => ctx.warehouses.find((w) => w.id === id)?.name ?? id;

  async function search(q, exactFirst) {
    const box = page.querySelector("[data-results]");
    if (box) box.innerHTML = `<p class="muted">Searching…</p>`;
    try {
      let r;
      if (isOffline()) r = await lookupOffline(q, exactFirst);
      else {
        try {
          r = exactFirst ? await call("posSearch", { q, warehouseId: ctx.session.warehouseId, exact: true }) : null;
          if (!r || r.match === "none") r = await call("posSearch", { q, warehouseId: ctx.session.warehouseId, exact: false });
        } catch (e) {
          if (!isNetworkError(e)) throw e;
          r = await lookupOffline(q, exactFirst); // the connection dropped: use the saved catalogue
        }
      }
      results = r.products;
      let added = false;
      // A scanned SKU for one variant goes straight into the sale when it's in stock.
      if (r.match === "sku" && results.length === 1 && results[0].variants.length === 1) {
        const v = results[0].variants[0];
        if (v.available > 0) {
          addToCart(results[0], v);
          results = [];
          added = true;
        }
      }
      drawResults(!added && !results.length ? `Nothing found for "${q}".` : "");
    } catch (e) {
      drawResults("", messageOf(e));
    }
  }

  function drawResults(empty = "", error = "") {
    const box = page.querySelector("[data-results]");
    if (!box) return;
    if (error) return void (box.innerHTML = `<p class="form-alert" role="alert">${esc(error)}</p>`);
    if (!results.length) return void (box.innerHTML = empty ? `<p class="muted">${esc(empty)}</p>` : `<p class="muted">Stock shown is what ${esc(whName(ctx.session.warehouseId))} has available.</p>`);
    box.innerHTML = results
      .map(
        (p) => `<article class="pos-product"><h3>${esc(p.name)}</h3>
        <div class="pos-variants">${p.variants.map((v) => `<button type="button" class="pos-variant" data-add="${esc(p.id)}|${esc(v.id)}" ${v.available > 0 ? "" : "disabled"}>
          <span>${esc(v.colorName)} / ${esc(v.sizeLabel)}</span><span class="muted">${esc(v.sku)}</span>
          <span><strong>${esc(rs(v.price))}</strong>${v.price < v.listPrice ? ` <s class="muted">${esc(rs(v.listPrice))}</s>` : ""}</span>
          <span class="${v.available > 0 ? "" : "tag tag--out"}">${v.available > 0 ? `${v.available} in stock` : "Out of stock"}</span></button>`).join("")}</div></article>`,
      )
      .join("");
    box.querySelectorAll("[data-add]").forEach((b) =>
      b.addEventListener("click", () => {
        const [pid, vid] = /** @type {HTMLElement} */ (b).dataset.add.split("|");
        const p = results.find((x) => x.id === pid);
        addToCart(p, p.variants.find((v) => v.id === vid));
      }),
    );
  }

  function addToCart(p, v) {
    const line = cart.find((l) => l.productId === p.id && l.variantId === v.id);
    if (line) {
      if (line.qty + 1 > v.available) return say(`Only ${v.available} of ${p.name} (${v.colorName} / ${v.sizeLabel}) in stock here.`);
      line.qty += 1;
      line.available = v.available;
    } else {
      if (v.available < 1) return say("That size is out of stock here.");
      cart.push({ productId: p.id, variantId: v.id, name: p.name, label: `${v.colorName} / ${v.sizeLabel}`, sku: v.sku, price: v.price, listPrice: v.listPrice, available: v.available, qty: 1 });
    }
    say("");
    drawCart();
  }

  function say(text) {
    notice = text;
    const el = /** @type {HTMLElement | null} */ (page.querySelector("[data-notice]"));
    if (el) {
      el.textContent = text;
      el.hidden = !text;
    }
  }

  /* ───────── Cart, customer, payment ───────── */
  function drawCart() {
    const cartEl = page.querySelector("[data-cart]");
    if (!cartEl) return;
    cartEl.innerHTML = cart.length
      ? `<table class="adm-table pos-lines"><caption class="visually-hidden">Items in this sale</caption><thead><tr><th scope="col">Item</th><th scope="col">Qty</th><th scope="col" class="r">Total</th><th></th></tr></thead><tbody>${cart
          .map(
            (l, i) => `<tr><td><strong>${esc(l.name)}</strong><br /><span class="muted">${esc(l.label)} · ${esc(l.sku)}</span><br />${esc(rs(lineUnit(l)))}${l.unitPrice !== undefined ? ` <span class="tag tag--low">price changed</span>` : ""}${can("pos.override") ? ` <button type="button" class="text-btn" data-price="${i}">Change price</button>` : ""}</td>
            <td><div class="pos-qty"><button type="button" aria-label="One fewer" data-dec="${i}">−</button><input aria-label="Quantity" inputmode="numeric" value="${l.qty}" data-qty="${i}" /><button type="button" aria-label="One more" data-inc="${i}">+</button></div><br /><span class="muted">${l.available} available</span></td>
            <td class="r">${esc(rs(lineUnit(l) * l.qty))}</td><td><button type="button" class="text-btn" data-remove="${i}" aria-label="Remove ${esc(l.name)}">Remove</button></td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="muted">The sale is empty. Scan or search for a product.</p>`;
    const setQty = (i, q) => {
      const l = cart[i];
      if (!Number.isInteger(q) || q < 1) return drawCart();
      if (q > l.available) {
        say(`Only ${l.available} of ${l.name} (${l.label}) in stock here.`);
        l.qty = l.available;
      } else {
        say("");
        l.qty = q;
      }
      drawCart();
    };
    cartEl.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => setQty(Number(/** @type {HTMLElement} */ (b).dataset.inc), cart[Number(/** @type {HTMLElement} */ (b).dataset.inc)].qty + 1)));
    cartEl.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => setQty(Number(/** @type {HTMLElement} */ (b).dataset.dec), cart[Number(/** @type {HTMLElement} */ (b).dataset.dec)].qty - 1)));
    cartEl.querySelectorAll("[data-qty]").forEach((b) => b.addEventListener("change", () => setQty(Number(/** @type {HTMLElement} */ (b).dataset.qty), Number(/** @type {HTMLInputElement} */ (b).value))));
    cartEl.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        cart.splice(Number(/** @type {HTMLElement} */ (b).dataset.remove), 1);
        drawCart();
      }),
    );
    cartEl.querySelectorAll("[data-price]").forEach((b) => b.addEventListener("click", () => priceDialog(Number(/** @type {HTMLElement} */ (b).dataset.price))));
    drawCustomer();
    drawPay();
  }

  function drawCustomer() {
    const el = page.querySelector("[data-customer]");
    if (!el) return;
    el.innerHTML = `<h2 class="adm-h2">Customer</h2>${
      customer
        ? `<p><strong>${esc(customer.name)}</strong> <span class="muted">${esc(customer.reference ?? "")}</span> ${customer.phone ? `· ${esc(customer.phone)}` : ""} ${customer.tierName ? `<span class="tag tag--low">${esc(customer.tierName)}</span>` : ""} <button type="button" class="text-btn" data-clear-customer>Use walk-in instead</button></p>${perksHtml()}${customer.recent?.length ? `<ul class="pos-history">${customer.recent.map((r) => `<li>${esc(r.number)} · ${esc(rs(r.total))} · ${esc(r.channel === "pos" ? "store" : "online")} · ${esc(r.status)}</li>`).join("")}</ul>` : `<p class="muted">No earlier purchases.</p>`}`
        : `<form data-lookup class="pos-search" novalidate><label class="visually-hidden" for="pos-cq">Customer name, phone or email</label><input id="pos-cq" name="q" placeholder="Customer name, phone or email (optional)" /><button class="btn btn--ghost" type="submit"><span>Look up</span></button></form>
           <p class="muted" data-lookup-note>Leave empty for a walk-in customer.</p>
           ${found.length ? `<ul class="pos-history">${found.map((c, i) => `<li><button type="button" class="text-btn" data-pick="${i}">${esc(c.name)} · ${esc(c.phone || c.reference || "")}</button></li>`).join("")}</ul>` : ""}
           ${can("crm.write") ? `<p><button type="button" class="text-btn" data-new-customer>Add this person as a new customer</button></p>` : ""}
           <div class="pos-walkin"><input aria-label="Name on receipt (optional)" placeholder="Name on receipt (optional)" data-walk-name value="${esc(walkIn.name)}" maxlength="80" /><input aria-label="Phone (optional)" placeholder="Phone (optional)" data-walk-phone value="${esc(walkIn.phone)}" maxlength="30" /></div>`
    }`;
    el.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => chooseCustomer(found[Number(/** @type {HTMLElement} */ (b).dataset.pick)])));
    el.querySelector("[data-new-customer]")?.addEventListener("click", () => newCustomerDialog(String(new FormData(/** @type {HTMLFormElement} */ (el.querySelector("[data-lookup]"))).get("q") ?? "").trim()));
    el.querySelector("[data-apply-discount]")?.addEventListener("change", (e) => {
      perks.applyDiscount = /** @type {HTMLInputElement} */ (e.target).checked;
      quote = null;
      drawPay();
    });
    let redeemTimer;
    el.querySelector("[data-redeem]")?.addEventListener("input", (e) => {
      perks.redeem = /** @type {HTMLInputElement} */ (e.target).value.replace(/\D/g, "");
      clearTimeout(redeemTimer);
      redeemTimer = setTimeout(() => {
        quote = null;
        drawPay();
      }, 500);
    });
    el.querySelector("[data-clear-customer]")?.addEventListener("click", () => {
      customer = null;
      perks = { applyDiscount: false, redeem: "" };
      quote = null;
      found = [];
      drawCustomer();
      drawPay();
    });
    el.querySelector("[data-walk-name]")?.addEventListener("input", (e) => (walkIn.name = /** @type {HTMLInputElement} */ (e.target).value));
    el.querySelector("[data-walk-phone]")?.addEventListener("input", (e) => (walkIn.phone = /** @type {HTMLInputElement} */ (e.target).value));
    const form = /** @type {HTMLFormElement | null} */ (el.querySelector("[data-lookup]"));
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = String(new FormData(form).get("q") ?? "").trim();
      const noteEl = /** @type {HTMLElement} */ (el.querySelector("[data-lookup-note]"));
      if (q.length < 3) return void (noteEl.textContent = "Type at least 3 characters.");
      if (isOffline()) return void (noteEl.textContent = "Customer lookup needs a connection. Sell to a walk-in, or type a name for the receipt.");
      try {
        const r = await call("posCustomerLookup", { q });
        loyaltyCfg = r.loyalty ?? null;
        if (!r.customers.length) {
          found = [];
          return void (noteEl.textContent = "No registered customer found. You can still sell to a walk-in" + (can("crm.write") ? ", or add them as a new customer." : "."));
        }
        if (r.customers.length > 1) {
          found = r.customers;
          return drawCustomer();
        }
        chooseCustomer(r.customers[0]);
      } catch (err) {
        noteEl.textContent = messageOf(err);
      }
    });
  }

  /** @type {any} */
  let loyaltyCfg = null;
  function chooseCustomer(c) {
    customer = c;
    found = [];
    perks = { applyDiscount: false, redeem: "" };
    quote = null;
    drawCustomer();
    drawPay();
  }
  /** Loyalty balance and the "apply customer discount" / "use points" controls for the chosen customer. */
  function perksHtml() {
    if (!customer) return "";
    const bal = customer.loyaltyBalance;
    const max = bal !== null && loyaltyCfg ? Math.min(bal, loyaltyCfg.maxRedeemPointsPerSale || Infinity) : 0;
    return `<div class="pos-perks">
      ${bal !== null ? `<p>Loyalty points: <strong>${bal}</strong>${loyaltyCfg ? ` <span class="muted">(1 point = ${esc(rs(loyaltyCfg.redeemValuePerPoint))}; at least ${loyaltyCfg.minRedeemPoints} to use)</span>` : ""}</p>` : ""}
      <label class="check"><input type="checkbox" data-apply-discount ${perks.applyDiscount ? "checked" : ""} ${discount ? "disabled" : ""} /> Apply this customer's discount${discount ? " (not with a manual discount)" : ""}</label>
      ${bal !== null && bal >= (loyaltyCfg?.minRedeemPoints ?? 1) ? `<div class="pos-walkin"><input aria-label="Points to use" inputmode="numeric" placeholder="Points to use (max ${max})" data-redeem value="${esc(perks.redeem)}" /></div>` : ""}
    </div>`;
  }
  function newCustomerDialog(q) {
    const looksLikePhone = /\d{7,}/.test(q);
    formDialog({
      title: "Add a new customer",
      intro: "Only a name and a mobile number are needed. Leave the offers box unticked unless the customer says yes.",
      body: `${row("name", "Name", input("name", `maxlength="100" value="${looksLikePhone ? esc(walkIn.name) : esc(q)}"`))}${row("phone", "Mobile number", input("phone", `maxlength="30" inputmode="tel" value="${looksLikePhone ? esc(q) : esc(walkIn.phone)}"`))}<label class="check"><input type="checkbox" name="consent" /> The customer agrees to receive offers on WhatsApp</label>`,
      submit: "Add customer",
      async onSubmit(form, { show, close }) {
        const f = /** @type {any} */ (form.elements);
        if (f.name.value.trim().length < 2) return show("Enter the customer's name.", { name: "Required" });
        if (!f.phone.value.trim()) return show("Enter a mobile number.", { phone: "Required" });
        const made = await call("crmQuickCreate", { name: f.name.value.trim(), phone: f.phone.value.trim(), consentMarketing: f.consent.checked });
        const r = await call("posCustomerLookup", { q: made.reference ?? f.phone.value.trim() });
        close();
        if (r.customers[0]) chooseCustomer(r.customers[0]);
      },
    });
  }

  function drawPay() {
    const el = page.querySelector("[data-pay]");
    refreshQuote();
    if (!el) return;
    if (isOffline()) tenders = [{ ...tenders[0], method: "cash", reference: "" }];
    const sub = subtotal();
    const due = total() - tendered();
    el.innerHTML = `
      <h2 class="adm-h2">Payment</h2>
      ${can("pos.override") ? `<p><button type="button" class="text-btn" data-discount>${discount ? "Change discount" : "Add discount"}</button>${discount ? ` <button type="button" class="text-btn" data-nodiscount>Remove discount</button>` : ""}</p>` : ""}
      <dl class="pos-totals">
        <div><dt>Subtotal</dt><dd>${esc(rs(sub))}</dd></div>
        ${discount ? `<div><dt>Discount (${esc(discount.reason)})</dt><dd>− ${esc(rs(discountAmount()))}</dd></div>` : ""}
        ${perkSaving() && quote?.customerDiscount ? `<div><dt>${esc(quote.customerDiscount.name)}</dt><dd>− ${esc(rs(quote.customerDiscount.amount))}</dd></div>` : ""}
        ${perkSaving() && quote?.redeem ? `<div><dt>Loyalty points (${quote.redeem.points})</dt><dd>− ${esc(rs(quote.redeem.value))}</dd></div>` : ""}
        ${ctx.tax.enabled ? `<div><dt>Tax (${ctx.tax.ratePercent}%)</dt><dd>${esc(rs(taxAmount()))}</dd></div>` : ""}
        <div class="pos-totals__big"><dt>Payable</dt><dd data-payable>${esc(rs(total()))}</dd></div>
      </dl>
      <div class="pos-tenders">${tenders
        .map(
          (t, i) => `<div class="pos-tender" data-t="${i}">
        <select aria-label="Payment method" data-m>${(isOffline() ? ["cash"] : POS_TENDER_METHODS).map((m) => `<option value="${m}" ${t.method === m ? "selected" : ""}>${METHOD_LABEL[m]}</option>`).join("")}</select>
        <input aria-label="Amount (Rs.)" inputmode="decimal" placeholder="Amount" data-a value="${esc(t.amount)}" />
        ${t.method === "cash" ? `<input aria-label="Cash received (Rs.)" inputmode="decimal" placeholder="Cash received" data-c value="${esc(t.cashReceived)}" />` : `<input aria-label="Transaction reference" placeholder="Reference no." data-r value="${esc(t.reference)}" maxlength="80" />`}
        ${tenders.length > 1 ? `<button type="button" class="text-btn" data-rm="${i}" aria-label="Remove payment">✕</button>` : ""}</div>`,
        )
        .join("")}
        ${tenders.length < 6 && !isOffline() ? `<button type="button" class="text-btn" data-addtender>+ Split payment</button> ` : ""}<button type="button" class="text-btn" data-fill>Pay in full (cash)</button></div>
      ${wantsPerks() && quote && quote.print === quotePrint() && quote.error ? `<p class="form-alert" role="alert">${esc(quote.error)}</p>` : wantsPerks() && !quoteFresh() ? `<p class="muted">Working out the customer's savings…</p>` : wantsPerks() && quote && !quote.error && !perkSaving() ? `<p class="muted">No customer discount applies to this sale.</p>` : ""}
      <p class="pos-due ${due < 0 ? "is-bad" : ""}" data-due>${due < 0 ? `Payments are ${esc(rs(-due))} more than the total.` : due === 0 && total() > 0 ? "Fully paid." : `Remaining: ${esc(rs(due))}${due > 0 && tendered() > 0 ? ` — a part payment needs a registered customer.` : ""}`}</p>
      ${t_change()}
      <p class="muted">Bank and wallet payments are recorded with the reference you type; they are not checked with the bank or wallet. Confirm the money arrived before you hand over the goods.</p>
      <button type="button" class="btn btn--primary pos-checkout" data-checkout ${cart.length && !busy ? "" : "disabled"}><span>${busy ? "Working…" : "Complete sale"}</span></button>`;
    const bind = (sel, fn, evt = "input") => el.querySelectorAll(sel).forEach((n) => n.addEventListener(evt, () => fn(Number(/** @type {HTMLElement} */ (n.closest("[data-t]")).dataset.t), /** @type {HTMLInputElement} */ (n).value)));
    bind("[data-m]", (i, v) => {
      tenders[i].method = v;
      drawPay();
    }, "change");
    // Typing updates the numbers without redrawing the inputs (so focus isn't lost).
    bind("[data-a]", (i, v) => {
      tenders[i].amount = v;
      refreshDue(el);
    });
    bind("[data-c]", (i, v) => {
      tenders[i].cashReceived = v;
      refreshDue(el);
    });
    bind("[data-r]", (i, v) => (tenders[i].reference = v));
    el.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        tenders.splice(Number(/** @type {HTMLElement} */ (b).dataset.rm), 1);
        drawPay();
      }),
    );
    el.querySelector("[data-addtender]")?.addEventListener("click", () => {
      tenders.push({ method: "bank_transfer", amount: "", reference: "", cashReceived: "" });
      drawPay();
    });
    el.querySelector("[data-fill]")?.addEventListener("click", () => {
      tenders = [{ method: "cash", amount: String(total() / 100), reference: "", cashReceived: "" }];
      drawPay();
    });
    el.querySelector("[data-discount]")?.addEventListener("click", discountDialog);
    el.querySelector("[data-nodiscount]")?.addEventListener("click", () => {
      discount = null;
      drawPay();
    });
    el.querySelector("[data-checkout]")?.addEventListener("click", checkout);
  }

  const t_change = () => {
    const ch = tenders.reduce((n, t) => {
      const a = rupees(t.amount);
      const c = rupees(t.cashReceived);
      return t.method === "cash" && a !== null && c !== null && c > a ? n + (c - a) : n;
    }, 0);
    return ch > 0 ? `<p class="pos-change" data-change>Give back: <strong>${esc(rs(ch))}</strong></p>` : `<p data-change hidden></p>`;
  };
  function refreshDue(el) {
    const due = total() - tendered();
    const d = /** @type {HTMLElement} */ (el.querySelector("[data-due]"));
    d.className = `pos-due ${due < 0 ? "is-bad" : ""}`;
    d.textContent = due < 0 ? `Payments are ${rs(-due)} more than the total.` : due === 0 && total() > 0 ? "Fully paid." : `Remaining: ${rs(due)}${due > 0 && tendered() > 0 ? " — a part payment needs a registered customer." : ""}`;
    const ch = el.querySelector("[data-change]");
    if (ch) ch.outerHTML = t_change();
  }

  /* ───────── Checkout ───────── */
  async function checkout() {
    if (busy || !cart.length) return;
    const payload = buildPayload();
    if (typeof payload === "string") return say(payload);
    if (isOffline()) return saveOffline(payload);
    busy = true;
    drawPay();
    try {
      const r = await call("posCheckout", payload);
      const sale = r;
      cart = [];
      discount = null;
      customer = null;
      perks = { applyDiscount: false, redeem: "" };
      quote = null;
      found = [];
      walkIn = { name: "", phone: "" };
      tenders = [{ method: "cash", amount: "", reference: "", cashReceived: "" }];
      attempt = { key: newKey(), print: "" };
      results = [];
      say("");
      if (r.loyaltyRedeemed) toast(`${r.loyaltyRedeemed} loyalty points used`);
      if (r.failedPayment) toast(`Sale ${r.number} saved, but a payment wasn't recorded: ${r.failedPayment.message}`, "error");
      else toast(`Sale ${r.number} completed`);
      busy = false;
      ctx = await call("posContext", {});
      drawSell();
      receiptDialog(sale.saleId, sale);
    } catch (e) {
      busy = false;
      // The connection dropped during checkout. The same key is used when the sale is saved offline, so if the server
      // did receive it, sending it later returns that same sale instead of making a second one.
      if (isNetworkError(e) && off) return saveOffline(payload, true);
      say(messageOf(e));
      drawPay();
    }
  }

  /** Save a cash sale on this computer (IndexedDB) to be sent when the connection returns. */
  async function saveOffline(payload, afterDrop = false) {
    if (!off) return say("This browser can't store offline sales, so selling offline isn't possible here.");
    const refuse = (m) => say(m);
    if (customer) return refuse("Registered customers need a connection. Choose walk-in to sell offline.");
    if (!payload.tenders.length || payload.tenders.some((t) => t.method !== "cash")) return refuse("Offline sales are cash only.");
    if (tendered() !== total()) return refuse("Offline sales must be paid in full in cash. Enter the full amount.");
    const catalog = await off.store.getCatalog(ctx.session.warehouseId).catch(() => null);
    if (!catalog) return refuse("No offline catalogue is saved on this computer yet.");
    const offlineId = payload.idempotencyKey;
    const recordedAt = new Date().toISOString();
    const sale = {
      id: null,
      number: `OFFLINE-${offlineId.slice(-6).toUpperCase()}`,
      createdAt: recordedAt,
      cashierName: ctx.session.cashierName,
      customer: walkIn.name.trim() ? { name: walkIn.name.trim() } : null,
      lines: cart.map((l) => ({ productName: l.name, colorName: l.label.split(" / ")[0], sizeLabel: l.label.split(" / ")[1] ?? "", sku: l.sku, qty: l.qty, unitPrice: lineUnit(l), regularPrice: l.listPrice, lineTotal: lineUnit(l) * l.qty })),
      subtotal: subtotal(),
      itemDiscountTotal: cart.reduce((n, l) => n + (l.listPrice - lineUnit(l)) * l.qty, 0),
      discountTotal: discountAmount(),
      taxTotal: taxAmount(),
      total: total(),
      paidTotal: total(),
      amountDue: 0,
      pos: { tenders: payload.tenders.map((t) => ({ method: "cash", amount: t.amount, ...(t.cashReceived !== undefined ? { cashReceived: t.cashReceived } : {}) })) },
    };
    const receipt = { offline: true, sale, payments: payload.tenders.map((t) => ({ type: "collection", method: "cash", amount: t.amount, reference: "" })) };
    try {
      await off.engine.enqueue({ offlineId, receipt, payload: { sale: payload, offlineId, recordedAt, expectedTotal: total() }, localRef: sale.number });
    } catch {
      return refuse("This sale could NOT be saved on this computer. Do not hand over the goods until it is recorded some other way.");
    }
    cart = [];
    discount = null;
    walkIn = { name: "", phone: "" };
    tenders = [{ method: "cash", amount: "", reference: "", cashReceived: "" }];
    attempt = { key: newKey(), print: "" };
    results = [];
    say("");
    busy = false;
    toast(afterDrop ? "Connection lost — sale saved on this computer and will be sent automatically" : "Saved offline. It will be sent automatically.");
    drawSell();
    receiptDialog(null, null, receipt);
  }

  function buildPayload() {
    const items = cart.map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice, overrideReason: l.overrideReason } : {}) }));
    const ts = [];
    for (const t of tenders) {
      if (!t.amount.trim()) continue;
      const amount = rupees(t.amount);
      if (!amount) return "Enter each payment amount as a number greater than zero.";
      if (t.method !== "cash" && t.reference.trim().length < 3) return `Enter the reference number for the ${METHOD_LABEL[t.method]} payment.`;
      const cr = t.method === "cash" && t.cashReceived.trim() ? rupees(t.cashReceived) : undefined;
      if (cr === null) return "Enter the cash received as a number.";
      if (cr !== undefined && cr < amount) return "Cash received can't be less than the amount.";
      ts.push({ method: t.method, amount, ...(t.method === "cash" ? (cr !== undefined ? { cashReceived: cr } : {}) : { reference: t.reference.trim() }) });
    }
    if (wantsPerks() && !quoteFresh()) return "Wait a moment while the customer's savings are worked out, then try again.";
    if (wantsPerks() && quote?.error) return quote.error;
    if (tendered() > total()) return "The payments add up to more than the total.";
    if (tendered() < total() && !customer) return ts.length ? "A part payment needs a registered customer. Look one up, or take the full amount." : "Enter the payment, or look up a registered customer to sell on credit.";
    return { idempotencyKey: keyForAttempt(), sessionId: ctx.session.id, items, ...(customer ? { customerId: customer.id } : { customerName: walkIn.name.trim(), customerPhone: walkIn.phone.trim() }), ...(discount ? { discount } : {}), ...(customer && perks.applyDiscount ? { applyCustomerDiscount: true } : {}), ...(customer && Number(perks.redeem) > 0 ? { redeemPoints: Number(perks.redeem) } : {}), tenders: ts };
  }

  /* ───────── Dialogs ───────── */
  function priceDialog(i) {
    const l = cart[i];
    formDialog({
      title: "Change price",
      intro: `List price ${esc(rs(l.price))}. A price can only be lowered, needs a reason, and is recorded in the audit log.`,
      body: row("price", "New price per pair (Rs.)", input("price", 'inputmode="decimal"')) + row("reason", "Reason", input("reason", 'maxlength="200"')),
      submit: "Apply",
      onSubmit: (form, { show, close }) => {
        const f = new FormData(form);
        const p = rupees(f.get("price"));
        const reason = String(f.get("reason") ?? "").trim();
        if (!p || p > l.price) return show("Enter a price lower than " + rs(l.price) + ".", { price: "Lower than the list price" });
        if (reason.length < 3) return show("Give a reason.", { reason: "Required" });
        l.unitPrice = p;
        l.overrideReason = reason;
        close();
        drawCart();
      },
    });
  }

  function discountDialog() {
    formDialog({
      title: "Discount",
      intro: "Recorded in the audit log with your name and the reason.",
      body: row("type", "Type", select("type", [["amount", "Amount (Rs.)"], ["percent", "Percent (%)"]], discount?.type ?? "amount")) + row("value", "Value", input("value", `inputmode="decimal" value="${discount ? discount.value : ""}"`)) + row("reason", "Reason", input("reason", `maxlength="200" value="${esc(discount?.reason ?? "")}"`)),
      submit: "Apply",
      onSubmit: (form, { show, close }) => {
        const f = new FormData(form);
        const type = String(f.get("type"));
        const value = Number(f.get("value"));
        const reason = String(f.get("reason") ?? "").trim();
        if (!Number.isInteger(value) || value < 1) return show("Enter a whole number greater than zero.", { value: "Whole number" });
        if (type === "percent" && value > 100) return show("A percentage can't be more than 100.", { value: "Up to 100" });
        if (reason.length < 3) return show("Give a reason.", { reason: "Required" });
        discount = { type, value, reason };
        close();
        drawPay();
      },
    });
  }

  function cashDialog() {
    if (isOffline()) return say("Cash in/out needs a connection.");
    const s = ctx.session;
    formDialog({
      title: "Cash in / out",
      intro: `Cash expected in the drawer now: ${esc(rs(s.expectedCash))}. Every movement is recorded with your name and posted to the books.`,
      body:
        row("type", "Movement", select("type", [["cash_in", "Cash in"], ["cash_out", "Cash out"]])) +
        row("reason", "Reason", select("reason", [...CASH_IN_REASONS.map((r) => [r, `In: ${CASH_REASON_LABEL[r]}`]), ...CASH_OUT_REASONS.map((r) => [r, `Out: ${CASH_REASON_LABEL[r]}`])])) +
        row("amount", "Amount (Rs.)", input("amount", 'inputmode="decimal"')) +
        row("note", "Note", input("note", 'maxlength="200"')),
      submit: "Record",
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const amount = rupees(f.get("amount"));
        if (!amount) return show("Enter an amount greater than zero.", { amount: "Required" });
        const r = await call("registerCash", { idempotencyKey: cashKey(f), sessionId: s.id, type: String(f.get("type")), reason: String(f.get("reason")), amount, note: String(f.get("note") ?? "").trim() });
        close();
        toast(r.posting === "failed" ? "Recorded, but the accounting entry failed. The owner can retry it in Accounting." : "Cash movement recorded", r.posting === "failed" ? "error" : "ok");
        await load();
      },
    });
  }
  const cashKeys = new Map();
  const cashKey = (f) => {
    const sig = [f.get("type"), f.get("reason"), f.get("amount"), f.get("note")].join("|");
    if (!cashKeys.has(sig)) cashKeys.set(sig, newKey());
    return cashKeys.get(sig);
  };

  async function closeRegisterDialog() {
    if (isOffline()) return say("Closing the register needs a connection.");
    const waiting = off ? await off.engine.counts() : null;
    if (waiting?.unsent) return say(`${waiting.unsent} offline sale${waiting.unsent === 1 ? " hasn't" : "s haven't"} been accepted by the server yet. Send them (or resolve them) on the Offline sync page before closing the register, so the cash count includes them.`);
    const s = ctx.session;
    formDialog({
      title: "Close register",
      intro: `Count the cash in the drawer. Expected: <strong>${esc(rs(s.expectedCash))}</strong> (opening ${esc(rs(s.openingFloat))} + cash sales + cash in − cash out). A difference is recorded as a shortage or excess.`,
      body: row("counted", "Counted cash (Rs.)", input("counted", 'inputmode="decimal"')) + `<p class="pos-diff muted" data-diff></p>` + row("note", "Note (optional)", input("note", 'maxlength="300"')),
      submit: "Close register",
      onOpen: (form) => {
        const diff = /** @type {HTMLElement} */ (form.querySelector("[data-diff]"));
        form.querySelector("[name=counted]")?.addEventListener("input", (e) => {
          const c = rupees(/** @type {HTMLInputElement} */ (e.target).value);
          const d = c === null ? null : c - s.expectedCash;
          diff.textContent = d === null ? "" : d === 0 ? "Matches the expected cash." : d < 0 ? `Shortage of ${rs(-d)}.` : `Excess of ${rs(d)}.`;
        });
      },
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const counted = f.get("counted") === "" ? null : rupees(f.get("counted"));
        if (counted === null) return show("Enter the counted cash (0 if the drawer is empty).", { counted: "Required" });
        const r = await call("closeRegister", { sessionId: s.id, countedCash: counted, note: String(f.get("note") ?? "").trim() });
        close();
        const text = r.outcome === "exact" ? "Register closed. Cash matched." : r.outcome === "shortage" ? `Register closed. Shortage of ${rs(-r.variance)}.` : `Register closed. Excess of ${rs(r.variance)}.`;
        toast(r.posting === "failed" ? `${text} The accounting entry failed; the owner can retry it in Accounting.` : text, r.posting === "failed" ? "error" : "ok");
        cart = [];
        await load();
      },
    });
  }

  async function receiptDialog(saleId, summary, preset = null) {
    let data = preset;
    if (!data) {
      try {
        data = await call("posReceipt", { saleId });
      } catch (e) {
        return toast(messageOf(e), "error");
      }
    }
    let width = "80mm";
    const due = data.sale.amountDue > 0;
    const d = document.createElement("dialog");
    d.className = "adm-dialog adm-dialog--wide pos-receipt-dialog";
    d.setAttribute("aria-labelledby", "pr-title");
    const draw = () => {
      d.innerHTML = `<form method="dialog"><h2 id="pr-title">Sale ${esc(data.sale.number)}</h2>
        ${summary?.failedPayment ? `<p class="form-alert" role="alert">A payment wasn't recorded: ${esc(summary.failedPayment.message)} Use "Take payment" to record it.</p>` : ""}
        <div class="pos-receipt-opts"><label for="pr-w">Receipt size</label><select id="pr-w">${Object.entries(RECEIPT_WIDTH_LABEL).map(([k, v]) => `<option value="${k}" ${k === width ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
        <iframe class="pos-receipt-frame" title="Receipt preview" sandbox srcdoc="${esc(receiptDocument(data, ctx.store, width))}"></iframe>
        ${data.offline ? `<p class="notice">Offline receipt. The official sale number is given when the sale is sent to the server.</p>` : ""}
        <p class="muted">This prints through your browser's print dialog, so it works with any printer set up on this computer (including a thermal printer). The app can't tell whether the printer is connected.</p>
        <div class="adm-dialog__actions">${due ? `<button type="button" class="btn btn--ghost" data-take>Take payment</button>` : ""}<button type="submit" class="btn btn--ghost">Close</button><button type="button" class="btn btn--primary" data-print><span>Print Receipt</span></button></div></form>`;
      d.querySelector("#pr-w")?.addEventListener("change", (e) => {
        width = /** @type {HTMLSelectElement} */ (e.target).value;
        draw();
      });
      d.querySelector("[data-print]")?.addEventListener("click", () => printReceiptHtml(receiptDocument(data, ctx.store, width)));
      d.querySelector("[data-take]")?.addEventListener("click", () => {
        d.close();
        takePaymentDialog(data.sale);
      });
    };
    draw();
    document.body.append(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
  }

  function takePaymentDialog(sale) {
    const payKey = newKey();
    formDialog({
      title: `Take payment — ${sale.number}`,
      intro: `Still due: ${esc(rs(sale.amountDue))}`,
      body: row("method", "Method", select("method", POS_TENDER_METHODS.map((m) => [m, METHOD_LABEL[m]]))) + row("amount", "Amount (Rs.)", input("amount", `inputmode="decimal" value="${sale.amountDue / 100}"`)) + row("reference", "Reference (bank / wallet)", input("reference", 'maxlength="80"')),
      submit: "Record payment",
      onSubmit: async (form, { show, close }) => {
        const f = new FormData(form);
        const amount = rupees(f.get("amount"));
        const method = String(f.get("method"));
        if (!amount) return show("Enter an amount.", { amount: "Required" });
        if (amount > sale.amountDue) return show(`That is more than the ${rs(sale.amountDue)} due.`, { amount: "Too much" });
        const reference = String(f.get("reference") ?? "").trim();
        if (method !== "cash" && reference.length < 3) return show("Enter the reference number.", { reference: "Required" });
        await call("posRecordPayment", { idempotencyKey: payKey, saleId: sale.id, sessionId: ctx.session.id, tender: { method, amount, ...(method === "cash" ? {} : { reference }) } });
        close();
        toast("Payment recorded");
        await load();
        receiptDialog(sale.id);
      },
    });
  }

  await load();
}
