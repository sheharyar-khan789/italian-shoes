/**
 * Per-page search/social tags, set from the page that is showing (title, description, canonical,
 * Open Graph, and Product structured data). Search engines that run JavaScript (Google, Bing) read
 * these; link-preview bots that don't will only see the defaults in index.html.
 */

const set = (selector, create, attr, value) => {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = create();
    document.head.append(el);
  }
  el.setAttribute(attr, value);
};
const meta = (key, value, by = "name") => set(`meta[${by}="${key}"]`, () => Object.assign(document.createElement("meta"), { [by]: key }), "content", value);

/**
 * @param {{ title: string, description?: string, image?: string, path?: string, noindex?: boolean, jsonLd?: object | null }} o
 */
export function setSeo({ title, description = "", image = "", path, noindex = false, jsonLd = null }) {
  document.title = title;
  if (description) {
    meta("description", description);
    meta("og:description", description, "property");
  }
  meta("og:title", title, "property");
  meta("og:type", jsonLd ? "product" : "website", "property");
  if (image) meta("og:image", image, "property");
  meta("robots", noindex ? "noindex" : "index,follow");
  const url = new URL(path ?? location.pathname, location.origin).href;
  set('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" }), "href", url);
  meta("og:url", url, "property");

  document.head.querySelector("script[data-jsonld]")?.remove();
  if (jsonLd) {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.dataset.jsonld = "";
    // JSON.stringify output can't close the tag: "<" is escaped.
    script.textContent = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
    document.head.append(script);
  }
}

/** Plain text of at most n characters, cut at a word. */
export const snippet = (text, n = 160) => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
};
