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

/**
 * Local /api for `npm run dev`: runs the same handler Vercel runs (api/[fn].js), against the Firebase
 * EMULATORS (never the live project) unless real credentials are present in the environment.
 */
const apiDev = {
  name: "api-dev",
  configureServer(server) {
    if (!process.env.FIREBASE_PRIVATE_KEY) {
      process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
      process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
      process.env.GCLOUD_PROJECT ??= "demo-italianshoes";
    }
    server.middlewares.use("/api", async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        body = undefined;
      }
      const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]);
      if (name === "blobUpload") {
        // Photo-upload tokens: the same function Vercel runs, with a small adapter for Vite's response object.
        const { default: blobUpload } = await server.ssrLoadModule("/api/blobUpload.js");
        /** @type {any} */
        const shim = res;
        shim.status = (code) => ((res.statusCode = code), shim);
        shim.json = (obj) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(obj)));
        /** @type {any} */ (req).body = body;
        return blobUpload(req, shim);
      }
      const { handleApi } = await server.ssrLoadModule("/functions/handler.js");
      const out = await handleApi({ method: req.method ?? "GET", name, headers: req.headers, body });
      res.statusCode = out.status;
      res.setHeader("Content-Type", "application/json");
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(out.body));
    });
  },
};

export default defineConfig({
  plugins: [adminRoute, apiDev],
  preview: { port: 5182, strictPort: true, headers: securityHeaders },
  build: {
    // No source maps in production: they would publish readable source for the whole app.
    sourcemap: false,
    rollupOptions: {
      input: { main: "index.html", admin: "admin.html" },
    },
  },
});
