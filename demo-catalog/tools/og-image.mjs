// Reads the main product image address (og:image) from product pages: node og-image.mjs <url> ...
import fs from "node:fs";
import { launch } from "../../tests/e2e/helpers.js";
const b = await launch();
const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
for (const u of process.argv.slice(2)) {
  const p = await ctx.newPage();
  try {
    await p.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
    await p.waitForTimeout(1500);
    const og = await p.evaluate(() => document.querySelector('meta[property="og:image"]')?.content ?? null);
    const line = `${u} => ${og}`; console.log(line); if (process.env.OG_OUT) fs.appendFileSync(process.env.OG_OUT, line + String.fromCharCode(10));
  } catch (e) { console.log(u.slice(0, 70), "ERR", String(e.message).split("\n")[0]); }
  await p.close();
}
await b.close();
