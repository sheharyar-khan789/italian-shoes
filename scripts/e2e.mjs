/**
 * Browser end-to-end tests. Run with `npm run e2e` (starts the Firebase emulators, then this).
 *
 *   1. builds the app in the "e2e" mode (talks to the local emulators; the live site is never built this way) unless dist-e2e exists
 *   2. seeds people and a tiny catalogue into the emulators
 *   3. serves the built app (with its /api) on http://localhost:5183 and runs tests/e2e/*.e2e.js in real Chrome
 * Flags: --load (run scripts/loadtest.mjs instead of the browser tests), --rebuild (force a new build), --grep <text> (only matching test files, e.g. --grep offline)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PORT = 5183;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const grep = args.includes("--grep") ? args[args.indexOf("--grep") + 1] : "";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("Run with `npm run e2e` so the emulators are started first.");
  process.exit(1);
}
if (args.includes("--rebuild") || !fs.existsSync(path.join(root, "dist-e2e", "sw.js"))) {
  console.log("Building the e2e bundle …");
  const b = spawnSync(npm, ["run", "build:e2e"], { cwd: root, stdio: "inherit", shell: true });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

// A local stand-in for Cloudinary (tests/e2e/cloudinaryStandIn.mjs) so product-photo uploads can be tested in a real browser
// without a real account. The app's server is pointed at it with the same variables a real account would use.
const CDN_PORT = 5184;
const cdnConfig = { cloudName: "e2e-cloud", apiKey: "100200300", apiSecret: "e2e-secret-" + Math.random().toString(36).slice(2), port: CDN_PORT };
Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: cdnConfig.cloudName, CLOUDINARY_API_KEY: cdnConfig.apiKey, CLOUDINARY_API_SECRET: cdnConfig.apiSecret, CLOUDINARY_API_BASE: `http://localhost:${CDN_PORT}`, CLOUDINARY_DELIVERY_BASE: `http://localhost:${CDN_PORT}` });
const { startCloudinaryStandIn } = await import("../tests/e2e/cloudinaryStandIn.mjs");
const cdn = await startCloudinaryStandIn(cdnConfig);
process.on("exit", () => cdn.stop());

const { seed } = await import("../tests/e2e/seed.mjs");
const fx = await seed();
console.log("Seeded: 3 people, 2 products, 1 shop warehouse (emulators only).");

const server = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "preview", "--mode", "e2e", "--outDir", "dist-e2e", "--port", String(PORT), "--strictPort"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stop = () => {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/api/healthCheck`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error("The test server did not start:\n" + serverLog);
  stop();
  process.exit(1);
}

const files = fs.readdirSync(path.join(root, "tests", "e2e")).filter((f) => f.endsWith(".e2e.js") && f.includes(grep)).map((f) => path.join("tests", "e2e", f));
fs.mkdirSync(path.join(root, "e2e-output"), { recursive: true });
const env = { ...process.env, E2E_BASE: BASE, E2E_FIXTURES: JSON.stringify(fx), E2E_OUT: path.join(root, "e2e-output"), E2E_CLOUDINARY: cdn.base };
const load = args.includes("--load");
// Asynchronous on purpose: the Cloudinary stand-in lives in THIS process and must keep answering while the tests run.
const child = load
  ? spawn(process.execPath, [path.join(root, "scripts", "loadtest.mjs")], { cwd: root, env, stdio: "inherit" })
  : spawn(process.execPath, ["--test", "--test-concurrency=1", `--test-timeout=${process.env.E2E_TIMEOUT ?? 180000}`, ...files], { cwd: root, env, stdio: "inherit" });
const t = { status: await new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
if (t.status !== 0 && serverLog.trim()) console.error(["", "--- test server output (last 3000 characters) ---", serverLog.slice(-3000)].join(String.fromCharCode(10)));
stop();
cdn.stop();
process.exit(t.status ?? 1);
