import { route, startRouter } from "./app/router.js";
import { whenCatalog } from "./app/state.js";
import { applyStoreConfig } from "./ui/layout.js";
import { bindMediaEvents } from "./ui/illustration.js";
import home from "./views/home.js";
import shop from "./views/shop.js";
import product from "./views/product.js";
import cartPage from "./views/cart.js";
import checkout from "./views/checkout.js";
import search from "./views/search.js";
import infoPage, { notFound } from "./views/pages.js";
import { loginView, registerView, forgotView, accountView, addressesView, passwordView } from "./views/account.js";
import { ordersView, orderView, orderPlacedView } from "./views/accountOrders.js";
import { wishlistView } from "./views/wishlist.js";
import { startSession } from "./app/session.js";
import { bindAccountLink } from "./ui/layout.js";

route(/^\/$/, home, "home");
route(/^\/shop(?:\/([\w-]+))?$/, shop, "shop");
route(/^\/product\/([\w-]+)$/, product, "product");
route(/^\/cart$/, cartPage, "cart");
route(/^\/checkout$/, checkout, "checkout");
route(/^\/search$/, search, "search");
route(/^\/account$/, accountView, "account");
route(/^\/account\/login$/, loginView, "account");
route(/^\/account\/register$/, registerView, "account");
route(/^\/account\/forgot-password$/, forgotView, "account");
route(/^\/account\/addresses$/, addressesView, "account");
route(/^\/account\/password$/, passwordView, "account");
route(/^\/account\/orders$/, ordersView, "account");
route(/^\/account\/wishlist$/, wishlistView, "account");
route(/^\/order\/([\w-]+)$/, orderPlacedView, "account");
route(/^\/p\/([\w-]+)$/, infoPage, "info");
route(/^\/account\/orders\/([\w-]+)$/, orderView, "account");
route(/^\/(about|contact|faq|size-guide|shipping|returns|privacy|terms)$/, infoPage, "info");
route(/^$/, notFound, "notfound"); // fallback (never matches a real path)

// Entrance choreography for the header + hero copy.
const reveal = () => document.body.classList.add("is-revealed");
requestAnimationFrame(reveal);
setTimeout(reveal, 250); // rAF can be throttled in background tabs

bindMediaEvents();
whenCatalog().then(applyStoreConfig);

// Load the sign-in state after first paint, so the Firebase SDK never delays the page.
const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1200));
idle(() => startSession().then(bindAccountLink));
startRouter();
