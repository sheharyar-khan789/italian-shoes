/**
 * STORE CONFIGURATION — the one file the shop owner edits.
 *
 * Everything business-specific lives here. Empty strings / null mean "not supplied yet";
 * the site shows a neutral placeholder or a "To be confirmed" state instead of inventing details.
 */

/**
 * WhatsApp number that receives orders.
 *
 * Enter it in international format, DIGITS ONLY — no "+", spaces or dashes.
 *   Pakistani mobile 0300 1234567  →  "923001234567"
 *
 * Either set it here, or (preferred, keeps it out of source control) create a file named
 * `.env.local` in the project root containing:
 *   VITE_WHATSAPP_BUSINESS_NUMBER=92XXXXXXXXXX
 *
 * While this is empty, checkout still works end to end but the WhatsApp button is disabled and
 * the customer sees that ordering is not yet configured — no order can go to a wrong number.
 */
export const WHATSAPP_BUSINESS_NUMBER = (import.meta.env?.VITE_WHATSAPP_BUSINESS_NUMBER ?? "").trim();

export const STORE = {
  /** Brand name shown in the header/footer. Empty → the "BRAND" placeholder wordmark. */
  name: "Italian Shoes",
  /** Urdu name, as written on the store's Instagram profile. */
  nameUrdu: "اٹالین شوز سرائے عالمگیر",
  /** Logo file placed in /public, e.g. "/brand/logo.svg". Empty → placeholder mark. */
  logo: "",

  whatsappNumber: WHATSAPP_BUSINESS_NUMBER,

  /**
   * Delivery charge in PKR. `null` = not confirmed yet: the order shows
   * "To be confirmed" and the total is marked as excluding delivery.
   * Set a number (e.g. 250) only once the owner confirms it. 0 means free delivery.
   */
  deliveryFee: null,

  /** Contact details — leave empty until supplied. Empty fields are hidden or shown as "To be confirmed". */
  // Source: the store's Instagram profile (@italianshoesofficial). Email and hours not supplied yet.
  contact: {
    phone: "0342-7530608",
    email: "",
    address: "Main GT Road, Sarai Alamgir",
    hours: "",
    instagram: "https://www.instagram.com/italianshoesofficial/",
  },

  /**
   * Set to true once the owner has supplied and approved the policy pages
   * (shipping, returns, privacy, terms). While false, those pages carry a visible
   * "placeholder — not yet confirmed by the store" notice.
   */
  policiesConfirmed: false,

  /** Thin bar above the header. Keep it factual — no offers unless the owner confirms them. Empty → hidden. */
  announcement: "Shop online · Visit us on Main GT Road, Sarai Alamgir · 0342-7530608",

  /** True while the catalogue in src/data/catalog.js is sample data. Shows a demo notice. */
  demoCatalog: true,
};

/** Cities offered as suggestions in checkout (customers can still type any city). */
export const CITY_SUGGESTIONS = [
  "Karachi",
  "Lahore",
  "Islamabad",
  "Rawalpindi",
  "Faisalabad",
  "Multan",
  "Peshawar",
  "Quetta",
  "Sialkot",
  "Gujranwala",
  "Hyderabad",
  "Bahawalpur",
  "Sargodha",
  "Abbottabad",
];
