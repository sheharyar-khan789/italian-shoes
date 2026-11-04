import { route, startRouter } from "./app/router.js";
import { catalogReady } from "./app/state.js";
import { applyStoreConfig } from "./ui/layout.js";
import { bindMediaEvents } from "./ui/illustration.js";
import home from "./views/home.js";
import shop from "./views/shop.js";
import product from "./views/product.js";
import cartPage from "./views/cart.js";
import checkout from "./views/checkout.js";
import search from "./views/search.js";
import infoPage, { notFound } from "./views/pages.js";

route(/^\/$/, home, "home");
route(/^\/shop(?:\/([\w-]+))?$/, shop, "shop");
route(/^\/product\/([\w-]+)$/, product, "product");
route(/^\/cart$/, cartPage, "cart");
route(/^\/checkout$/, checkout, "checkout");
route(/^\/search$/, search, "search");
route(/^\/(about|contact|faq|size-guide|shipping|returns|privacy|terms)$/, infoPage, "info");
route(/^$/, notFound, "notfound"); // fallback (never matches a real path)

// Entrance choreography for the header + hero copy.
const reveal = () => document.body.classList.add("is-revealed");
requestAnimationFrame(reveal);
setTimeout(reveal, 250); // rAF can be throttled in background tabs

bindMediaEvents();
catalogReady.then(applyStoreConfig);
startRouter();
