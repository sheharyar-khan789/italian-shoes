import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * Security headers come from ONE place: firebase.json (what Firebase Hosting sends in production).
 * `npm run preview` serves the production build with exactly those headers, so the Content
 * Security Policy can be tested locally before deploying. The dev server (`npm run dev`) does not
 * apply them, because Vite's hot-reload needs things the policy rightly forbids.
 */
const firebase = JSON.parse(readFileSync(new URL("./firebase.json", import.meta.url), "utf8"));
const securityHeaders = Object.fromEntries(
  firebase.hosting.headers.find((h) => h.source === "**").headers.map(({ key, value }) => [key, value]),
);
// Local preview runs on plain http://localhost — don't ask the browser to upgrade it to https.
securityHeaders["Content-Security-Policy"] = securityHeaders["Content-Security-Policy"].replace("; upgrade-insecure-requests", "");
delete securityHeaders["Strict-Transport-Security"];

/** /admin and /admin/* serve admin.html (same as the Firebase Hosting rewrite). */
const adminRoute = {
  name: "admin-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/admin(\/|\?|$)/.test(req.url)) req.url = "/admin.html";
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/admin(\/|\?|$)/.test(req.url)) req.url = "/admin.html";
      next();
    });
  },
};

export default defineConfig({
  plugins: [adminRoute],
  preview: { port: 5182, strictPort: true, headers: securityHeaders },
  build: {
    // No source maps in production: they would publish readable source for the whole app.
    sourcemap: false,
    rollupOptions: {
      input: { main: "index.html", admin: "admin.html" },
    },
  },
});
