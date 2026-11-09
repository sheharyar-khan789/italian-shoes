/**
 * Shipping: delivery methods and the charge for each city. Everything is entered by the owner;
 * no fee or delivery time is ever assumed. Customers can't check out until this is set up.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, emptyState } from "../ui/kit.js";
import { rupeesField, toPaisa } from "../ui/money.js";
import { call, listShippingMethods, listShippingRates } from "../payData.js";
import { saveShippingMethodInput, saveShippingRateInput, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

export default async function shipping({ main, user }) {
  const canEdit = user.perms.includes("shipping.manage");
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading…</p></div>`;
  let methods, rates;
  try {
    [methods, rates] = await Promise.all([listShippingMethods(), listShippingRates()]);
  } catch {
    main.innerHTML = `<div class="adm-page">${errorState()}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => shipping({ main, user }));
    return;
  }
  const reload = () => shipping({ main, user });
  const ratesOf = (id) => rates.filter((r) => r.methodId === id).sort((a, b) => Number(a.city === "*") - Number(b.city === "*") || a.city.localeCompare(b.city));
  const ready = methods.some((m) => m.isActive && ratesOf(m.id).length);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Shipping <em>&amp; delivery</em></h1>
        <p class="muted">Add a delivery method, then the charge for each city. Customers see these at checkout. Nothing is assumed: until you add a rate, customers can't place orders.</p>
      </header>
      <div class="notice ${ready ? "notice--ok" : ""}" role="status">
        ${ready ? "<strong>Delivery is set up.</strong> Customers can check out." : "<strong>Delivery isn't set up yet.</strong> Add an active method with at least one rate (use “All other cities” for a single flat charge)."}
      </div>
      <div data-methods>${methods.length ? methods.map(methodCard).join("") : emptyState({ title: "No delivery methods yet", text: "Start with one, for example “Standard delivery”." })}</div>
      ${canEdit ? `<section class="adm-section adm-card"><h2 class="adm-h2">Add a delivery method</h2>${methodForm()}</section>` : ""}
    </div>`;

  function methodCard(m) {
    const rs = ratesOf(m.id);
    return `<section class="adm-section adm-card" data-method="${esc(m.id)}">
      <header class="adm-card__head">
        <div><h2 class="adm-h2">${esc(m.name)} ${m.isActive ? "" : `<span class="tag">Off</span>`}</h2>
          ${m.description ? `<p class="muted">${esc(m.description)}</p>` : ""}
          <p class="muted">${m.estimateText ? `Estimate shown to customers: ${esc(m.estimateText)}` : "No delivery time is shown to customers."}</p></div>
        ${canEdit ? `<span class="adm-photo__btns"><button type="button" class="text-btn" data-edit-method="${esc(m.id)}">Edit</button> <button type="button" class="text-btn" data-delete-method="${esc(m.id)}">Delete</button></span>` : ""}
      </header>
      ${
        rs.length
          ? `<div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Delivery charges for ${esc(m.name)}</caption>
              <thead><tr><th scope="col">City</th><th scope="col">Charge</th><th scope="col">Free delivery from</th><th scope="col"></th></tr></thead>
              <tbody>${rs
                .map(
                  (r) => `<tr><td data-label="City">${r.city === "*" ? "All other cities" : esc(r.city)}</td><td data-label="Charge">${r.charge ? esc(formatPKR(r.charge)) : "Free"}</td><td data-label="Free from">${r.freeOver ? esc(formatPKR(r.freeOver)) : "—"}</td>
                  <td class="adm-actions">${canEdit ? `<button type="button" class="text-btn" data-edit-rate="${esc(r.id)}">Edit</button> <button type="button" class="text-btn" data-delete-rate="${esc(r.id)}">Delete</button>` : ""}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
          : `<p class="muted">No charges yet — customers can't use this method.</p>`
      }
      ${canEdit ? `<details class="accordion"><summary>Add a city charge</summary>${rateForm(m.id)}</details>` : ""}
    </section>`;
  }

  function methodForm(m = {}) {
    return `<form class="adm-form" novalidate data-method-form="${esc(m.id ?? "")}">
      <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
      ${field({ name: "name", label: "Name", required: true, maxlength: 60, hint: "e.g. Standard delivery", value: m.name }, "sm")}
      ${field({ name: "description", label: "Description", required: false, maxlength: 300, value: m.description }, "sm")}
      ${field({ name: "estimateText", label: "Delivery time", required: false, maxlength: 80, hint: "Only if you want one shown, in your own words (e.g. 3–5 working days). Left empty, none is shown.", value: m.estimateText }, "sm")}
      <label class="check"><input type="checkbox" name="isActive" ${m.isActive === false ? "" : "checked"} /> Available to customers</label>
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>${m.id ? "Save method" : "Add method"}</span></button></div></form>`;
  }

  function rateForm(methodId, r = null) {
    const all = r?.city === "*";
    return `<form class="adm-form" novalidate data-rate-form="${esc(methodId)}">
      <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
      <div class="adm-grid3">
        ${field({ name: "city", label: "City", required: !all, maxlength: 60, hint: "e.g. Lahore", value: all ? "" : r?.city }, `r-${methodId}`)}
        ${field({ name: "charge", label: "Delivery charge (Rs)", required: true, inputmode: "decimal", hint: "0 for free delivery", value: r ? rupeesField(r.charge) : "" }, `r-${methodId}`)}
        ${field({ name: "freeOver", label: "Free delivery from (Rs)", required: false, inputmode: "decimal", hint: "Optional: orders at or above this are delivered free", value: r ? rupeesField(r.freeOver) : "" }, `r-${methodId}`)}
      </div>
      <label class="check"><input type="checkbox" name="allCities" ${all ? "checked" : ""} /> This charge is for all other cities</label>
      <div class="form-actions"><button class="btn btn--ghost" type="submit"><span>${r ? "Save charge" : "Add charge"}</span></button></div></form>`;
  }

  const send = async (form, fn, payload, okMsg, schemaResult) => {
    if (!schemaResult.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(schemaResult.error) });
    const result = await busy(form, async () => {
      try {
        await call(fn, payload ?? schemaResult.data);
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast(okMsg);
      reload();
    }
  };

  main.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const fd = new FormData(form);
    if (form.matches("[data-method-form]")) {
      const id = form.dataset.methodForm || undefined;
      const parsed = saveShippingMethodInput.safeParse({ ...(id ? { id } : {}), name: fd.get("name"), description: fd.get("description") ?? "", estimateText: fd.get("estimateText") ?? "", isActive: fd.get("isActive") === "on" });
      await send(form, "saveShippingMethod", null, id ? "Method saved." : "Method added.", parsed);
    } else if (form.matches("[data-rate-form]")) {
      const parsed = saveShippingRateInput.safeParse({
        methodId: form.dataset.rateForm,
        city: fd.get("allCities") === "on" ? "*" : fd.get("city"),
        charge: toPaisa(String(fd.get("charge") ?? "")),
        freeOver: toPaisa(String(fd.get("freeOver") ?? "")),
      });
      await send(form, "saveShippingRate", null, "Charge saved.", parsed);
    }
  });

  main.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const editMethod = t.closest("[data-edit-method]");
    const editRate = t.closest("[data-edit-rate]");
    const delMethod = t.closest("[data-delete-method]");
    const delRate = t.closest("[data-delete-rate]");
    const slot = (el, html) => {
      const card = /** @type {HTMLElement} */ (el.closest("[data-method]"));
      card.querySelector("[data-inline]")?.remove();
      card.insertAdjacentHTML("beforeend", `<div class="adm-inline" data-inline>${html}</div>`);
      /** @type {HTMLElement | null} */ (card.querySelector("[data-inline] input"))?.focus();
    };
    if (editMethod) slot(editMethod, methodForm(methods.find((m) => m.id === /** @type {HTMLElement} */ (editMethod).dataset.editMethod)));
    if (editRate) {
      const r = rates.find((x) => x.id === /** @type {HTMLElement} */ (editRate).dataset.editRate);
      slot(editRate, rateForm(r.methodId, r));
    }
    if (delRate) {
      if (!(await confirmDialog({ title: "Delete this charge?", body: "Past orders keep the delivery charge they were placed with.", confirm: "Delete", danger: true }))) return;
      try {
        await call("deleteShippingItem", { kind: "rate", id: /** @type {HTMLElement} */ (delRate).dataset.deleteRate });
        toast("Charge deleted.");
        reload();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    }
    if (delMethod) {
      if (!(await confirmDialog({ title: "Delete this delivery method?", body: "Its charges are deleted too. Past orders keep their own delivery details.", confirm: "Delete", danger: true }))) return;
      try {
        await call("deleteShippingItem", { kind: "method", id: /** @type {HTMLElement} */ (delMethod).dataset.deleteMethod });
        toast("Method deleted.");
        reload();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    }
  });
}
