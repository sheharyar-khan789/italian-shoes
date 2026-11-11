/**
 * After a new version of the site goes live, a page that was opened earlier may ask for script files that no
 * longer exist ("Failed to fetch dynamically imported module"). Reload once to pick up the new version.
 */
export function reloadWhenUpdated() {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    try {
      if (sessionStorage.getItem("updated-reload")) return; // never loop
      sessionStorage.setItem("updated-reload", "1");
      setTimeout(() => sessionStorage.removeItem("updated-reload"), 30000);
    } catch {
      /* storage blocked: reload anyway once per page load */
    }
    location.reload();
  });
}
