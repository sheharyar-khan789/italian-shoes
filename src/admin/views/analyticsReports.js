/**
 * Custom report builder: pick a report, a period (and a comparison), narrow it with filters, save the setup for next time, and export it.
 * Only the reports this person's permissions allow are listed; the server checks again for every request.
 */
import { esc } from "../../lib/format.js";
import { ANALYTICS_REPORTS, canRunReport } from "../../../shared/analytics.js";
import { errorState } from "../ui/kit.js";
import { formDialog, row, input } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { listCategories, listWarehouses, listProducts } from "../catalogData.js";
import { listSuppliers } from "../purchData.js";
import { PRESETS, presetDates, comparisonFor, showReport, exportButtons, wireExports, messageOf } from "../analyticsUi.js";

const METHODS = [["cash", "Cash"], ["bank_transfer", "Bank transfer"], ["jazzcash", "JazzCash"], ["easypaisa", "Easypaisa"], ["cod", "Cash on delivery"], ["card", "Card"]];
const SAVED_PERIODS = new Set(["today", "yesterday", "week", "month", "year", "last30", "last90"]);

/** @param {{ main: HTMLElement, user: any, params: string[] }} ctx @param {{ start?: string }} [opts] */
export default async function analyticsReports({ main, user, params }, opts = {}) {
  const runnable = Object.entries(ANALYTICS_REPORTS).filter(([k]) => canRunReport(k, user.perms));
  if (!runnable.length) {
    main.innerHTML = `<div class="adm-page">${errorState("Your role can't run any analytics reports.")}</div>`;
    return;
  }
  const only = opts.start?.startsWith("fin_") ? runnable.filter(([, r]) => r.group === "Financial") : runnable;
  const groups = [...new Set(only.map(([, r]) => r.group))];
  const start = [params?.[0], opts.start].find((k) => k && only.some(([key]) => key === k)) ?? only[0][0];
  const d0 = presetDates("last30");
  const canManage = user.perms.includes("analytics.manage");
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">${opts.start ? "Financial" : "Report"} <em>${opts.start ? "analytics" : "builder"}</em></h1><p class="muted">Choose a report, a period and any filters. Figures come from your real records; tables marked Estimate are forecasts, not accounting figures.</p></header>
      <section class="adm-card" data-saved>
        <div class="an-filters">
          <div class="field"><label for="rb-saved">Saved reports</label><select id="rb-saved"><option value="">— choose —</option></select></div>
          <div><button type="button" class="btn btn--ghost" data-load disabled>Open</button> ${canManage ? `<button type="button" class="btn btn--ghost" data-delete disabled>Delete</button>` : ""}</div>
        </div>
      </section>
      <form data-form novalidate>
        <div class="an-filters">
          <div class="field"><label for="rb-report">Report</label><select id="rb-report">${groups.map((g) => `<optgroup label="${esc(g)}">${only.filter(([, r]) => r.group === g).map(([k, r]) => `<option value="${k}" ${k === start ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</optgroup>`).join("")}</select></div>
          <div class="field"><label for="rb-preset">Period</label><select id="rb-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === "last30" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          <div class="field"><label for="rb-from">From</label><input id="rb-from" type="date" value="${d0.from}" /></div>
          <div class="field"><label for="rb-to">To</label><input id="rb-to" type="date" value="${d0.to}" /></div>
          <div class="field" data-g><label for="rb-gran">Group by</label><select id="rb-gran"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></div>
          <label class="check"><input id="rb-compare" type="checkbox" /> Compare with the period before</label>
        </div>
        <details class="adm-card"><summary>Filters</summary>
          <div class="an-filters" data-filters><p class="muted">Loading filters…</p></div>
        </details>
        <p><button type="submit" class="btn btn--primary"><span>Show report</span></button> ${canManage ? `<button type="button" class="btn btn--ghost" data-save>Save this setup</button>` : ""}</p>
      </form>
      ${exportButtons(user.perms)}
      <div data-out><p class="muted">Choose a report and press “Show report”.</p></div>
    </div>`;
  const $ = (s) => /** @type {HTMLInputElement} */ (main.querySelector(s));
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;
  /** @type {any} */
  let current = null;
  /** @type {{ id: string, label: string }[]} */
  const customers = [];
  /** @type {any[]} */
  let saved = [];
  const chosen = { products: /** @type {string[]} */ ([]), suppliers: /** @type {string[]} */ ([]) };

  /* ── filters ── */
  const [cats, whs, prods, sups] = await Promise.all([listCategories().catch(() => []), listWarehouses().catch(() => []), listProducts().catch(() => []), user.perms.includes("purchases.read") ? listSuppliers().catch(() => []) : []]);
  const fbox = /** @type {HTMLElement} */ (main.querySelector("[data-filters]"));
  const chips = (kind, list) => list.map((id) => `<button type="button" class="an-chip" data-remove="${kind}:${esc(id)}" title="Remove">${esc(kind === "products" ? (prods.find((p) => p.id === id)?.name ?? id) : kind === "suppliers" ? (sups.find((s) => s.id === id)?.name ?? id) : (customers.find((c) => c.id === id)?.label ?? id))} ✕</button>`).join("");
  const drawFilters = () => {
    fbox.innerHTML = `
      <div class="field"><label for="f-channel">Sales channel</label><select id="f-channel"><option value="">All</option><option value="pos">Shop (POS)</option><option value="online">Online</option></select></div>
      <div class="field"><label for="f-wh">Shop / warehouse</label><select id="f-wh"><option value="">All</option>${whs.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")}</select></div>
      <div class="field" data-account><label for="f-account">Account code (general ledger)</label><input id="f-account" maxlength="20" placeholder="e.g. 1010" /></div>
      <fieldset class="field"><legend>Categories</legend>${cats.length ? cats.map((c) => `<label class="check"><input type="checkbox" name="cat" value="${esc(c.id)}" /> ${esc(c.name)}</label>`).join(" ") : `<span class="muted">None</span>`}</fieldset>
      <fieldset class="field"><legend>Payment methods</legend>${METHODS.map(([k, l]) => `<label class="check"><input type="checkbox" name="pm" value="${k}" /> ${l}</label>`).join(" ")}</fieldset>
      <div class="field"><label for="f-prod">Products</label><select id="f-prod"><option value="">Add a product…</option>${prods.slice(0, 500).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select><div class="an-chips">${chips("products", chosen.products)}</div></div>
      ${sups.length ? `<div class="field"><label for="f-sup">Suppliers (purchase analytics)</label><select id="f-sup"><option value="">Add a supplier…</option>${sups.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select><div class="an-chips">${chips("suppliers", chosen.suppliers)}</div></div>` : ""}
      ${user.perms.includes("crm.read") ? `<div class="field"><label for="f-cust">Customers</label><input id="f-cust" type="search" placeholder="Search by name or phone, then pick" /><div class="an-chips" data-cust-results></div><div class="an-chips">${chips("customers", customerIds)}</div></div>` : ""}`;
    fbox.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
      const [kind, id] = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.remove).split(":");
      if (kind === "customers") customerIds = customerIds.filter((x) => x !== id);
      else chosen[kind] = chosen[kind].filter((x) => x !== id);
      keepForm(() => drawFilters());
    }));
    fbox.querySelector("#f-prod")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      if (v && !chosen.products.includes(v) && chosen.products.length < 100) chosen.products.push(v);
      keepForm(() => drawFilters());
    });
    fbox.querySelector("#f-sup")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      if (v && !chosen.suppliers.includes(v) && chosen.suppliers.length < 50) chosen.suppliers.push(v);
      keepForm(() => drawFilters());
    });
    let timer;
    fbox.querySelector("#f-cust")?.addEventListener("input", (e) => {
      clearTimeout(timer);
      const q = /** @type {HTMLInputElement} */ (e.target).value.trim();
      const box = /** @type {HTMLElement} */ (fbox.querySelector("[data-cust-results]"));
      if (q.length < 2) return void (box.innerHTML = "");
      timer = setTimeout(async () => {
        try {
          const r = await call("crmListCustomers", { q, limit: 8 });
          box.innerHTML = r.customers.map((c) => `<button type="button" class="an-chip" data-pick="${esc(c.id)}" data-label="${esc(c.name)}">+ ${esc(c.name)}</button>`).join("") || `<span class="muted">No match</span>`;
          box.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
            const id = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.pick);
            if (!customerIds.includes(id) && customerIds.length < 50) {
              customerIds.push(id);
              customers.push({ id, label: /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.label) });
            }
            keepForm(() => drawFilters());
          }));
        } catch {
          box.innerHTML = "";
        }
      }, 300);
    });
    syncVisibility();
  };
  let customerIds = /** @type {string[]} */ ([]);
  /** Redraw the filter area without losing what was ticked. @param {() => void} fn */
  const keepForm = (fn) => {
    const before = readFilters();
    fn();
    applyFilters(before);
  };
  const readFilters = () => ({
    channel: $("#f-channel")?.value ?? "",
    warehouseId: $("#f-wh")?.value || null,
    accountCode: $("#f-account")?.value.trim() ?? "",
    categoryIds: [...main.querySelectorAll('[name="cat"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value),
    paymentMethods: [...main.querySelectorAll('[name="pm"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value),
    productIds: [...chosen.products],
    supplierIds: [...chosen.suppliers],
    customerIds: [...customerIds],
  });
  const applyFilters = (f) => {
    chosen.products = [...(f.productIds ?? [])];
    chosen.suppliers = [...(f.supplierIds ?? [])];
    customerIds = [...(f.customerIds ?? [])];
    if ($("#f-channel")) $("#f-channel").value = f.channel ?? "";
    if ($("#f-wh")) $("#f-wh").value = f.warehouseId ?? "";
    if ($("#f-account")) $("#f-account").value = f.accountCode ?? "";
    main.querySelectorAll('[name="cat"]').forEach((x) => (/** @type {HTMLInputElement} */ (x).checked = (f.categoryIds ?? []).includes(/** @type {HTMLInputElement} */ (x).value)));
    main.querySelectorAll('[name="pm"]').forEach((x) => (/** @type {HTMLInputElement} */ (x).checked = (f.paymentMethods ?? []).includes(/** @type {HTMLInputElement} */ (x).value)));
  };
  const syncVisibility = () => {
    const r = $("#rb-report").value;
    /** @type {HTMLElement} */ (main.querySelector("[data-g]")).hidden = !["sales_trend"].includes(r);
    const acct = main.querySelector("[data-account]");
    if (acct) /** @type {HTMLElement} */ (acct).hidden = r !== "fin_ledger";
  };
  drawFilters();

  /* ── saved reports ── */
  async function loadSaved() {
    try {
      saved = (await call("listReportConfigs", {})).configs;
    } catch {
      saved = [];
    }
    const sel = $("#rb-saved");
    sel.innerHTML = `<option value="">— choose —</option>${saved.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}`;
    syncSavedButtons();
  }
  const syncSavedButtons = () => {
    const has = Boolean($("#rb-saved").value);
    /** @type {HTMLButtonElement} */ (main.querySelector("[data-load]")).disabled = !has;
    const del = /** @type {HTMLButtonElement | null} */ (main.querySelector("[data-delete]"));
    if (del) del.disabled = !has;
  };
  $("#rb-saved").addEventListener("change", syncSavedButtons);
  main.querySelector("[data-load]").addEventListener("click", () => {
    const c = saved.find((x) => x.id === $("#rb-saved").value);
    if (!c) return;
    $("#rb-report").value = c.report;
    $("#rb-gran").value = c.granularity ?? "day";
    $("#rb-preset").value = SAVED_PERIODS.has(c.period) ? c.period : "month";
    const r = presetDates($("#rb-preset").value);
    if (r) {
      $("#rb-from").value = r.from;
      $("#rb-to").value = r.to;
    }
    $("#rb-compare").checked = Boolean(c.compare);
    applyFilters(c.filters ?? {});
    drawFilters();
    applyFilters(c.filters ?? {});
    syncVisibility();
    main.querySelector("[data-form]")?.dispatchEvent(new Event("submit", { cancelable: true }));
  });
  main.querySelector("[data-delete]")?.addEventListener("click", async () => {
    try {
      await call("deleteReportConfig", { id: $("#rb-saved").value });
      await loadSaved();
    } catch (e) {
      out.innerHTML = errorState(messageOf(e));
    }
  });
  main.querySelector("[data-save]")?.addEventListener("click", () => {
    formDialog({
      title: "Save this report setup",
      intro: "It is saved for you only and uses a relative period, so it stays useful next week.",
      body: row("name", "Name", input("name", 'maxlength="60"')),
      submit: "Save",
      async onSubmit(form, { show, close }) {
        const name = String(new FormData(form).get("name") ?? "").trim();
        if (name.length < 2) return show("Give it a name.", { name: "Required" });
        const p = $("#rb-preset").value;
        await call("saveReportConfig", { name, report: $("#rb-report").value, granularity: $("#rb-gran").value, period: SAVED_PERIODS.has(p) ? p : "month", compare: $("#rb-compare").checked, filters: { productIds: [], categoryIds: [], supplierIds: [], customerIds: [], paymentMethods: [], channel: "", accountCode: "", ...readFilters() } });
        close();
        await loadSaved();
      },
    });
  });

  /* ── run ── */
  $("#rb-report").addEventListener("change", syncVisibility);
  $("#rb-preset").addEventListener("change", (e) => {
    const r = presetDates(/** @type {HTMLSelectElement} */ (e.target).value);
    if (!r) return;
    $("#rb-from").value = r.from;
    $("#rb-to").value = r.to;
  });
  main.querySelector("[data-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = $("#rb-from").value;
    const to = $("#rb-to").value;
    if (!from || !to || to < from) return void (out.innerHTML = errorState("Choose a valid start and end date."));
    out.innerHTML = `<p class="muted">Calculating…</p>`;
    const exp = main.querySelector("[data-exports]");
    if (exp) /** @type {HTMLElement} */ (exp).hidden = true;
    const f = readFilters();
    try {
      current = await call("analyticsReport", { report: $("#rb-report").value, from, to, granularity: $("#rb-gran").value, ...($("#rb-compare").checked ? comparisonFor(from, to) : { compareFrom: "", compareTo: "" }), filters: { ...f, channel: f.channel } });
      if (!alive()) return;
      out.innerHTML = `<h2 class="adm-h2">${esc(current.title)}</h2><p class="muted">${esc(current.from)} to ${esc(current.to)}</p><div data-body></div>`;
      showReport(/** @type {HTMLElement} */ (out.querySelector("[data-body]")), current);
      if (exp) /** @type {HTMLElement} */ (exp).hidden = false;
    } catch (err) {
      if (alive()) out.innerHTML = errorState(/set up/i.test(err?.message ?? "") ? "Accounting isn't set up yet. Create the chart of accounts first." : messageOf(err));
    }
  });
  wireExports(main, () => current);
  await loadSaved();
  syncVisibility();
}
