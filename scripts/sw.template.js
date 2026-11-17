/* global self, caches, fetch, URL, Response, __PRECACHE__ */
/*
 * Offline shell for the admin app (generated into dist/sw.js by scripts/make-sw.mjs after every build).
 * Purpose: the till can be reloaded or reopened while the internet is down, so the offline point of sale can start.
 * What it does: keeps a copy of the admin page and of the app's own scripts/styles; opening /admin or /admin/... uses
 * the network when it is there and the saved copy when it is not.
 * What it never does: touch /api, Firebase, Vercel Blob or any other site; cache anything with a sign-in; cache data.
 */
const VERSION = "__VERSION__";
const CACHE = `admin-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("admin-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Opening the admin: the network first (so updates arrive at once), the saved page when offline.
  if (req.mode === "navigate" && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match("/admin.html", { cacheName: CACHE, ignoreVary: true })) ?? Response.error()),
    );
    return;
  }

  // The app's own built files never change under the same name: saved copy first.
  if (url.pathname.startsWith("/assets/") || url.pathname === "/js-flag.js") {
    event.respondWith(
      caches.match(req, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit ?? fetch(req)),
    );
  }
});
