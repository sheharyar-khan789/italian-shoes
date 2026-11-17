/**
 * The public shop data in one response: settings, categories, colours, sizes, PUBLISHED products and the
 * home-page layout. Same data the Firestore rules already make public; read with the Admin SDK and cached
 * at Vercel's edge (see handler.js), so visitors don't each cost database reads and the shop opens fast
 * even where a direct connection to Google is slow.
 *
 * The data itself comes from the pre-built snapshot (services/catalogSnapshot.js), so a refresh of the edge
 * cache costs a handful of reads instead of re-reading every product.
 */
import { isDeliveryReady } from "./shipping.js";
import { loadSnapshot } from "./catalogSnapshot.js";

export { plain } from "./catalogSnapshot.js";

export async function loadPublicCatalog() {
  const [catalog, deliveryReady] = await Promise.all([loadSnapshot(), isDeliveryReady()]);
  return {
    // Only a yes/no: lets checkout say plainly that delivery isn't set up, without exposing any shipping data.
    deliveryReady,
    settings: catalog.settings,
    home: catalog.home,
    categories: catalog.categories,
    colors: catalog.colors,
    sizes: catalog.sizes,
    products: catalog.products,
  };
}
