/**
 * Small fixed settings for the browser code.
 *
 * Store details (name, phone, address, hours, announcement …) are NOT here: the owner saves them in
 * the admin (Store settings) and the website reads them from the database.
 */

/**
 * Details the owner has already confirmed (from the store's Instagram profile), offered in the admin
 * settings form only while nothing has been saved yet. Never shown to customers directly.
 */
export const STORE_DEFAULTS = {
  name: "Italian Shoes",
  nameUrdu: "اٹالین شوز سرائے عالمگیر",
  phone: "0342-7530608",
  address: "Main GT Road, Sarai Alamgir",
  instagram: "https://www.instagram.com/italianshoesofficial/",
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
