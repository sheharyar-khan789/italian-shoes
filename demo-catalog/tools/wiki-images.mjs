// Lists the images used on Wikipedia articles, with licence + author (Commons files are included). Usage: node wiki-images.mjs "Article title" ...
const H = { "User-Agent": "demo-catalog-research/1.0 (local research script)" };
const api = async (params) => { const u = new URL("https://en.wikipedia.org/w/api.php"); for (const [k, v] of Object.entries({ format: "json", ...params })) u.searchParams.set(k, v); for (let n = 0; n < 6; n++) { const t = await (await fetch(u, { headers: H })).text(); try { return JSON.parse(t); } catch { await new Promise((r) => setTimeout(r, 15000 * (n + 1))); } } throw new Error("rate limited"); };
for (const title of process.argv.slice(2)) {
  await new Promise((r) => setTimeout(r, 2500));
  const j = await api({ action: "query", generator: "images", titles: title, gimlimit: 40, prop: "imageinfo", iiprop: "url|size|extmetadata", iiextmetadatafilter: "LicenseShortName|Artist|ImageDescription", redirects: 1 });
  console.log("## " + title);
  for (const p of Object.values(j.query?.pages ?? {})) {
    const i = p.imageinfo?.[0]; if (!i || !/\.(jpe?g|png|webp)$/i.test(p.title)) continue;
    if (i.width < 700) continue;
    console.log(`${i.width}x${i.height} ${i.extmetadata?.LicenseShortName?.value ?? "?"} | ${p.title} | ${(i.extmetadata?.ImageDescription?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 70)}`);
  }
}
