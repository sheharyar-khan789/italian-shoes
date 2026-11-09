/** Wishlist: products a signed-in customer saved. Private to the account (see firestore.rules). */
import { esc } from "../lib/format.js";
import { grid, bindCardSwatches, catalogGate, arrow } from "../ui/components.js";
import { getCatalog } from "../app/state.js";
import { shell, accountNav, bindSignOut, requireUser } from "./account.js";
import { loadWishlist } from "../data/store.js";

export async function wishlistView(ctx) {
  const { outlet } = ctx;
  document.title = "Your wishlist";
  const user = await requireUser();
  if (!user) return;
  if (!(await catalogGate(outlet, () => wishlistView(ctx)))) return;
  outlet.innerHTML = shell("Account", "Your <em>wishlist</em>", `${accountNav("wishlist")}<div data-slot><p class="muted">Loading…</p></div>`);
  bindSignOut(outlet);
  const slot = outlet.querySelector("[data-slot]");
  let ids;
  try {
    ids = await loadWishlist(user.uid);
  } catch {
    slot.innerHTML = `<p class="form-alert" role="alert">Your wishlist couldn't be loaded. Check your connection and reload the page.</p>`;
    return;
  }
  const { products } = getCatalog();
  const saved = ids.map((id) => products.find((p) => p.id === id)).filter(Boolean);
  slot.innerHTML = saved.length
    ? grid(saved)
    : `<div class="empty"><p class="empty__title">${esc("Nothing saved yet")}</p><p class="empty__text">Tap the heart on a product to keep it here.</p><a class="btn btn--primary" href="/shop"><span>Browse the collection</span>${arrow}</a></div>`;
  bindCardSwatches(slot, products);
}
