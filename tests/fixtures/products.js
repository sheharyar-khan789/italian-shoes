/**
 * TEST FIXTURES ONLY. Synthetic products in the storefront model, used by unit tests of the cart and
 * shop logic. They are never imported by the website. Prices are rupees; sizes are { id, label }.
 */
const size = (id, label) => ({ id, label });
export const SIZES = [size("s40", "40"), size("s41", "41"), size("s42", "42"), size("s43", "43")];

export const CATEGORIES = [
  { id: "cat-formal", slug: "formal", name: "Formal" },
  { id: "cat-casual", slug: "casual", name: "Casual" },
];

export const PRODUCTS = [
  {
    id: "p-low",
    slug: "test-low-top",
    name: "Test Low-Top",
    category: "cat-casual",
    price: 12500,
    priceMax: 12500,
    compareAt: null,
    added: "2026-10-01T00:00:00.000Z",
    featured: true,
    isNewArrival: false,
    description: "A synthetic product for tests.",
    keywords: ["test", "low", "top"],
    sizes: SIZES,
    colors: [
      { id: "beach", name: "Beach Rose", family: "beach", hex: "#c99389", images: [], stock: { s40: 3, s41: 4, s42: 0, s43: 1 }, prices: { s40: 12500, s41: 12500, s42: 12500, s43: 12500 }, regularPrices: {} },
      { id: "night", name: "Midnight", family: "night", hex: "#1d4f78", images: [], stock: { s40: 0, s41: 0, s42: 0, s43: 0 }, prices: {}, regularPrices: {} },
    ],
  },
  {
    id: "p-formal",
    slug: "test-oxford",
    name: "Test Oxford",
    category: "cat-formal",
    price: 9000,
    priceMax: 11000,
    compareAt: 9900,
    added: "2026-09-01T00:00:00.000Z",
    featured: false,
    isNewArrival: false,
    description: "Another synthetic product.",
    keywords: ["oxford", "leather"],
    sizes: SIZES.slice(0, 3),
    colors: [{ id: "black", name: "Black", family: "black", hex: "#111111", images: [], stock: { s40: 2, s41: 2, s42: 5 }, prices: { s40: 9000, s41: 9000, s42: 11000 }, regularPrices: { s40: 9900, s41: 9900, s42: 11000 } }],
  },
];
