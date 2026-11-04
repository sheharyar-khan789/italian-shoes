import { catalogReady, cart } from "../app/state.js";
import { bagContents, bindBagControls, restoreFocus } from "../ui/cartView.js";

export default async function cartPage({ outlet }) {
  document.title = "Your Bag";
  await catalogReady;
  outlet.innerHTML = `
  <div class="page page--narrow bag-page">
    <header class="page-head">
      <p class="kicker"><span class="kicker__line"></span>Step 1 of 3</p>
      <h1 class="page-title">Your <em>bag</em></h1>
    </header>
    <div class="bag" data-bag></div>
  </div>`;
  const root = outlet.querySelector("[data-bag]");
  const render = () => {
    root.innerHTML = bagContents({ variant: "page" });
    restoreFocus(root);
  };
  bindBagControls(root);
  render();
  return cart.subscribe(render);
}
