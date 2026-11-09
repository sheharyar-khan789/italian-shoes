/**
 * Website content: home-page sections, banners, FAQs and pages (About, Shipping, Returns, Privacy,
 * Terms …). Everything is written by the owner as plain text; the storefront shows nothing for a
 * section until it has been written. Pages stay hidden until "Published" is ticked.
 */
import { esc } from "../../lib/format.js";
import { slugify } from "../../../shared/slug.js";
import { field, showResult, busy } from "../../ui/forms.js";
import { toast, confirmDialog, errorState, emptyState } from "../ui/kit.js";
import { call, listBanners, listFaqs, listPages, homeContent } from "../engageData.js";
import { saveBannerInput, saveFaqInput, savePageInput, saveHomeInput, fieldErrors } from "../../../shared/schemas/index.js";
import { fnResult } from "./catalogue.js";

const TABS = [
  { key: "home", label: "Home page" },
  { key: "banners", label: "Banners" },
  { key: "faqs", label: "FAQs" },
  { key: "pages", label: "Pages" },
];

export default async function content({ main }) {
  let tab = "home";
  let editing = null;
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Website <em>content</em></h1>
        <p class="muted">Write what customers read. Nothing is filled in for you: a section stays hidden on the website until you add it.</p>
      </header>
      <div class="adm-tabs" role="tablist" aria-label="Content">${TABS.map((t) => `<button type="button" role="tab" class="adm-tab" data-tab="${t.key}" aria-selected="${t.key === tab}">${t.label}</button>`).join("")}</div>
      <div data-panel></div>
    </div>`;
  const panel = main.querySelector("[data-panel]");

  const run = async (form, fn, parsed, okMsg) => {
    if (!parsed.success) return showResult(form, { ok: false, message: "Please check the highlighted fields.", fields: fieldErrors(parsed.error) });
    const result = await busy(form, async () => {
      try {
        await call(fn, parsed.data);
        return { ok: true };
      } catch (error) {
        return fnResult(error);
      }
    }, "Saving…");
    showResult(form, result);
    if (result.ok) {
      toast(okMsg);
      editing = null;
      draw();
    }
  };
  const del = async (fn, payload, title) => {
    if (!(await confirmDialog({ title, body: "This can't be undone.", confirm: "Delete", danger: true }))) return;
    try {
      await call(fn, payload);
      toast("Deleted.");
      draw();
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
  };
  const alertBox = `<p class="form-alert" role="alert" tabindex="-1" data-form-alert hidden></p>`;
  const sortField = (v) => field({ name: "sortOrder", label: "Order", required: false, inputmode: "numeric", hint: "Smaller numbers come first", value: v ?? 0 }, "c");
  const actions = (kind, id) => `<button type="button" class="text-btn" data-edit="${esc(id)}" data-kind="${kind}">Edit</button> <button type="button" class="text-btn" data-del="${esc(id)}" data-kind="${kind}">Delete</button>`;

  async function draw() {
    panel.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      if (tab === "home") return await drawHome();
      if (tab === "banners") return await drawBanners();
      if (tab === "faqs") return await drawFaqs();
      return await drawPages();
    } catch {
      panel.innerHTML = errorState();
      panel.querySelector("[data-retry]")?.addEventListener("click", draw);
    }
  }

  async function drawHome() {
    const h = (await homeContent()) ?? {};
    const box = (name, label) => `<label class="check"><input type="checkbox" name="${name}" ${h[name] === false ? "" : "checked"} /> ${label}</label>`;
    panel.innerHTML = `<form class="adm-form adm-card" novalidate data-home>${alertBox}
      <h2 class="adm-h2">Home page sections</h2>
      ${box("showBanners", "Banners")}${box("showCategories", "Shop by category")}${box("showFeatured", "Featured products")}${box("showNewArrivals", "New arrivals")}
      ${field({ name: "introTitle", label: "Intro heading", required: false, maxlength: 80, value: h.introTitle }, "h")}
      ${field({ name: "introText", label: "Intro text", required: false, textarea: true, maxlength: 400, value: h.introText }, "h")}
      ${field({ name: "featuredProductIds", label: "Featured product ids", required: false, hint: "Up to 12 published product ids, separated by commas (find an id in the product's address).", value: (h.featuredProductIds ?? []).join(", ") }, "h")}
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save</span></button></div></form>`;
  }

  async function drawBanners() {
    const rows = await listBanners();
    const b = editing ? rows.find((r) => r.id === editing) : null;
    panel.innerHTML = `${rows.length ? `<ul class="adm-list">${rows.map((r) => `<li><strong>${esc(r.title)}</strong> ${r.isActive ? "" : `<span class="tag">Off</span>`} ${actions("banner", r.id)}</li>`).join("")}</ul>` : emptyState({ title: "No banners yet" })}
      <form class="adm-form adm-card" novalidate data-banner="${esc(b?.id ?? "")}">${alertBox}<h2 class="adm-h2">${b ? "Edit banner" : "Add a banner"}</h2>
      ${field({ name: "title", label: "Title", required: true, maxlength: 80, value: b?.title }, "c")}
      ${field({ name: "subtitle", label: "Subtitle", required: false, maxlength: 160, value: b?.subtitle }, "c")}
      ${field({ name: "linkUrl", label: "Link", required: false, maxlength: 300, hint: "A page like /shop, or a full https:// link", value: b?.linkUrl }, "c")}
      ${field({ name: "linkLabel", label: "Button text", required: false, maxlength: 30, value: b?.linkLabel }, "c")}
      ${sortField(b?.sortOrder)}
      <label class="check"><input type="checkbox" name="isActive" ${b?.isActive === false ? "" : "checked"} /> Show on the website</label>
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save banner</span></button></div></form>`;
  }

  async function drawFaqs() {
    const rows = await listFaqs();
    const q = editing ? rows.find((r) => r.id === editing) : null;
    panel.innerHTML = `${rows.length ? `<ul class="adm-list">${rows.map((r) => `<li><strong>${esc(r.question)}</strong> ${r.isActive ? "" : `<span class="tag">Off</span>`} ${actions("faq", r.id)}</li>`).join("")}</ul>` : emptyState({ title: "No FAQs yet" })}
      <form class="adm-form adm-card" novalidate data-faq="${esc(q?.id ?? "")}">${alertBox}<h2 class="adm-h2">${q ? "Edit question" : "Add a question"}</h2>
      ${field({ name: "question", label: "Question", required: true, maxlength: 200, value: q?.question }, "c")}
      ${field({ name: "answer", label: "Answer", required: true, textarea: true, maxlength: 1500, value: q?.answer }, "c")}
      ${sortField(q?.sortOrder)}
      <label class="check"><input type="checkbox" name="isActive" ${q?.isActive === false ? "" : "checked"} /> Show on the website</label>
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save question</span></button></div></form>`;
  }

  async function drawPages() {
    const rows = await listPages();
    const p = editing ? rows.find((r) => r.id === editing) : null;
    panel.innerHTML = `${rows.length ? `<ul class="adm-list">${rows.map((r) => `<li><strong>${esc(r.title)}</strong> <span class="muted">/${esc(r.id)}</span> ${r.isPublished ? "" : `<span class="tag">Draft</span>`} ${actions("page", r.id)}</li>`).join("")}</ul>` : emptyState({ title: "No pages yet", text: "Typical pages: About, Shipping, Returns, Privacy, Terms." })}
      <form class="adm-form adm-card" novalidate data-page="${esc(p?.id ?? "")}">${alertBox}<h2 class="adm-h2">${p ? "Edit page" : "Add a page"}</h2>
      ${field({ name: "title", label: "Title", required: true, maxlength: 80, value: p?.title }, "c")}
      ${field({ name: "slug", label: "Address", required: true, maxlength: 120, hint: "Lower-case, e.g. about or returns-policy. The page appears at /p/<address>.", value: p?.id }, "c").replace("<input", p ? "<input readonly" : "<input")}
      ${field({ name: "body", label: "Text", required: true, textarea: true, maxlength: 8000, hint: "Plain text. Leave a blank line between paragraphs.", value: p?.body }, "c")}
      ${field({ name: "seoTitle", label: "Search title", required: false, maxlength: 70, value: p?.seoTitle }, "c")}
      ${field({ name: "seoDescription", label: "Search description", required: false, maxlength: 160, value: p?.seoDescription }, "c")}
      <label class="check"><input type="checkbox" name="isPublished" ${p?.isPublished ? "checked" : ""} /> Published (visible to customers)</label>
      <div class="form-actions"><button class="btn btn--primary" type="submit"><span>Save page</span></button></div></form>`;
  }

  const num = (v) => (String(v ?? "").trim() === "" ? 0 : Number(v));
  main.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const fd = new FormData(form);
    const on = (n) => fd.get(n) === "on";
    if (form.matches("[data-home]")) {
      const ids = String(fd.get("featuredProductIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return run(form, "saveHome", saveHomeInput.safeParse({ showBanners: on("showBanners"), showCategories: on("showCategories"), showFeatured: on("showFeatured"), showNewArrivals: on("showNewArrivals"), featuredProductIds: ids, introTitle: fd.get("introTitle") ?? "", introText: fd.get("introText") ?? "" }), "Home page saved.");
    }
    if (form.matches("[data-banner]")) {
      const id = form.dataset.banner || undefined;
      return run(form, "saveBanner", saveBannerInput.safeParse({ ...(id ? { id } : {}), title: fd.get("title"), subtitle: fd.get("subtitle") ?? "", linkUrl: fd.get("linkUrl") ?? "", linkLabel: fd.get("linkLabel") ?? "", sortOrder: num(fd.get("sortOrder")), isActive: on("isActive") }), "Banner saved.");
    }
    if (form.matches("[data-faq]")) {
      const id = form.dataset.faq || undefined;
      return run(form, "saveFaq", saveFaqInput.safeParse({ ...(id ? { id } : {}), question: fd.get("question"), answer: fd.get("answer"), sortOrder: num(fd.get("sortOrder")), isActive: on("isActive") }), "Question saved.");
    }
    if (form.matches("[data-page]")) {
      return run(form, "savePage", savePageInput.safeParse({ slug: slugify(String(fd.get("slug") ?? "")), title: fd.get("title"), body: fd.get("body"), seoTitle: fd.get("seoTitle") ?? "", seoDescription: fd.get("seoDescription") ?? "", isPublished: on("isPublished") }), "Page saved.");
    }
  });
  main.addEventListener("click", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const tabBtn = /** @type {HTMLElement | null} */ (t.closest("[data-tab]"));
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      editing = null;
      main.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === tabBtn)));
      return draw();
    }
    const edit = /** @type {HTMLElement | null} */ (t.closest("[data-edit]"));
    if (edit) {
      editing = edit.dataset.edit;
      return draw();
    }
    const d = /** @type {HTMLElement | null} */ (t.closest("[data-del]"));
    if (d) {
      const kind = d.dataset.kind;
      if (kind === "page") return del("deletePage", { slug: d.dataset.del }, "Delete this page?");
      return del("deleteContentItem", { kind, id: d.dataset.del }, kind === "banner" ? "Delete this banner?" : "Delete this question?");
    }
  });
  await draw();
}
