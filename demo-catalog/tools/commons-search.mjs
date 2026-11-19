import { launch } from "../../tests/e2e/helpers.js";
const browser = await launch();
const page = await browser.newPage();
for (const q of process.argv.slice(2)) {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({ action: "query", format: "json", generator: "search", gsrsearch: q + " filetype:bitmap", gsrnamespace: 6, gsrlimit: 12, prop: "imageinfo", iiprop: "url|size|extmetadata", iiextmetadatafilter: "LicenseShortName|Artist|ImageDescription", iiurlwidth: 1000 }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await page.goto(u.toString());
  const j = JSON.parse(await r.text());
  console.log("## " + q);
  for (const p of Object.values(j.query?.pages ?? {})) {
    const i = p.imageinfo?.[0]; if (!i) continue;
    console.log(`${i.width}x${i.height} ${i.extmetadata?.LicenseShortName?.value ?? "?"} | ${p.title} | ${(i.extmetadata?.ImageDescription?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 60)}`);
  }
}
await browser.close();
