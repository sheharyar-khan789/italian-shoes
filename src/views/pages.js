/**
 * Information pages. Their wording is written by the owner in the admin (Website content). Until a
 * page is published, the website says so plainly instead of showing made-up policies or details.
 */
import { esc } from "../lib/format.js";
import { emptyState } from "../ui/components.js";
import { getSettings, whenCatalog } from "../app/state.js";
import { loadPage, loadFaqs } from "../data/store.js";
import { setSeo, snippet } from "../lib/seo.js";

/** Owner-written plain text → safe paragraphs (blank line = new paragraph). */
export const paragraphs = (text) =>
  String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/** General EU→UK→US conversion with foot length. Fit varies by style, so it's labelled as a guide. */
const CONVERSION = [
  [28, 10, 11, 17.5],
  [29, 11, 12, 18],
  [30, 11.5, 12.5, 18.5],
  [31, 12.5, 13, 19.5],
  [32, 13, 1, 20],
  [33, 1, 2, 21],
  [34, 2, 2.5, 21.5],
  [35, 2.5, 3.5, 22],
  [36, 3.5, 5, 22.5],
  [37, 4, 6, 23.5],
  [38, 5, 7, 24],
  [39, 6, 7.5, 24.5],
  [40, 6.5, 8, 25.5],
  [41, 7.5, 8.5, 26],
  [42, 8, 9, 26.5],
  [43, 9, 10, 27.5],
  [44, 9.5, 10.5, 28],
  [45, 10.5, 11.5, 29],
  [46, 11, 12, 29.5],
];

/** @param {string[]} [only] size labels to show; rows are matched when the label is an EU number */
export function sizeGuideTable(only) {
  const wanted = only?.map((l) => Number(l)).filter(Number.isFinite);
  const rows = wanted?.length ? CONVERSION.filter((r) => wanted.includes(r[0])) : CONVERSION;
  return `
  <div class="size-guide">
    <table class="table">
      <caption class="visually-hidden">Shoe size conversion</caption>
      <thead><tr><th scope="col">EU</th><th scope="col">UK</th><th scope="col">US</th><th scope="col">Foot length</th></tr></thead>
      <tbody>${rows.map(([eu, uk, us, cm]) => `<tr><th scope="row">${eu}</th><td>${uk}</td><td>${us}</td><td>${cm} cm</td></tr>`).join("")}</tbody>
    </table>
    <p class="fine">EU 28–35 are children’s sizes (UK/US kids). From EU 36, US shows men’s sizing; US women’s is roughly 1.5 sizes larger. A general conversion guide: fit can vary between styles, so if you’re between sizes, please contact the store before ordering.</p>
    <h3>How to measure</h3>
    <ol class="steps-list">
      <li>Stand on a sheet of paper with your heel against a wall.</li>
      <li>Mark the tip of your longest toe, then measure from the wall to the mark.</li>
      <li>Measure both feet in the evening, and use the longer measurement.</li>
    </ol>
  </div>`;
}

const contactRows = () => {
  const s = getSettings();
  const rows = [
    s.phone && ["Phone", `<a class="text-link" href="tel:${esc(s.phone.replace(/[^\d+]/g, ""))}">${esc(s.phone)}</a>`],
    s.email && ["Email", `<a class="text-link" href="mailto:${esc(s.email)}">${esc(s.email)}</a>`],
    s.address && ["Address", esc(s.address)],
    s.hours && ["Hours", esc(s.hours)],
    s.instagram && ["Instagram", `<a class="text-link" href="${esc(s.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`],
  ].filter(Boolean);
  return rows.length ? `<dl class="info-list">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` : "";
};

/** Pages reachable at a fixed address; their text lives in the `pages` collection. */
const FIXED = {
  about: "About the store",
  contact: "Contact",
  shipping: "Shipping & delivery",
  returns: "Returns & exchanges",
  privacy: "Privacy policy",
  terms: "Terms & conditions",
};

const shell = (outlet, { kicker = "Information", title, body }) => {
  outlet.innerHTML = `
  <div class="page page--narrow info">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>${esc(kicker)}</p>
      <h1 class="page-title">${esc(title)}</h1>
    </header>
    ${body}
  </div>`;
};

/** An owner-written page by address (/about, /returns, /p/anything …). */
export default async function infoPage({ outlet, params }) {
  const slug = params[0];
  outlet.innerHTML = `<div class="page page--narrow info"><p class="muted">Loading…</p></div>`;
  await whenCatalog();

  if (slug === "faq") return faqPage(outlet);
  if (slug === "size-guide") {
    setSeo({ title: "Size guide", description: "Shoe size conversion and how to measure your foot." });
    return shell(outlet, { title: "Size guide", body: sizeGuideTable() });
  }

  let page;
  try {
    page = await loadPage(slug);
  } catch {
    return shell(outlet, { title: FIXED[slug] ?? "Page", body: `<p>This page couldn’t be loaded. Please check your connection and try again.</p>` });
  }
  const name = page?.title ?? FIXED[slug];
  if (!page && !name) return notFound({ outlet });
  setSeo({ title: page?.seoTitle || name, description: page?.seoDescription || snippet(page?.body ?? ""), noindex: !page });
  shell(outlet, {
    kicker: ["shipping", "returns", "privacy", "terms"].includes(slug) ? "Policies" : "Information",
    title: name,
    body: `${page ? `<div class="prose">${paragraphs(page.body)}</div>` : `<p class="muted">The store hasn’t published this page yet.</p>`}${slug === "contact" ? contactRows() : ""}`,
  });
}

async function faqPage(outlet) {
  setSeo({ title: "Frequently asked questions", description: "Answers from the store." });
  let items;
  try {
    items = await loadFaqs();
  } catch {
    return shell(outlet, { title: "Frequently asked questions", body: `<p>The questions couldn’t be loaded. Please try again.</p>` });
  }
  shell(outlet, {
    title: "Frequently asked questions",
    body: items.length
      ? `<div class="faq">${items.map((q) => `<details class="accordion"><summary>${esc(q.question)}</summary>${paragraphs(q.answer)}</details>`).join("")}</div>`
      : `<p class="muted">No questions have been added yet. Please contact the store if you need help.</p>`,
  });
}

export function notFound({ outlet }) {
  setSeo({ title: "Page not found", noindex: true });
  outlet.innerHTML = `<div class="page page--narrow">${emptyState({ title: "This page doesn’t exist.", text: "The link may be broken, or the page may have moved." })}</div>`;
}
