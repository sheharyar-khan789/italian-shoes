/**
 * Information pages. Anything the store has not confirmed is shown as a clearly marked
 * placeholder — no invented policies, fees, timelines or contact details.
 */
import { STORE } from "../config.js";
import { esc } from "../lib/format.js";
import { normalizeWhatsAppNumber } from "../lib/order.js";
import { placeholderNote, emptyState } from "../ui/components.js";

const TBC = `<span class="tbc">To be confirmed</span>`;

const policyBanner = () =>
  STORE.policiesConfirmed
    ? ""
    : `<div class="notice" role="note"><strong>Placeholder policy.</strong> This page is a template awaiting the store’s confirmed wording. Nothing here is an established store policy yet.</div>`;

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

export function sizeGuideTable(only) {
  const rows = only ? CONVERSION.filter((r) => only.includes(r[0])) : CONVERSION;
  return `
  <div class="size-guide">
    <table class="table">
      <caption class="visually-hidden">Shoe size conversion</caption>
      <thead><tr><th scope="col">EU</th><th scope="col">UK</th><th scope="col">US</th><th scope="col">Foot length</th></tr></thead>
      <tbody>${rows.map(([eu, uk, us, cm]) => `<tr><th scope="row">${eu}</th><td>${uk}</td><td>${us}</td><td>${cm} cm</td></tr>`).join("")}</tbody>
    </table>
    <p class="fine">EU 28–35 are children’s sizes (UK/US kids). From EU 36, US shows men’s sizing; US women’s is roughly 1.5 sizes larger. A general conversion guide. Fit can vary between styles — if you’re between sizes, ask the store on WhatsApp before ordering.</p>
    <h3>How to measure</h3>
    <ol class="steps-list">
      <li>Stand on a sheet of paper with your heel against a wall.</li>
      <li>Mark the tip of your longest toe, then measure from the wall to the mark.</li>
      <li>Measure both feet in the evening, and use the longer measurement.</li>
    </ol>
  </div>`;
}

const contactRows = () => {
  const c = STORE.contact;
  const wa = normalizeWhatsAppNumber(STORE.whatsappNumber);
  const row = (label, value) => `<div><dt>${label}</dt><dd>${value || TBC}</dd></div>`;
  return `
  <dl class="info-list">
    ${row("WhatsApp", wa ? `<a class="text-link" href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">Message the store</a>` : "")}
    ${row("Phone", c.phone && `<a class="text-link" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">${esc(c.phone)}</a>`)}
    ${row("Email", c.email && `<a class="text-link" href="mailto:${esc(c.email)}">${esc(c.email)}</a>`)}
    ${row("Address", esc(c.address))}
    ${row("Hours", esc(c.hours))}
    ${row("Instagram", c.instagram && `<a class="text-link" href="${esc(c.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`)}
  </dl>`;
};

const PAGES = {
  about: {
    title: "About the <em>store</em>",
    plain: "About",
    body: () => `
      ${placeholderNote("The store’s story will appear here — supplied and approved by the owner. Suggested sections are outlined below.")}
      <div class="prose">
        <h2>Our story</h2><p>${TBC} — how and when the store began.</p>
        <h2>What we stock</h2><p>Shoes for men, women and children — sneakers, formal and casual shoes, sandals, and school shoes. Specific brands, materials and sourcing: ${TBC}.</p>
        <h2>Visit or order</h2><p>${STORE.name ? esc(STORE.name) : "The store"} is on ${STORE.contact.address ? esc(STORE.contact.address) : TBC}${STORE.contact.phone ? ` — contact ${esc(STORE.contact.phone)}` : ""}. Online orders are placed through this website and confirmed personally. Opening hours: ${STORE.contact.hours ? esc(STORE.contact.hours) : TBC}.</p>
      </div>`,
  },
  contact: {
    title: "Contact",
    plain: "Contact",
    body: () => `
      <div class="prose">
        <p>Questions about sizing, availability or an order? The store is happy to help.</p>
      </div>
      ${contactRows()}
      ${STORE.contact.email && STORE.contact.hours ? "" : `<p class="fine">Details marked “To be confirmed” haven’t been supplied by the store yet.</p>`}`,
  },
  faq: {
    title: "Frequently asked <em>questions</em>",
    plain: "FAQs",
    body: () => {
      const qa = [
        ["How do I place an order?", "Add the pairs you want to your bag, choosing a colour and size for each. At checkout, enter your contact and delivery details and review your order. Pressing “Place Order on WhatsApp” opens WhatsApp with your complete order written out, ready to send to the store."],
        ["Is my order confirmed when WhatsApp opens?", "No. Your order is only sent when you press Send in WhatsApp, and it is accepted when the store replies to confirm availability, delivery charges and your total."],
        ["How much is delivery?", STORE.deliveryFee === null ? "Delivery charges are confirmed by the store on WhatsApp for each order. A standard rate has not been published yet." : `Delivery is ${STORE.deliveryFee === 0 ? "free" : `Rs. ${STORE.deliveryFee}`}.`],
        ["How do I pay?", `Accepted payment methods: ${TBC}. The store will confirm payment options on WhatsApp.`],
        ["Can I exchange a size?", `Please see the <a class="text-link" href="/returns">returns &amp; exchanges</a> page. The policy is ${STORE.policiesConfirmed ? "published there" : "still to be confirmed by the store"}.`],
        ["Does the website keep my details?", "Your bag (products, colours, sizes and quantities) is saved in your browser so it survives a refresh. Your name, phone and address are not stored by this website — they are only placed into the WhatsApp message you choose to send."],
        ["Which sizes do you use?", `All sizes are EU. See the <a class="text-link" href="/size-guide">size guide</a> for UK and US conversions.`],
      ];
      return `<div class="faq">${qa.map(([q, a]) => `<details class="accordion"><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>`;
    },
  },
  "size-guide": {
    title: "Size <em>guide</em>",
    plain: "Size Guide",
    body: () => sizeGuideTable(),
  },
  shipping: {
    title: "Shipping &amp; <em>delivery</em>",
    plain: "Shipping & Delivery",
    policy: true,
    body: () => `
      <div class="prose">
        <h2>How delivery is arranged</h2>
        <p>After you send your order on WhatsApp, the store confirms availability, the delivery charge and your final total before dispatch.</p>
        <h2>Delivery charges</h2><p>${STORE.deliveryFee === null ? TBC : STORE.deliveryFee === 0 ? "Free" : `Rs. ${STORE.deliveryFee}`}</p>
        <h2>Areas we deliver to</h2><p>${TBC}</p>
        <h2>Delivery times</h2><p>${TBC}</p>
        <h2>Payment on delivery</h2><p>${TBC}</p>
      </div>`,
  },
  returns: {
    title: "Returns &amp; <em>exchanges</em>",
    plain: "Returns & Exchanges",
    policy: true,
    body: () => `
      <div class="prose">
        <h2>Size exchanges</h2><p>${TBC}</p>
        <h2>Returns</h2><p>${TBC}</p>
        <h2>Condition of items</h2><p>${TBC}</p>
        <h2>How to request an exchange</h2><p>${TBC} — likely by messaging the store on WhatsApp with your order reference.</p>
      </div>`,
  },
  privacy: {
    title: "Privacy <em>policy</em>",
    plain: "Privacy Policy",
    policy: true,
    body: () => `
      <div class="prose">
        <h2>What this website stores</h2>
        <p>Your shopping bag — product, colour, size and quantity — and a short list of products you recently viewed are saved in your browser’s local storage so they are kept between visits. They contain no personal information and never leave your device through this website.</p>
        <h2>Checkout details</h2>
        <p>The name, phone number and address you enter at checkout are used only to compose your WhatsApp order message. This website does not save them or send them anywhere; they reach the store only if you send that message in WhatsApp.</p>
        <h2>How the store uses your order information</h2><p>${TBC}</p>
        <h2>Third-party services</h2><p>The site loads web fonts from Google Fonts and a 3D model and code from the jsDelivr CDN. WhatsApp is operated by Meta and has its own privacy policy. Analytics: ${TBC}.</p>
        <h2>Contact</h2><p>${TBC}</p>
      </div>`,
  },
  terms: {
    title: "Terms &amp; <em>conditions</em>",
    plain: "Terms & Conditions",
    policy: true,
    body: () => `
      <div class="prose">
        <h2>Orders</h2><p>An order is accepted only when the store confirms it on WhatsApp. Opening WhatsApp from this site does not place or confirm an order.</p>
        <h2>Prices</h2><p>Prices are shown in Pakistani Rupees. ${STORE.demoCatalog ? "The products and prices currently shown are sample data for demonstration." : ""} Other pricing terms: ${TBC}.</p>
        <h2>Availability</h2><p>${TBC}</p>
        <h2>Payment</h2><p>${TBC}</p>
        <h2>Governing terms</h2><p>${TBC}</p>
      </div>`,
  },
};

export default function infoPage({ outlet, params }) {
  const page = PAGES[params[0]];
  if (!page) return notFound({ outlet });
  document.title = page.plain;
  outlet.innerHTML = `
  <div class="page page--narrow info">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>${page.policy ? "Policies" : "Information"}</p>
      <h1 class="page-title">${page.title}</h1>
    </header>
    ${page.policy ? policyBanner() : ""}
    ${page.body()}
  </div>`;
}

export function notFound({ outlet }) {
  document.title = "Page not found";
  outlet.innerHTML = `<div class="page page--narrow">${emptyState({ title: "This page doesn’t exist.", text: "The link may be broken, or the page may have moved." })}</div>`;
}
