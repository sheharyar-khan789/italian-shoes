/**
 * DEMO CATALOGUE — SAMPLE DATA ONLY.
 *
 * These products, prices and stock levels are placeholders for a client demonstration.
 * They are NOT the store's real inventory. Replace this file with the owner's catalogue.
 *
 * Product shape:
 *   id          stable product identifier / SKU (appears in the WhatsApp order)
 *   slug        URL segment: /product/<slug>
 *   name, category (one of CATEGORIES ids), price (PKR selling price, whole rupees)
 *   compareAt   optional regular price; when higher than `price` the product shows as on sale
 *   added       ISO date, used for "Newest" sorting and New In
 *   featured    shown in the homepage Featured edit
 *   style       illustration used until real photos are supplied (see src/ui/illustration.js)
 *   colors[]    { id, name, family, hex, sole, images: [urls], stock: { size: qty } }
 *               Put real photos in /public/products/... and list them in `images`.
 *   sizes[]     EU sizes offered
 *   description, details[]
 */

export const CATEGORIES = [
  { id: "sneakers", name: "Sneakers", blurb: "Low-tops and runners for every day." },
  { id: "casual", name: "Casual", blurb: "Loafers and easy leather shoes." },
  { id: "formal", name: "Formal", blurb: "Oxfords and derbies for the occasion." },
  { id: "boots", name: "Boots", blurb: "Chelsea and desert boots." },
  { id: "sandals", name: "Sandals", blurb: "Open styles for warm days." },
  { id: "women", name: "Women", blurb: "Loafers, heels and everyday pairs." },
  { id: "kids", name: "Kids & School", blurb: "School shoes and the kids collection." },
];

export const COLOR_FAMILIES = [
  { id: "black", name: "Black", hex: "#1a1817" },
  { id: "brown", name: "Brown", hex: "#5a3a26" },
  { id: "tan", name: "Tan", hex: "#a8764b" },
  { id: "white", name: "White", hex: "#e9e4da" },
  { id: "navy", name: "Navy", hex: "#1f2a44" },
  { id: "rose", name: "Rose", hex: "#c99389" },
  { id: "grey", name: "Grey", hex: "#7d7a75" },
];

const MEN = [39, 40, 41, 42, 43, 44, 45];
const SANDAL = [38, 39, 40, 41, 42, 43, 44];
const WOMEN = [36, 37, 38, 39, 40, 41];
const KIDS = [28, 29, 30, 31, 32, 33, 34, 35];

/** "39:2 40:0 41:5" → { 39: 2, 40: 0, 41: 5 } */
const stock = (spec) =>
  Object.fromEntries(
    spec
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(":").map(Number)),
  );

export const PRODUCTS = [
  {
    id: "DEMO-SN-001",
    slug: "studio-low-top",
    name: "Studio Low-Top",
    category: "sneakers",
    price: 12500,
    added: "2026-10-01",
    featured: true,
    style: "sneaker",
    sizes: MEN,
    colors: [
      { id: "beach", name: "Beach Rose", family: "rose", hex: "#c99389", sole: "#ece6dc", images: [], stock: stock("39:3 40:5 41:4 42:2 43:0 44:3 45:1") },
      { id: "midnight", name: "Midnight", family: "navy", hex: "#1d4f78", sole: "#ece6dc", images: [], stock: stock("39:2 40:3 41:0 42:4 43:4 44:2 45:0") },
      { id: "street", name: "Street Black", family: "black", hex: "#1b1a19", sole: "#ece6dc", images: [], stock: stock("39:1 40:2 41:3 42:3 43:2 44:1 45:2") },
    ],
    description:
      "The low-top from our studio campaign: a knit upper on a cushioned white sole, in three finishes. Shown in 3D on the homepage.",
    details: ["Knit upper (demo data)", "Cushioned rubber sole (demo data)", "Lace-up fastening"],
  },
  {
    id: "DEMO-SN-002",
    slug: "court-classic",
    name: "Court Classic",
    category: "sneakers",
    price: 10900,
    added: "2026-08-14",
    featured: false,
    style: "sneaker",
    sizes: MEN,
    colors: [
      { id: "white", name: "Chalk White", family: "white", hex: "#e8e3d9", sole: "#f3efe8", images: [], stock: stock("39:4 40:6 41:6 42:5 43:3 44:2 45:2") },
      { id: "black", name: "Black", family: "black", hex: "#1d1c1b", sole: "#f3efe8", images: [], stock: stock("39:0 40:2 41:3 42:3 43:1 44:0 45:0") },
    ],
    description: "A clean court silhouette in smooth leather with a low, cupped sole.",
    details: ["Leather upper (demo data)", "Cupsole construction (demo data)", "Lace-up fastening"],
  },
  {
    id: "DEMO-SN-003",
    slug: "atelier-runner",
    name: "Atelier Runner",
    category: "sneakers",
    price: 13800,
    added: "2026-09-22",
    featured: true,
    style: "runner",
    sizes: MEN,
    colors: [
      { id: "grey", name: "Stone Grey", family: "grey", hex: "#8a8781", sole: "#e9e4da", images: [], stock: stock("39:2 40:3 41:3 42:2 43:2 44:1 45:1") },
      { id: "navy", name: "Deep Navy", family: "navy", hex: "#232f4b", sole: "#e9e4da", images: [], stock: stock("39:1 40:1 41:2 42:2 43:0 44:0 45:1") },
    ],
    description: "A softly structured runner with a deeper sole, for long days on foot.",
    details: ["Mesh and suede upper (demo data)", "Foam midsole (demo data)", "Lace-up fastening"],
  },
  {
    id: "DEMO-CA-001",
    slug: "weekend-suede-loafer",
    name: "Weekend Suede Loafer",
    category: "casual",
    price: 11900,
    added: "2026-09-05",
    featured: true,
    style: "loafer",
    sizes: MEN,
    colors: [
      { id: "tobacco", name: "Tobacco Suede", family: "brown", hex: "#6b4429", sole: "#2a1d14", images: [], stock: stock("39:2 40:4 41:5 42:4 43:2 44:1 45:0") },
      { id: "sand", name: "Sand Suede", family: "tan", hex: "#b48b62", sole: "#2a1d14", images: [], stock: stock("39:1 40:2 41:2 42:3 43:1 44:1 45:1") },
    ],
    description: "An unlined suede loafer with a hand-sewn-look moc toe and a flexible sole.",
    details: ["Suede upper (demo data)", "Rubber sole (demo data)", "Slip-on"],
  },
  {
    id: "DEMO-CA-002",
    slug: "penny-loafer",
    name: "Penny Loafer",
    category: "casual",
    price: 12900,
    compareAt: 14500, // demo sale
    added: "2026-07-18",
    featured: false,
    style: "loafer",
    sizes: MEN,
    colors: [
      { id: "black", name: "Polished Black", family: "black", hex: "#1c1a19", sole: "#151311", images: [], stock: stock("39:2 40:3 41:3 42:3 43:2 44:2 45:1") },
      { id: "cognac", name: "Cognac", family: "tan", hex: "#8a5230", sole: "#241911", images: [], stock: stock("39:0 40:1 41:2 42:2 43:1 44:0 45:0") },
    ],
    description: "The classic saddle-strap loafer in polished leather on a stacked heel.",
    details: ["Leather upper (demo data)", "Leather sole (demo data)", "Slip-on"],
  },
  {
    id: "DEMO-CA-003",
    slug: "everyday-derby",
    name: "Everyday Derby",
    category: "casual",
    price: 12900,
    added: "2026-10-08",
    featured: false,
    style: "derby",
    sizes: MEN,
    colors: [
      { id: "chestnut", name: "Chestnut", family: "brown", hex: "#5c3620", sole: "#e3d6c2", images: [], stock: stock("39:2 40:3 41:4 42:3 43:3 44:2 45:1") },
      { id: "black", name: "Black", family: "black", hex: "#1c1a19", sole: "#e3d6c2", images: [], stock: stock("39:1 40:2 41:2 42:2 43:1 44:1 45:0") },
    ],
    description: "An open-laced derby on a light crepe-style sole — smart enough, easy enough.",
    details: ["Leather upper (demo data)", "Rubber sole (demo data)", "Lace-up fastening"],
  },
  {
    id: "DEMO-FO-001",
    slug: "cap-toe-oxford",
    name: "Cap-Toe Oxford",
    category: "formal",
    price: 19500,
    added: "2026-09-12",
    featured: true,
    style: "oxford",
    sizes: MEN,
    colors: [
      { id: "black", name: "Black Calf", family: "black", hex: "#1a1918", sole: "#141210", images: [], stock: stock("39:2 40:3 41:4 42:4 43:3 44:2 45:1") },
      { id: "oxblood", name: "Oxblood", family: "brown", hex: "#4a1f1c", sole: "#141210", images: [], stock: stock("39:1 40:1 41:2 42:2 43:1 44:0 45:0") },
    ],
    description: "A closed-laced oxford with a straight toe cap — the formal essential.",
    details: ["Calf leather upper (demo data)", "Leather sole (demo data)", "Closed lacing"],
  },
  {
    id: "DEMO-FO-002",
    slug: "wholecut-oxford",
    name: "Wholecut Oxford",
    category: "formal",
    price: 23500,
    added: "2026-10-12",
    featured: false,
    style: "wholecut",
    sizes: MEN,
    colors: [
      { id: "walnut", name: "Walnut", family: "brown", hex: "#4e2e1c", sole: "#16120f", images: [], stock: stock("39:1 40:2 41:2 42:2 43:1 44:1 45:0") },
      { id: "black", name: "Black", family: "black", hex: "#1a1918", sole: "#16120f", images: [], stock: stock("39:0 40:1 41:2 42:2 43:2 44:1 45:1") },
    ],
    description: "Cut from a single piece of leather for an unbroken, quiet line.",
    details: ["Leather upper (demo data)", "Leather sole (demo data)", "Closed lacing"],
  },
  {
    id: "DEMO-FO-003",
    slug: "plain-toe-derby",
    name: "Plain-Toe Derby",
    category: "formal",
    price: 17900,
    added: "2026-06-30",
    featured: false,
    style: "derby",
    sizes: MEN,
    colors: [
      { id: "black", name: "Black", family: "black", hex: "#1a1918", sole: "#141210", images: [], stock: stock("39:2 40:2 41:3 42:3 43:2 44:2 45:1") },
      { id: "brown", name: "Dark Brown", family: "brown", hex: "#3e2618", sole: "#141210", images: [], stock: stock("39:1 40:2 41:2 42:1 43:1 44:0 45:0") },
    ],
    description: "A plain-toe derby with open lacing — formal, with a little more ease.",
    details: ["Leather upper (demo data)", "Leather sole (demo data)", "Open lacing"],
  },
  {
    id: "DEMO-BO-001",
    slug: "classic-chelsea",
    name: "Classic Chelsea",
    category: "boots",
    price: 21500,
    added: "2026-09-28",
    featured: true,
    style: "chelsea",
    sizes: MEN,
    colors: [
      { id: "black", name: "Black", family: "black", hex: "#1b1a19", sole: "#141210", images: [], stock: stock("39:1 40:3 41:3 42:3 43:2 44:2 45:1") },
      { id: "snuff", name: "Snuff Suede", family: "tan", hex: "#8a6342", sole: "#1a1512", images: [], stock: stock("39:1 40:1 41:2 42:2 43:1 44:1 45:0") },
    ],
    description: "An elastic-sided Chelsea boot with a slim profile and a pull tab at the heel.",
    details: ["Leather or suede upper (demo data)", "Rubber sole (demo data)", "Pull-on"],
  },
  {
    id: "DEMO-BO-002",
    slug: "desert-boot",
    name: "Desert Boot",
    category: "boots",
    price: 16500,
    added: "2026-08-02",
    featured: false,
    style: "desert",
    sizes: MEN,
    colors: [
      { id: "sand", name: "Sand Suede", family: "tan", hex: "#b08a5f", sole: "#d9c29a", images: [], stock: stock("39:2 40:3 41:3 42:3 43:2 44:1 45:1") },
      { id: "brown", name: "Brown Suede", family: "brown", hex: "#5d3e28", sole: "#d9c29a", images: [], stock: stock("39:0 40:0 41:0 42:0 43:0 44:0 45:0") },
    ],
    description: "A two-eyelet ankle boot in soft suede on a light, cushioned sole.",
    details: ["Suede upper (demo data)", "Crepe-style sole (demo data)", "Lace-up fastening"],
  },
  {
    id: "DEMO-SA-001",
    slug: "two-strap-sandal",
    name: "Two-Strap Sandal",
    category: "sandals",
    price: 5900,
    compareAt: 6900, // demo sale
    added: "2026-07-02",
    featured: false,
    style: "sandal",
    sizes: SANDAL,
    colors: [
      { id: "tan", name: "Natural Tan", family: "tan", hex: "#a8764b", sole: "#2a211a", images: [], stock: stock("38:2 39:3 40:4 41:4 42:3 43:2 44:1") },
      { id: "black", name: "Black", family: "black", hex: "#1c1a19", sole: "#2a211a", images: [], stock: stock("38:1 39:2 40:2 41:3 42:2 43:1 44:1") },
    ],
    description: "Two adjustable leather straps on a contoured footbed.",
    details: ["Leather straps (demo data)", "Contoured footbed (demo data)", "Buckle fastening"],
  },
  {
    id: "DEMO-SA-002",
    slug: "leather-slide",
    name: "Leather Slide",
    category: "sandals",
    price: 4900,
    added: "2026-10-15",
    featured: false,
    style: "slide",
    sizes: SANDAL,
    colors: [
      { id: "brown", name: "Brown", family: "brown", hex: "#5a3a26", sole: "#211a15", images: [], stock: stock("38:3 39:3 40:4 41:4 42:3 43:2 44:2") },
      { id: "white", name: "Bone", family: "white", hex: "#e6dfd2", sole: "#2a231d", images: [], stock: stock("38:1 39:2 40:2 41:2 42:1 43:1 44:0") },
    ],
    description: "A single wide leather band on a cushioned footbed. Slip on, slip off.",
    details: ["Leather upper (demo data)", "Cushioned footbed (demo data)", "Slip-on"],
  },
  {
    id: "DEMO-WO-001",
    slug: "block-heel-loafer",
    name: "Block-Heel Loafer",
    category: "women",
    price: 8900,
    added: "2026-10-05",
    featured: true,
    style: "heel",
    sizes: WOMEN,
    colors: [
      { id: "navy", name: "Ink Navy", family: "navy", hex: "#1f2740", sole: "#141210", images: [], stock: stock("36:2 37:3 38:4 39:3 40:2 41:1") },
      { id: "black", name: "Black", family: "black", hex: "#1b1a19", sole: "#141210", images: [], stock: stock("36:1 37:2 38:3 39:3 40:1 41:0") },
    ],
    description: "A polished loafer on a low block heel, finished with a metal buckle.",
    details: ["Synthetic leather upper (demo data)", "Block heel (demo data)", "Slip-on"],
  },
  {
    id: "DEMO-WO-002",
    slug: "everyday-flat-sandal",
    name: "Everyday Flat Sandal",
    category: "women",
    price: 4500,
    added: "2026-09-18",
    featured: false,
    style: "sandal",
    sizes: WOMEN,
    colors: [
      { id: "tan", name: "Tan", family: "tan", hex: "#b07e52", sole: "#2a211a", images: [], stock: stock("36:2 37:3 38:3 39:2 40:2 41:1") },
      { id: "rose", name: "Blush", family: "rose", hex: "#c99389", sole: "#2a211a", images: [], stock: stock("36:1 37:2 38:2 39:1 40:0 41:0") },
    ],
    description: "A light two-strap sandal on a flat, cushioned footbed.",
    details: ["Synthetic straps (demo data)", "Cushioned footbed (demo data)", "Buckle fastening"],
  },
  {
    id: "DEMO-KI-001",
    slug: "school-shoe",
    name: "School Shoe",
    category: "kids",
    price: 3900,
    added: "2026-08-10",
    featured: true,
    style: "school",
    sizes: KIDS,
    colors: [
      { id: "black", name: "Black", family: "black", hex: "#1b1a19", sole: "#141210", images: [], stock: stock("28:4 29:5 30:5 31:6 32:6 33:5 34:4 35:3") },
    ],
    description: "A sturdy black school shoe with an easy touch-fastening strap.",
    details: ["Synthetic leather upper (demo data)", "Hard-wearing rubber sole (demo data)", "Touch-fastening strap"],
  },
  {
    id: "DEMO-KI-002",
    slug: "kids-court-sneaker",
    name: "Kids Court Sneaker",
    category: "kids",
    price: 4900,
    added: "2026-10-10",
    featured: false,
    style: "sneaker",
    sizes: KIDS,
    colors: [
      { id: "white", name: "White / Maroon", family: "white", hex: "#e8e3d9", sole: "#c9a77e", images: [], stock: stock("28:2 29:3 30:3 31:3 32:2 33:2 34:1 35:1") },
      { id: "grey", name: "Grey", family: "grey", hex: "#8a8781", sole: "#e9e4da", images: [], stock: stock("28:1 29:2 30:2 31:2 32:1 33:1 34:0 35:0") },
    ],
    description: "A lace-up court sneaker for the kids collection, on a gum-tone sole.",
    details: ["Synthetic upper (demo data)", "Rubber sole (demo data)", "Lace-up fastening"],
  },
];

/** Async seam: swap this for a fetch() to an API or JSON file without touching the views. */
export async function loadCatalog() {
  return { categories: CATEGORIES, products: PRODUCTS, colorFamilies: COLOR_FAMILIES };
}
