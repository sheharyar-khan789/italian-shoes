/**
 * Coupons & offers. The owner creates codes; the server checks every rule again when a customer
 * uses one. Nothing is pre-made: until a coupon is added, customers have no discount codes.
 */
import { esc } from "../../lib/format.js";
import { formatPKR } from "../../../shared/money.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { rupeesField, toPaisa } from "../ui/money.js";
import { call, listCoupons } from "../engageData.js";
import { saveCouponInput, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

/** Date value for <input type="datetime-local"> in the viewer's own time. */
const toLocalInput = (ts) => {
  if (!ts) return "";
  const d = ts.toDate();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const describe = (c) => (c.type === "percent" ? `${c.value}% off` : `${formatPKR(c.value)} off`);

export default async function coupons({ main }) {
  main.innerHTML = `<div class="adm-page"><p class="muted">Loading…</p></div>`;
  let rows;
  try {
    rows = await listCoupons();
  } catch {
    main.innerHTML = `<div class="adm-page">${errorState()}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => coupons({ main }));
    return;
  }
  const reload = () => coupons({ main });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const state = (c) => {
    const now = Date.now();
    if (!c.isActive) return "Off";
    if (c.endsAt && c.endsAt.toMillis() < now) return "Expired";
    if (c.startsAt && c.startsAt.toMillis() > now) return "Scheduled";
    if (c.usageLimit != null && c.usedCount >= c.usageLimit) return "Fully used";
    return "Live";
  };

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Coupons <em>&amp; offers</em></h1>
        <p class="muted">Create discount codes for customers. A code is checked again on the server when it's used, so limits can't be bypassed.</p>
      </header>
      ${
        rows.length
          ? `<div class="adm-table-wrap"><table class="adm-table"><caption class="visually-hidden">Coupons</caption>
          <thead><tr><th scope="col">Code</th><th scope="col">Discount</th><th scope="col">Status</th><th scope="col">Used</th><th scope="col">Valid</th><th scope="col"></th></tr></thead>
          <tbody>${rows
            .map(
              (c) => `<tr><td data-label="Code"><strong>${esc(c.id)}</strong></td><td data-label="Discount">${esc(describe(c))}${c.minOrder ? `<br><span class="muted">min ${esc(formatPKR(c.minOrder))}</span>` : ""}</td>
              <td data-label="Status"><span class="tag">${state(c)}</span></td>
              <td data-label="Used">${c.usedCount ?? 0}${c.usageLimit != null ? ` / ${c.usageLimit}` : ""}</td>
              <td data-label="Valid">${c.startsAt || c.endsAt ? `${c.startsAt ? esc(formatWhen(c.startsAt)) : "Now"} → ${c.endsAt ? esc(formatWhen(c.endsAt)) : "No end"}` : "Always"}</td>
              <td class="adm-actions"><button type="button" class="text-btn" data-edit="${esc(c.id)}">Edit</button> <button type="button" class="text-btn" data-delete="${esc(c.id)}">Delete</button></td></tr>`,
            )
            .join("")}</tbody></table></div>`
          : emptyState({ title: "No coupons yet", text: "Add your first code below." })
      }
      <section class="adm-section adm-card" data-form-slot><h2 class="adm-h2">Add a coupon</h2>${couponForm()}</section>
    </div>`;

  function couponForm(c = null) {
    const id = c ? "e" : "n";
    return `<form class="adm-form" novalidate data-coupon-form>
      <p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>
      ${field({ name: "code", label: "Code", required: true, maxlength: 40, hint: "Letters, numbers, dash or underscore. Customers type this at checkout.", value: c?.id }, id).replace("<input", c ? "<input readonly" : "<input")}
      <div class="adm-grid3">
        <div class="field" data-field="type"><label for="${id}-type">Type</label>
          <select id="${id}-type" name="type"><option value="percent" ${c?.type === "fixed" ? "" : "selected"}>Percent off</option><option value="fixed" ${c?.type === "fixed" ? "selected" : ""}>Fixed amount off (Rs)</option></select><p class="field-error" id="${id}-type-error" hidden></p></div>
        ${field({ name: "value", label: "Value", required: true, inputmode: "decimal", hint: "Percent (1–100) or rupees, depending on the type", value: c ? (c.type === "percent" ? String(c.value) : rupeesField(c.value)) : "" }, id)}
        ${field({ name: "minOrder", label: "Minimum order (Rs)", required: false, inputmode: "decimal", value: c?.minOrder ? rupeesField(c.minOrder) : "" }, id)}
      </div>
      <div class="adm-grid3">
        ${field({ name: "maxDiscount", label: "Largest discount (Rs)", required: false, inputmode: "decimal", hint: "Caps a percentage coupon", value: c?.maxDiscount ? rupeesField(c.maxDiscount) : "" }, id)}
        ${field({ name: "usageLimit", label: "Total uses allowed", required: false, inputmode: "numeric", value: c?.usageLimit ?? "" }, id)}
        ${field({ name: "perCustomerLimit", label: "Uses per customer", required: false, inputmode: "numeric", value: c?.perCustomerLimit ?? "" }, id)}
      </div>
      <div class="adm-grid3">
        ${field({ name: "startsAt", label: "Starts", required: false, type: "datetime-local", value: toLocalInput(c?.startsAt) }, id)}
        ${field({ name: "endsAt", label: "Ends", required: false, type: "datetime-local", value: toLocalInput(c?.endsAt) }, id)}
      </div>
      <p class="muted">Product and category restrictions can be added here once your catalogue is ready: paste ids separated by commas (optional).</p>
      ${field({ name: "categoryIds", label: "Only these category ids", required: false, value: (c?.categoryIds ?? []).join(", ") }, id)}
      ${field({ name: "productIds", label: "Only these product ids", required: false, value: (c?.productIds ?? []).join(", ") }, id)}
      <label class="check"><input type="checkbox" name="isActive" ${c?.isActive === false ? "" : "checked"} /> Active</label>
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>${c ? "Save coupon" : "Add coupon"}</span></button></div></form>`;
  }

  const num = (v) => (String(v ?? "").trim() === "" ? null : Number(v));
  const ids = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  main.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const fd = new FormData(form);
    const type = fd.get("type");
    const parsed = saveCouponInput.safeParse({
      code: fd.get("code"),
      type,
      value: type === "percent" ? num(fd.get("value")) : toPaisa(String(fd.get("value") ?? "")),
      minOrder: toPaisa(String(fd.get("minOrder") ?? "")) ?? 0,
      maxDiscount: toPaisa(String(fd.get("maxDiscount") ?? "")),
      startsAt: fd.get("startsAt") ? new Date(String(fd.get("startsAt"))).toISOString() : null,
      endsAt: fd.get("endsAt") ? new Date(String(fd.get("endsAt"))).toISOString() : null,
      usageLimit: num(fd.get("usageLimit")),
      perCustomerLimit: num(fd.get("perCustomerLimit")),
      categoryIds: ids(fd.get("categoryIds")),
      productIds: ids(fd.get("productIds")),
      isActive: fd.get("isActive") === "on",
    });
    if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
    const result = await busy(form, async () => {
      try {
        await call("saveCoupon", { ...parsed.data, startsAt: parsed.data.startsAt?.toISOString() ?? null, endsAt: parsed.data.endsAt?.toISOString() ?? null });
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast("Coupon saved.");
      reload();
    }
  });

  main.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const edit = t.closest("[data-edit]");
    const del = t.closest("[data-delete]");
    if (edit) {
      const c = rows.find((r) => r.id === /** @type {HTMLElement} */ (edit).dataset.edit);
      const slot = main.querySelector("[data-form-slot]");
      slot.innerHTML = `<h2 class="adm-h2">Edit ${esc(c.id)}</h2>${couponForm(c)}`;
      slot.scrollIntoView({ block: "center" });
    }
    if (del) {
      const code = /** @type {HTMLElement} */ (del).dataset.delete;
      if (!(await confirmDialog({ title: `Delete ${code}?`, body: "Customers can't use it any more. Past orders keep the discount they received.", confirm: "Delete", danger: true }))) return;
      try {
        await call("deleteCoupon", { code });
        toast("Coupon deleted.");
        reload();
      } catch (error) {
        toast(fnResult(error).message, "error");
      }
    }
  });
}
