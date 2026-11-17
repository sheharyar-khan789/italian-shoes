/**
 * Writes dist/sw.js from scripts/sw.template.js: the list of files to keep for offline use and a version that changes
 * whenever any of them changes. Runs after `vite build` (see package.json "build").
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, process.argv[2] ?? "dist");
if (!fs.existsSync(path.join(dist, "admin.html"))) throw new Error("dist/admin.html is missing: run `vite build` first.");

const assets = fs.readdirSync(path.join(dist, "assets")).filter((f) => /\.(js|css|woff2?|svg|png|webp)$/.test(f)).sort();
const list = ["/admin.html", "/js-flag.js", ...assets.map((f) => `/assets/${f}`)];
const hash = crypto.createHash("sha256");
for (const rel of list) hash.update(rel).update(fs.readFileSync(path.join(dist, rel)));
const version = hash.digest("hex").slice(0, 16);

const template = fs.readFileSync(path.join(root, "scripts", "sw.template.js"), "utf8");
const out = template.replace('const VERSION = "__VERSION__";', `const VERSION = "${version}";`).replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(list)};`);
if (out.includes("__PRECACHE__;") || out.includes("__VERSION__\"")) throw new Error("sw.js was not filled in");
new Function(out); // a syntax check only: nothing runs
fs.writeFileSync(path.join(dist, "sw.js"), out);
console.log(`sw.js written: ${list.length} files, version ${version}`);
