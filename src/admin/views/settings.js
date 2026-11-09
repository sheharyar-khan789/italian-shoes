/**
 * Store settings (Owner only). Validated in the browser for instant feedback and again on the
 * server by the saveSettings Cloud Function, which also records the change in the activity log.
 */
import { esc } from "../../lib/format.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, errorState } from "../ui/kit.js";
import { loadSettings, saveSettings } from "../data.js";
import { saveSettingsSchema, fieldErrors } from "../../../shared/schemas/index.js";
import { STORE_DEFAULTS } from "../../config.js";

/** Details already confirmed by the owner (from the store's Instagram), offered only when nothing is saved yet. */
const KNOWN = {
  storeName: STORE_DEFAULTS.name,
  storeNameUrdu: STORE_DEFAULTS.nameUrdu,
  phone: STORE_DEFAULTS.phone,
  address: STORE_DEFAULTS.address,
  instagram: STORE_DEFAULTS.instagram,
};

const toggle = (name, label, checked, hint = "") => `
  <div class="field field--check" data-field="${name}">
    <label class="check"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} /> ${esc(label)}</label>
    ${hint ? `<p class="field-hint">${esc(hint)}</p>` : ""}
    <p class="field-error" hidden></p>
  </div>`;

export default async function settingsView({ main }) {
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading settings…</p></div>`;
  let saved;
  try {
    saved = await loadSettings();
  } catch {
    main.innerHTML = errorState();
    main.querySelector("[data-retry]")?.addEventListener("click", () => settingsView({ main }));
    return;
  }
  const firstTime = !saved.public;
  const pub = /** @type {Record<string, any>} */ (saved.public ?? KNOWN);
  const priv = /** @type {Record<string, any>} */ (saved.private ?? {});
  const v = (o, k) => (o[k] ?? "").toString();

  main.innerHTML = `
    <div class="adm-page adm-page--narrow">
      <header class="adm-page__head">
        <h1 class="adm-h1">Store <em>settings</em></h1>
        <p class="muted">Shown on the website and used by checkout. Changes are saved for everyone immediately and recorded in the activity log.</p>
      </header>
      ${
        firstTime
          ? `<div class="notice" role="note"><strong>Not saved yet.</strong> We've filled in the details you already gave us (from the store's Instagram). Check them, add anything missing, then save.</div>`
          : ""
      }
      <form class="adm-form" novalidate data-form>
        <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>

        <fieldset class="adm-fieldset">
          <legend>Store details</legend>
          ${field({ name: "public.storeName", label: "Store name", required: true, maxlength: 80, value: v(pub, "storeName") }, "set")}
          ${field({ name: "public.storeNameUrdu", label: "Store name in Urdu", required: false, maxlength: 80, value: v(pub, "storeNameUrdu") }, "set")}
          ${field({ name: "public.phone", label: "Phone", type: "tel", required: false, maxlength: 30, value: v(pub, "phone") }, "set")}
          ${field({ name: "public.email", label: "Email", type: "email", required: false, maxlength: 254, value: v(pub, "email") }, "set")}
          ${field({ name: "public.address", label: "Address", required: false, maxlength: 200, value: v(pub, "address") }, "set")}
          ${field({ name: "public.hours", label: "Opening hours", required: false, maxlength: 120, hint: "e.g. Mon–Sat 11am–10pm", value: v(pub, "hours") }, "set")}
        </fieldset>

        <fieldset class="adm-fieldset">
          <legend>Links</legend>
          ${field({ name: "public.instagram", label: "Instagram", type: "url", required: false, maxlength: 300, hint: "Full link starting with https://", value: v(pub, "instagram") }, "set")}
          ${field({ name: "public.facebook", label: "Facebook", type: "url", required: false, maxlength: 300, value: v(pub, "facebook") }, "set")}
        </fieldset>

        <fieldset class="adm-fieldset">
          <legend>Website</legend>
          ${field({ name: "public.announcement", label: "Announcement bar", required: false, maxlength: 140, hint: "Short line above the header. Leave empty to hide it.", value: v(pub, "announcement") }, "set")}
          ${toggle("public.isOpen", "Store is open for orders", pub.isOpen ?? true)}
          ${toggle("public.registrationOpen", "Customers can create accounts", pub.registrationOpen ?? true)}
          ${field({ name: "public.seoTitle", label: "Search engine title", required: false, maxlength: 70, value: v(pub, "seoTitle") }, "set")}
          ${field({ name: "public.seoDescription", label: "Search engine description", required: false, maxlength: 160, textarea: true, value: v(pub, "seoDescription") }, "set")}
        </fieldset>

        <fieldset class="adm-fieldset">
          <legend>Orders &amp; stock</legend>
          ${field({ name: "private.orderPrefix", label: "Order number prefix", required: true, maxlength: 6, hint: "2–6 letters, e.g. IS → order IS-2026-000123", value: v(priv, "orderPrefix") }, "set")}
          ${field({ name: "private.lowStockThreshold", label: "Low-stock alert level", type: "number", inputmode: "numeric", required: true, hint: "Alert when a size has this many pairs or fewer", value: v(priv, "lowStockThreshold") }, "set")}
          ${toggle("private.notifyNewOrders", "Notify staff about new orders", priv.notifyNewOrders ?? true)}
          ${toggle("private.notifyLowStock", "Notify staff about low stock", priv.notifyLowStock ?? true)}
        </fieldset>

        <fieldset class="adm-fieldset">
          <legend>Tax</legend>
          ${toggle("private.taxEnabled", "Add tax at checkout", priv.taxEnabled ?? false, "Only turn this on if your accountant has told you to charge it.")}
          ${field({ name: "private.taxRatePercent", label: "Tax rate (%)", type: "number", inputmode: "decimal", required: false, value: v(priv, "taxRatePercent") || "0" }, "set")}
        </fieldset>

        <p class="fine">Currency: Pakistani Rupee (PKR). Logo upload arrives with product images in Phase 5.</p>
        <div class="adm-form__actions">
          <button type="submit" class="btn btn--primary"><span>Save settings</span></button>
        </div>
      </form>
    </div>`;

  const form = /** @type {HTMLFormElement} */ (main.querySelector("[data-form]"));

  const read = () => {
    const out = { public: {}, private: {} };
    for (const el of form.elements) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.name.includes(".")) continue;
      const [group, key] = el.name.split(".");
      out[group][key] = el.type === "checkbox" ? /** @type {HTMLInputElement} */ (el).checked : el.type === "number" ? (el.value === "" ? NaN : Number(el.value)) : el.value;
    }
    out.public.currency = "PKR";
    return out;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsed = saveSettingsSchema.safeParse(read());
    if (!parsed.success) {
      showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
      return;
    }
    const result = await busy(form, async () => {
      try {
        const { changed } = await saveSettings(parsed.data);
        return { ok: true, changed };
      } catch (error) {
        const fields = /** @type {any} */ (error)?.details?.fields;
        return { ok: false, message: /** @type {any} */ (error)?.code?.startsWith?.("functions/") && error.code !== "functions/internal" ? error.message : "Settings couldn't be saved. Please try again.", fields };
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast(result.changed.length ? "Settings saved." : "No changes to save.");
      main.querySelector(".notice")?.remove();
    }
  });
}
