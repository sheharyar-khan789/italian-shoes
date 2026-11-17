/**
 * Customer settings: customer types, how groups (New, VIP, Inactive …) are decided, membership tiers, the loyalty programme
 * and customer discounts. Nothing is hard-coded: every threshold here is yours, and the server checks it again on save.
 */
import { esc } from "../../lib/format.js";
import { SEGMENT_LABEL } from "../../../shared/crm.js";
import { toast, confirmDialog, errorState, emptyState } from "../ui/kit.js";
import { money, formDialog, row, input, select } from "../ui/purchasing.js";
import { rupeesField, toPaisa } from "../ui/money.js";
import { call } from "../purchData.js";
import { listCategories } from "../catalogData.js";
import { messageOf, labelTables } from "../financeUi.js";
import { crmSettingsInput, saveCrmDiscountInput, fieldErrors } from "../../../shared/schemas/index.js";

const num = (v) => (String(v).trim() === "" ? NaN : Number(v));

export default async function crmSettings({ main, user }) {
  const canManage = user.perms.includes("crm.manage");
  main.innerHTML = `<div class="adm-page"><header class="adm-page__head"><h1 class="adm-h1">Customer <em>settings</em></h1><p class="muted">Groups, membership tiers, loyalty points and customer discounts. You decide every number here.</p></header><div data-out><p class="muted">Loading…</p></div></div>`;
  const out = /** @type {HTMLElement} */ (main.querySelector("[data-out]"));
  const alive = () => main.isConnected && main.querySelector("[data-out]") !== null;

  async function show() {
    let cfg;
    let categories;
    let discounts;
    try {
      [cfg, categories, discounts] = await Promise.all([call("getCrmSettings", {}), listCategories().catch(() => []), call("listCrmDiscounts", {}).then((r) => r.discounts)]);
    } catch (err) {
      if (!alive()) return;
      out.innerHTML = errorState(messageOf(err));
      out.querySelector("[data-retry]")?.addEventListener("click", show);
      return;
    }
    if (!alive()) return;
    const sg = cfg.segments;
    const lo = cfg.loyalty;
    const dis = canManage ? "" : "disabled";
    const field = (id, label, value, hint = "", attrs = "") => `<div class="field"><label for="${id}">${esc(label)}</label>${hint ? `<p class="field-hint">${esc(hint)}</p>` : ""}<input id="${id}" name="${id}" value="${esc(value)}" ${attrs} ${dis} /><p class="field-error" hidden></p></div>`;
    out.innerHTML = `
      <form data-settings novalidate>
        <p class="form-alert" role="alert" data-alert hidden></p>
        <section class="adm-card"><h2 class="adm-h2">Customer types</h2>${field("types", "Types (separated by commas)", cfg.customerTypes.join(", "), "For example Retail, Wholesale, Corporate")}</section>
        <section class="adm-card"><h2 class="adm-h2">Customer groups</h2><p class="muted">A customer can be in several groups at once. ${esc(Object.values(SEGMENT_LABEL).join(", "))}.</p>
          ${field("newDays", "“New” for how many days after the first purchase", sg.newDays, "", 'inputmode="numeric"')}
          ${field("returningOrders", "“Returning” from how many orders (at least 2)", sg.returningOrders, "", 'inputmode="numeric"')}
          ${field("regularOrders", "“Regular” — orders needed within the window", sg.regularOrders, "", 'inputmode="numeric"')}
          ${field("regularDays", "…the window, in days", sg.regularDays, "", 'inputmode="numeric"')}
          ${field("vipSpend", "“VIP” — total spent of at least (Rs, 0 = off)", rupeesField(sg.vipSpend), "", 'inputmode="decimal"')}
          ${field("highValueSpend", "“High value” — total spent of at least (Rs, 0 = off)", rupeesField(sg.highValueSpend), "", 'inputmode="decimal"')}
          ${field("inactiveDays", "“Inactive” — no purchase for this many days (0 = off)", sg.inactiveDays, "", 'inputmode="numeric"')}</section>
        <section class="adm-card"><h2 class="adm-h2">Membership tiers</h2><p class="muted">A customer's tier is the highest one whose spend over the last 12 months they reach. One tier must start at Rs 0.</p>
          <div data-tiers>${cfg.tiers.map((t, i) => tierRow(t, i, dis)).join("")}</div>
          ${canManage ? `<p><button type="button" class="btn btn--ghost" data-add-tier>Add a tier</button></p>` : ""}</section>
        <section class="adm-card"><h2 class="adm-h2">Loyalty programme</h2>
          <label class="check"><input type="checkbox" name="lo_enabled" ${lo.enabled ? "checked" : ""} ${dis} /> Loyalty points are on</label>
          <p class="muted">Points are earned only when a purchase is paid in full, and are taken back in proportion if it is refunded.</p>
          ${field("lo_pointsPer100", "Points earned per Rs 100 spent", lo.pointsPer100, "", 'inputmode="decimal"')}
          ${field("lo_redeemValuePerPoint", "Value of one point when redeemed (Rs)", rupeesField(lo.redeemValuePerPoint), "", 'inputmode="decimal"')}
          ${field("lo_minRedeemPoints", "Smallest redemption (points)", lo.minRedeemPoints, "", 'inputmode="numeric"')}
          ${field("lo_maxRedeemPercent", "Points can pay for at most this % of a purchase", lo.maxRedeemPercent, "", 'inputmode="decimal"')}
          ${field("lo_maxRedeemPointsPerSale", "Most points per purchase (0 = no limit)", lo.maxRedeemPointsPerSale, "", 'inputmode="numeric"')}
          ${field("lo_expiryDays", "Points expire after (days, 0 = never)", lo.expiryDays, "", 'inputmode="numeric"')}
          <fieldset class="field" ${dis}><legend>Categories that earn no points</legend>${categories.length ? categories.map((c) => `<label class="check"><input type="checkbox" name="exc" value="${esc(c.id)}" ${lo.excludedCategoryIds.includes(c.id) ? "checked" : ""} ${dis} /> ${esc(c.name)}</label>`).join(" ") : `<p class="muted">No categories.</p>`}</fieldset></section>
        ${canManage ? `<p><button type="submit" class="btn btn--primary"><span>Save settings</span></button></p>` : `<p class="muted">You can view these settings but not change them.</p>`}
      </form>
      <section><h2 class="adm-h2">Customer discounts</h2><p class="muted">Applied in the POS on request and checked by the server. Only the best single discount applies, and never together with a manual discount.</p>
        ${canManage ? `<p><button type="button" class="btn btn--primary" data-new-discount><span>Add a discount</span></button></p>` : ""}
        <div data-discounts>${discountTable(discounts)}</div></section>`;
    labelTables(out);
    wire(cfg, categories, discounts);
  }

  const tierRow = (t, i, dis) => `<div class="adm-card" data-tier="${i}"><div class="field"><label>Key (lowercase)</label><input name="t_key" value="${esc(t.key)}" maxlength="20" ${dis} /></div><div class="field"><label>Name</label><input name="t_name" value="${esc(t.name)}" maxlength="30" ${dis} /></div><div class="field"><label>Spend in 12 months from (Rs)</label><input name="t_min" value="${esc(rupeesField(t.minAnnualSpend))}" inputmode="decimal" ${dis} /></div><div class="field"><label>Discount on purchases (%)</label><input name="t_disc" value="${esc(t.discountPercent)}" inputmode="decimal" ${dis} /></div><div class="field"><label>Points multiplier</label><input name="t_mult" value="${esc(t.pointsMultiplier)}" inputmode="decimal" ${dis} /></div>${dis ? "" : `<button type="button" class="btn btn--ghost" data-remove-tier>Remove</button>`}</div>`;

  const scopeText = (d) => ({ all: "Everyone", customer: `One customer`, tier: `Tier: ${d.tier}`, segment: `Group: ${SEGMENT_LABEL[d.segment] ?? d.segment}` })[d.scope] ?? d.scope;
  const discountTable = (list) =>
    list.length
      ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>For</th><th>Saves</th><th>Valid</th><th>Used</th><th></th></tr></thead><tbody>${list.map((d) => `<tr><td>${esc(d.name)}${d.isActive === false ? ` <span class="tag tag--out">Off</span>` : ""}</td><td>${esc(scopeText(d))}</td><td>${d.type === "percent" ? `${d.value}%` : esc(money(d.value))}${d.minPurchase ? `<br /><span class="muted">over ${esc(money(d.minPurchase))}</span>` : ""}</td><td>${esc([d.validFrom, d.validTo].filter(Boolean).join(" → ") || "Always")}</td><td>${d.used ?? 0}${d.usageLimit ? ` / ${d.usageLimit}` : ""}</td><td>${canManage ? `<button type="button" class="text-btn" data-edit-d="${esc(d.id)}">Edit</button> <button type="button" class="text-btn" data-toggle-d="${esc(d.id)}">${d.isActive === false ? "Switch on" : "Switch off"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : emptyState({ title: "No customer discounts yet" });

  function wire(cfg, categories, discounts) {
    const form = /** @type {HTMLFormElement} */ (out.querySelector("[data-settings]"));
    const alert = /** @type {HTMLElement} */ (form.querySelector("[data-alert]"));
    const tiers = /** @type {HTMLElement} */ (form.querySelector("[data-tiers]"));
    const v = (n) => /** @type {HTMLInputElement} */ (form.elements.namedItem(n)).value;
    form.querySelector("[data-add-tier]")?.addEventListener("click", () => tiers.insertAdjacentHTML("beforeend", tierRow({ key: "", name: "", minAnnualSpend: 0, discountPercent: 0, pointsMultiplier: 1 }, tiers.children.length, "")));
    tiers.addEventListener("click", (e) => /** @type {HTMLElement} */ (e.target).closest("[data-remove-tier]")?.closest("[data-tier]")?.remove());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!canManage) return;
      alert.hidden = true;
      const t = (name) => [...tiers.querySelectorAll(`[name="${name}"]`)].map((x) => /** @type {HTMLInputElement} */ (x).value);
      const keys = t("t_key");
      const candidate = {
        customerTypes: v("types").split(",").map((s) => s.trim()).filter(Boolean),
        segments: { newDays: num(v("newDays")), returningOrders: num(v("returningOrders")), regularOrders: num(v("regularOrders")), regularDays: num(v("regularDays")), vipSpend: toPaisa(v("vipSpend")) ?? 0, highValueSpend: toPaisa(v("highValueSpend")) ?? 0, inactiveDays: num(v("inactiveDays")) },
        tiers: keys.map((k, i) => ({ key: k.trim(), name: t("t_name")[i].trim(), minAnnualSpend: toPaisa(t("t_min")[i]) ?? 0, discountPercent: num(t("t_disc")[i]), pointsMultiplier: num(t("t_mult")[i]) })),
        loyalty: { enabled: /** @type {HTMLInputElement} */ (form.elements.namedItem("lo_enabled")).checked, pointsPer100: num(v("lo_pointsPer100")), redeemValuePerPoint: toPaisa(v("lo_redeemValuePerPoint")), minRedeemPoints: num(v("lo_minRedeemPoints")), maxRedeemPercent: num(v("lo_maxRedeemPercent")), maxRedeemPointsPerSale: num(v("lo_maxRedeemPointsPerSale")), expiryDays: num(v("lo_expiryDays")), excludedCategoryIds: [...form.querySelectorAll('[name="exc"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value), excludedProductIds: cfg.loyalty.excludedProductIds ?? [] },
      };
      const parsed = crmSettingsInput.safeParse(candidate);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        alert.textContent = `Please check the settings: ${first?.message ?? "a value isn't valid"} (${first?.path.join(" › ")}).`;
        alert.hidden = false;
        return;
      }
      try {
        await call("saveCrmSettings", parsed.data);
        toast("Settings saved.");
        show();
      } catch (err) {
        alert.textContent = messageOf(err);
        alert.hidden = false;
      }
    });
    out.querySelector("[data-new-discount]")?.addEventListener("click", () => discountDialog(null, categories));
    out.querySelectorAll("[data-edit-d]").forEach((b) => b.addEventListener("click", () => discountDialog(discounts.find((d) => d.id === /** @type {HTMLElement} */ (b).dataset.editD), categories)));
    out.querySelectorAll("[data-toggle-d]").forEach((b) => b.addEventListener("click", async () => {
      const d = discounts.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.toggleD);
      if (!d) return;
      const turnOn = d.isActive === false;
      if (!turnOn && !(await confirmDialog({ title: `Switch off “${d.name}”?`, body: "It stops applying to new sales. Past sales keep their saving.", confirm: "Switch off" }))) return;
      try {
        await call("setCrmDiscountActive", { id: d.id, isActive: turnOn });
        toast(turnOn ? "Discount is on." : "Discount is off.");
        show();
      } catch (err) {
        toast(messageOf(err), "error");
      }
    }));
    function discountDialog(existing, cats) {
      const d = existing ?? { name: "", scope: "all", type: "percent", value: 10, minPurchase: 0, validFrom: "", validTo: "", usageLimit: 0, perCustomerLimit: 0, categoryIds: [], tier: "", segment: "", customerId: "" };
      formDialog({
        title: existing ? "Edit discount" : "Add a customer discount",
        wide: true,
        body: `
          ${row("name", "Name", input("name", `maxlength="80" value="${esc(d.name)}"`))}
          ${row("scope", "Who gets it", select("scope", [["all", "Every customer in the POS"], ["tier", "A membership tier"], ["segment", "A customer group"], ["customer", "One customer (paste their customer id)"]], d.scope))}
          ${row("tier", "Tier (if for a tier)", select("tier", [["", "—"], ...cfg.tiers.map((t) => [t.key, t.name])], d.tier ?? ""))}
          ${row("segment", "Group (if for a group)", select("segment", [["", "—"], ...Object.entries(SEGMENT_LABEL)], d.segment ?? ""))}
          ${row("customerId", "Customer id (if for one customer — copy it from the customer's page address)", input("customerId", `value="${esc(d.customerId ?? "")}"`))}
          ${row("type", "Kind", select("type", [["percent", "Percentage off"], ["amount", "Fixed amount off"]], d.type))}
          ${row("value", "Value (% or Rs)", input("value", `inputmode="decimal" value="${esc(d.type === "amount" ? rupeesField(d.value) : d.value)}"`))}
          ${row("minPurchase", "Minimum purchase (Rs, optional)", input("minPurchase", `inputmode="decimal" value="${esc(d.minPurchase ? rupeesField(d.minPurchase) : "")}"`))}
          ${row("validFrom", "Valid from (optional)", input("validFrom", `type="date" value="${esc(d.validFrom ?? "")}"`))}
          ${row("validTo", "Valid until (optional)", input("validTo", `type="date" value="${esc(d.validTo ?? "")}"`))}
          ${row("usageLimit", "Total uses allowed (0 = no limit)", input("usageLimit", `inputmode="numeric" value="${d.usageLimit ?? 0}"`))}
          ${row("perCustomerLimit", "Uses per customer (0 = no limit)", input("perCustomerLimit", `inputmode="numeric" value="${d.perCustomerLimit ?? 0}"`))}
          <fieldset class="field"><legend>Only for these categories (none ticked = all items)</legend>${cats.map((c) => `<label class="check"><input type="checkbox" name="dcat" value="${esc(c.id)}" ${(d.categoryIds ?? []).includes(c.id) ? "checked" : ""} /> ${esc(c.name)}</label>`).join(" ")}</fieldset>`,
        async onSubmit(f, { show: showErr, close }) {
          const g = /** @type {any} */ (f.elements);
          const amount = g.type.value === "amount";
          const raw = amount ? toPaisa(g.value.value) : num(g.value.value);
          const min = toPaisa(g.minPurchase.value);
          const parsed = saveCrmDiscountInput.safeParse({
            ...(existing ? { id: existing.id } : {}), name: g.name.value, scope: g.scope.value, tier: g.tier.value, segment: g.segment.value, customerId: g.customerId.value.trim() || null, type: g.type.value,
            value: raw, minPurchase: min ?? 0, validFrom: g.validFrom.value, validTo: g.validTo.value, usageLimit: num(g.usageLimit.value) || 0, perCustomerLimit: num(g.perCustomerLimit.value) || 0,
            categoryIds: [...f.querySelectorAll('[name="dcat"]:checked')].map((x) => /** @type {HTMLInputElement} */ (x).value), productIds: existing?.productIds ?? [], isActive: existing ? existing.isActive !== false : true,
          });
          if (!parsed.success) return showErr("Please check the highlighted fields.", fieldErrors(parsed.error));
          await call("saveCrmDiscount", parsed.data);
          close();
          toast("Saved.");
          show();
        },
      });
    }
  }
  await show();
}
