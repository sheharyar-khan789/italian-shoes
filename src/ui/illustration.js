/**
 * Studio illustrations — stand-ins until the owner's product photographs are supplied.
 * Side profiles, toe left, drawn on a 240×130 canvas with the ground at y≈106.
 * They are deliberately stylised so nobody mistakes them for product photos.
 */
import { esc } from "../lib/format.js";

const HEEL = "M176 100 L176 112 L204 112 L206 100 Z"; // stacked heel block for dress shoes
const DRESS_SOLE = "M10 100 C9 104 13 106 22 106 L150 106 C158 106 164 104 172 103 L176 103 L176 100 Z";

const SHAPES = {
  sneaker: {
    upper:
      "M22 98 C18 90 20 80 32 76 C46 72 62 70 78 66 C96 61 110 54 124 50 C134 47 144 47 152 52 C158 56 164 58 172 54 C180 48 188 46 194 50 C202 56 204 76 204 98 Z",
    sole: "M16 98 L208 98 C211 98 212 101 212 104 C212 109 207 112 200 112 L28 112 C20 112 14 108 14 103 C14 100 15 98 16 98 Z",
    lines: [
      "M32 76 C29 86 31 94 38 98",
      "M90 66 C104 62 124 54 150 52",
      "M172 54 C176 70 181 86 184 98",
      "M70 98 C92 90 120 80 150 74 C164 71 176 72 186 76",
    ],
    laces: [
      [96, 61, 106, 66],
      [106, 57, 116, 62],
      [116, 53, 126, 58],
      [126, 50, 136, 55],
      [96, 66, 106, 61],
      [106, 62, 116, 57],
      [116, 58, 126, 53],
    ],
    dots: [
      [96, 63.5],
      [106, 59.5],
      [116, 55.5],
      [126, 52],
      [136, 50],
    ],
    dashed: ["M20 101.5 L206 101.5"],
  },
  runner: {
    upper:
      "M24 94 C20 86 22 77 34 73 C48 69 64 67 80 63 C98 58 112 50 126 46 C136 43 146 43 154 48 C160 52 166 54 174 50 C182 43 190 41 196 46 C204 52 206 72 206 94 Z",
    sole: "M16 94 L208 94 C212 94 213 98 213 102 C213 110 207 114 198 114 L30 114 C20 114 14 110 14 103 C14 98 15 94 16 94 Z",
    lines: [
      "M34 73 C31 82 33 90 40 94",
      "M92 62 C108 57 126 50 152 48",
      "M174 50 C178 66 183 82 186 94",
      "M56 94 C96 88 134 72 172 62",
      "M66 94 C104 90 138 78 176 70",
    ],
    laces: [
      [98, 57, 108, 62],
      [108, 53, 118, 58],
      [118, 49, 128, 54],
      [98, 62, 108, 57],
      [108, 58, 118, 53],
      [118, 54, 128, 49],
    ],
    dashed: ["M18 104 C70 100 140 100 210 104"],
  },
  loafer: {
    upper:
      "M12 100 C10 92 16 86 30 84 C56 79 76 74 96 70 C120 66 150 66 176 66 C188 64 196 62 202 64 C206 72 206 88 206 100 Z",
    sole: DRESS_SOLE,
    heel: HEEL,
    lines: ["M36 84 C52 74 80 70 100 71", "M106 69 L138 72 L138 82 L106 79 Z", "M176 66 C180 78 184 90 184 100"],
    dashed: ["M40 87 C56 78 80 74 98 75"],
  },
  oxford: {
    upper:
      "M12 100 C10 92 16 86 30 84 C50 80 66 74 84 66 C96 60 108 56 120 55 L150 53 C160 53 168 55 176 57 C184 50 191 46 198 48 C204 52 206 66 206 100 Z",
    sole: DRESS_SOLE,
    heel: HEEL,
    lines: ["M48 81 C53 88 55 95 53 100", "M108 57 L148 56", "M104 60 C112 72 140 78 168 70 C175 66 178 61 176 57"],
    dots: [
      [114, 58],
      [124, 57.4],
      [134, 56.8],
      [144, 56.2],
    ],
  },
  wholecut: {
    upper:
      "M10 100 C8 92 14 86 28 84 C48 80 66 74 84 66 C96 60 108 56 120 55 L150 53 C160 53 168 55 176 57 C184 50 191 46 198 48 C204 52 206 66 206 100 Z",
    sole: DRESS_SOLE,
    heel: HEEL,
    lines: ["M110 57 L148 55", "M176 57 C182 70 186 86 186 100"],
    dots: [
      [116, 56.6],
      [126, 56],
      [136, 55.4],
    ],
  },
  derby: {
    upper:
      "M12 100 C10 92 16 86 30 84 C50 80 66 74 84 66 C96 60 108 55 120 53 L150 51 C160 51 168 53 176 56 C184 50 191 46 198 48 C204 52 206 66 206 100 Z",
    sole: "M10 100 C9 105 13 108 22 108 L196 108 C204 108 208 105 208 100 Z",
    lines: ["M100 62 C104 54 118 50 126 52 L150 66 C156 70 166 72 176 70", "M104 60 C110 52 124 50 134 54", "M176 56 C182 70 186 86 186 100"],
    dots: [
      [112, 56],
      [122, 54],
      [132, 54],
    ],
  },
  chelsea: {
    upper:
      "M12 100 C10 92 16 86 32 84 C58 80 80 72 96 62 C104 56 110 40 112 14 L180 12 C184 40 190 60 200 74 C206 84 206 92 206 100 Z",
    sole: DRESS_SOLE,
    heel: HEEL,
    gusset: "M136 15 C138 40 142 56 150 66 C158 56 160 40 162 14 Z",
    lines: ["M176 12 C176 4 186 3 188 12", "M112 22 L180 20"],
  },
  desert: {
    upper:
      "M18 98 C14 90 20 84 34 82 C60 78 82 72 98 62 C106 56 112 46 114 34 L178 32 C182 52 190 68 200 78 C204 86 204 92 204 98 Z",
    sole: "M12 98 L210 98 L210 112 L18 112 C12 112 10 108 10 104 C10 100 11 98 12 98 Z",
    lines: ["M100 60 C112 52 130 52 150 58 C164 62 176 66 190 72", "M114 36 C116 46 118 54 118 58"],
    dots: [
      [126, 44],
      [128, 54],
    ],
  },
  heel: {
    upper:
      "M16 98 C12 90 18 84 32 82 C52 78 74 72 92 64 C104 58 116 56 126 58 L150 60 C160 56 168 50 176 44 C184 40 194 42 196 50 L196 72 C172 74 148 86 122 96 C100 100 60 100 16 98 Z",
    sole: "M12 98 C11 103 15 105 26 105 L96 105 C122 104 148 92 172 78 L198 74 L196 70 C172 74 148 88 122 98 C100 101 60 101 12 98 Z",
    heel: "M176 76 L198 73 L194 106 L180 106 Z",
    lines: ["M126 58 C128 66 132 72 140 74", "M176 44 C180 56 184 66 186 72"],
    buckle: [112, 60],
  },
  school: {
    upper:
      "M14 98 C12 90 18 84 32 82 C52 78 68 72 86 64 C98 58 110 53 122 51 L150 50 C160 50 168 52 176 55 C184 49 191 45 198 47 C204 51 206 66 206 98 Z",
    sole: "M10 98 L210 98 L210 110 C210 112 208 113 204 113 L18 113 C12 113 9 110 9 105 C9 101 9 98 10 98 Z",
    overlay: "M98 66 L156 56 L160 70 L104 81 Z",
    lines: ["M44 82 C49 88 51 94 49 98", "M176 55 C182 70 186 86 186 98", "M100 72 L158 62"],
    dashed: ["M12 104 L208 104"],
  },
  sandal: {
    sole: "M14 96 C12 102 18 108 30 108 L196 108 C206 108 210 104 208 96 Z",
    footbed: "M16 96 C14 92 20 90 32 90 L194 90 C204 90 210 92 208 96 Z",
    straps: ["M44 92 C52 62 92 58 104 92 L94 92 C86 70 60 70 54 92 Z", "M120 92 C128 64 168 62 178 92 L168 92 C160 72 136 72 130 92 Z"],
    lines: [],
    buckle: [148, 67],
  },
  slide: {
    sole: "M14 96 C12 102 18 108 30 108 L196 108 C206 108 210 104 208 96 Z",
    footbed: "M16 96 C14 92 20 90 32 90 L194 90 C204 90 210 92 208 96 Z",
    straps: ["M40 92 C48 54 128 50 140 92 Z"],
    lines: ["M60 66 C80 58 110 58 126 70"],
  },
};

const luminance = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

let uid = 0;

/**
 * @param {string} style  key of SHAPES
 * @param {{hex: string, sole: string}} color
 * @param {{label?: string, flip?: boolean, className?: string}} opts
 */
export function illustration(style, color, { label = "", flip = false, className = "" } = {}) {
  const s = SHAPES[style] ?? SHAPES.sneaker;
  const id = `il${++uid}`;
  const light = luminance(color.hex) > 0.45;
  const detail = light ? "rgba(20,16,12,.42)" : "rgba(255,248,236,.34)";
  const edge = light ? "rgba(20,16,12,.35)" : "rgba(255,248,236,.14)";
  const soleEdge = luminance(color.sole) > 0.45 ? "rgba(20,16,12,.25)" : "rgba(255,248,236,.12)";
  const t = flip ? ' transform="translate(240 0) scale(-1 1)"' : "";

  const paths = [];
  if (s.footbed) paths.push(`<path d="${s.sole}" fill="${color.sole}" stroke="${soleEdge}" stroke-width=".8"/>`);
  if (s.footbed) paths.push(`<path d="${s.footbed}" fill="${color.hex}" opacity=".85"/>`);
  if (s.straps) s.straps.forEach((d) => paths.push(`<path d="${d}" fill="${color.hex}" stroke="${edge}" stroke-width=".8"/><path d="${d}" fill="url(#${id}s)"/>`));
  if (s.buckle && !s.upper) paths.push(`<rect x="${s.buckle[0]}" y="${s.buckle[1]}" width="9" height="7" rx="1" fill="none" stroke="#c9b08c" stroke-width="1.4"/>`);
  if (s.upper) {
    if (s.heel) paths.push(`<path d="${s.heel}" fill="${color.sole}" stroke="${soleEdge}" stroke-width=".8"/>`);
    paths.push(`<path d="${s.upper}" fill="${color.hex}" stroke="${edge}" stroke-width=".8"/>`);
    if (s.gusset) paths.push(`<path d="${s.gusset}" fill="#000" opacity=".28"/>`);
    if (s.overlay) paths.push(`<path d="${s.overlay}" fill="#000" opacity=".32" stroke="${edge}" stroke-width=".8"/>`);
    paths.push(`<path d="${s.upper}" fill="url(#${id}s)"/>`);
    paths.push(`<path d="${s.sole}" fill="${color.sole}" stroke="${soleEdge}" stroke-width=".8"/>`);
  }
  if (s.buckle && s.upper) paths.push(`<rect x="${s.buckle[0]}" y="${s.buckle[1]}" width="12" height="6" rx="1" fill="none" stroke="#c9b08c" stroke-width="1.4"/>`);
  s.lines.forEach((d) => paths.push(`<path d="${d}" fill="none" stroke="${detail}" stroke-width="1.3" stroke-linecap="round"/>`));
  (s.laces ?? []).forEach(([x1, y1, x2, y2]) => paths.push(`<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${light ? "#2a2420" : "#ece5d8"}" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round"/>`));
  (s.dashed ?? []).forEach((d) => paths.push(`<path d="${d}" fill="none" stroke="${soleEdge}" stroke-width=".9" stroke-dasharray="2 3"/>`));
  (s.dots ?? []).forEach(([x, y]) => paths.push(`<circle cx="${x}" cy="${y}" r="1.4" fill="${detail}"/>`));

  return `<svg class="shoe-art ${className}" viewBox="0 0 240 130" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">
  <defs>
    <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".28"/>
    </linearGradient>
    <radialGradient id="${id}g" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#000" stop-opacity=".6"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="112" cy="114" rx="104" ry="7" fill="url(#${id}g)"/>
  <g${t}>${paths.join("")}</g>
</svg>`;
}

/**
 * Product media: real photo when supplied (lazy, with a graceful fallback to the illustration
 * if the file fails to load), otherwise the illustration.
 * No inline event handlers (they would be blocked by the Content Security Policy);
 * load/error are handled once, page-wide, by bindMediaEvents().
 */
/**
 * @param {any} product
 * @param {any} color
 * @param {{ index?: number, eager?: boolean, label?: string }} [opts]
 */
export function productMedia(product, color, { index = 0, eager = false, label } = {}) {
  const alt = label ?? `${product.name} in ${color.name}`;
  const src = color.images?.[index];
  const art = illustration(product.style, color, { label: alt, flip: index % 2 === 1 });
  if (!src) return `<div class="media media--art">${art}</div>`;
  return `<div class="media media--photo is-loading">
    <img src="${esc(src)}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" data-media>
    <template data-media-fallback>${art}</template>
  </div>`;
}

/**
 * One capturing listener for every product photo on the page (load/error don't bubble, so
 * capture is required). On failure the photo is swapped for its illustration.
 */
export function bindMediaEvents(root = document) {
  root.addEventListener(
    "load",
    (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.hasAttribute("data-media")) img.parentElement?.classList.remove("is-loading");
    },
    true,
  );
  root.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.hasAttribute("data-media")) return;
      const box = img.parentElement;
      const fallback = box?.querySelector("template[data-media-fallback]");
      if (!box || !(fallback instanceof HTMLTemplateElement)) return;
      box.classList.replace("media--photo", "media--art");
      box.classList.remove("is-loading");
      img.replaceWith(fallback.content.cloneNode(true));
      fallback.remove();
    },
    true,
  );
}
