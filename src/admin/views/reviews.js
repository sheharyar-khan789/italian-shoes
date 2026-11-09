/** Reviews: approve, reject, reply to or delete customer reviews. Only approved ones are public. */
import { esc } from "../../lib/format.js";
import { toast, confirmDialog, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { call, listReviews } from "../engageData.js";
import { fnResult } from "./catalogue.js";

const STARS = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const LABEL = { pending: "Waiting", approved: "Published", rejected: "Hidden" };

export default async function reviews({ main }) {
  let status = "pending";
  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Customer <em>reviews</em></h1>
        <p class="muted">Every review is from a customer whose order was delivered. Nothing is shown on the website until you publish it.</p>
      </header>
      <div class="adm-filters adm-filters--one"><label class="visually-hidden" for="rv-status">Show</label>
        <select id="rv-status">${Object.entries(LABEL).map(([k, v]) => `<option value="${k}" ${k === status ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const box = main.querySelector("[data-list]");
  let items = [];
  let last = null;
  let hasMore = false;

  const draw = () => {
    if (!items.length) {
      box.innerHTML = emptyState({ title: `No ${LABEL[status].toLowerCase()} reviews`, text: status === "pending" ? "New reviews will appear here for you to approve." : "" });
      return;
    }
    box.innerHTML = `${items
      .map(
        (r) => `<article class="adm-card adm-review" data-id="${esc(r.id)}">
        <header><strong>${esc(r.productName ?? "Product")}</strong> <span class="tag">${esc(LABEL[r.status])}</span></header>
        <p class="adm-review__stars" aria-label="${r.rating} out of 5">${STARS(r.rating)}</p>
        ${r.title ? `<p><strong>${esc(r.title)}</strong></p>` : ""}<p>${esc(r.body)}</p>
        <p class="muted">${esc(r.authorName)} · ${esc(formatWhen(r.createdAt))}${r.verifiedPurchase ? " · Verified purchase" : ""}</p>
        <label class="visually-hidden" for="reply-${esc(r.id)}">Reply from the store</label>
        <textarea id="reply-${esc(r.id)}" rows="2" maxlength="500" placeholder="Optional public reply from the store">${esc(r.reply ?? "")}</textarea>
        <p class="adm-actions">
          ${r.status !== "approved" ? `<button type="button" class="btn btn--primary" data-set="approved">Publish</button>` : `<button type="button" class="btn btn--ghost" data-set="approved">Save reply</button>`}
          ${r.status !== "rejected" ? `<button type="button" class="btn btn--ghost" data-set="rejected">Hide</button>` : ""}
          <button type="button" class="text-btn" data-del>Delete</button></p>
      </article>`,
      )
      .join("")}${hasMore ? `<p class="adm-table__more"><button type="button" class="btn btn--ghost" data-more>Load more</button></p>` : ""}`;
  };

  const load = async (more = false) => {
    try {
      const page = await listReviews({ status, after: more ? last : undefined });
      items = more ? items.concat(page.items) : page.items;
      last = page.last;
      hasMore = page.hasMore;
      draw();
    } catch {
      box.innerHTML = errorState();
      box.querySelector("[data-retry]")?.addEventListener("click", () => load(more));
    }
  };

  main.querySelector("#rv-status").addEventListener("change", (e) => {
    status = /** @type {HTMLSelectElement} */ (e.target).value;
    load();
  });
  box.addEventListener("click", async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest("[data-more]")) return load(true);
    const card = /** @type {HTMLElement | null} */ (t.closest("[data-id]"));
    if (!card) return;
    const reviewId = card.dataset.id;
    const set = /** @type {HTMLElement | null} */ (t.closest("[data-set]"));
    try {
      if (set) {
        await call("moderateReview", { reviewId, status: set.dataset.set, reply: card.querySelector("textarea").value });
        toast(set.dataset.set === "approved" ? "Review published." : "Review hidden.");
        load();
      } else if (t.closest("[data-del]")) {
        if (!(await confirmDialog({ title: "Delete this review?", body: "This can't be undone.", confirm: "Delete", danger: true }))) return;
        await call("deleteReview", { reviewId });
        toast("Review deleted.");
        load();
      }
    } catch (error) {
      toast(fnResult(error).message, "error");
    }
  });
  await load();
}
