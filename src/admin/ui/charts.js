/**
 * Small dependency-free SVG charts for the analytics screens: line, column, horizontal bar and pie. They draw only the data they are given
 * ({ type, title, unit, labels, series: [{ name, values }] }), show an honest empty state, scale to any width (viewBox), and give every point a
 * tooltip (hover, tap or keyboard focus) plus a "Show data" table for screen readers and phones.
 */
import { esc } from "../../lib/format.js";
import { signedPKR } from "../../../shared/reportFormat.js";

const W = 640;
const H = 260;
const PALETTE = ["ch-s0", "ch-s1", "ch-s2", "ch-s3", "ch-s4", "ch-s5"];

/** Short axis numbers: 1.2M, 35k. */
const compact = (n) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(0)}k` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : String(Math.round(a * 10) / 10);
  return n < 0 ? `−${s}` : s;
};
/** @param {number} v @param {string} unit */
export const axisValue = (v, unit) => (unit === "money" ? compact(v / 100) : unit === "percent" ? `${compact(v)}%` : compact(v));
/** @param {number} v @param {string} unit */
export const fullValue = (v, unit) => (unit === "money" ? signedPKR(v) : unit === "percent" ? `${v}%` : v.toLocaleString("en-PK"));

/** A "nice" axis maximum and step for a data maximum. @param {number} max */
export function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 1 / ticks };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { max: step * ticks, step };
}

const short = (s, n = 18) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const tip = (label, name, value, unit) => esc(`${label}${name ? ` · ${name}` : ""}: ${fullValue(value, unit)}`);

function legend(spec) {
  return spec.series.length > 1 || spec.type === "pie" ? `<ul class="ch-legend">${(spec.type === "pie" ? spec.labels : spec.series.map((s) => s.name)).map((n, i) => `<li><span class="ch-swatch ${PALETTE[i % PALETTE.length]}"></span>${esc(short(n, 30))}</li>`).join("")}</ul>` : "";
}

function dataTable(spec) {
  const rows = spec.type === "pie" ? spec.labels.map((l, i) => [l, spec.series[0].values[i]]) : spec.labels.map((l, i) => [l, ...spec.series.map((s) => s.values[i])]);
  const head = spec.type === "pie" ? ["", spec.series[0].name] : ["", ...spec.series.map((s) => s.name)];
  return `<details class="ch-data"><summary>Show data</summary><div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="r"' : ""}>${i ? esc(fullValue(c ?? 0, spec.unit)) : esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}

function axes(spec, plot) {
  const all = spec.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const { max, step } = niceScale(Math.max(...all, 0));
  const min = lo < 0 ? -niceScale(-lo).max : 0;
  const y = (v) => plot.t + plot.h - ((v - min) / (max - min || 1)) * plot.h;
  const grid = [];
  for (let v = min; v <= max + step / 2; v += step) grid.push(`<line class="ch-grid" x1="${plot.l}" x2="${plot.l + plot.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ch-axis" x="${plot.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(axisValue(v, spec.unit))}</text>`);
  return { y, grid: grid.join(""), zero: y(0) };
}

function xLabels(labels, plot, centre) {
  const every = Math.max(1, Math.ceil(labels.length / 8));
  return labels.map((l, i) => (i % every === 0 ? `<text class="ch-axis" x="${centre(i).toFixed(1)}" y="${plot.t + plot.h + 18}" text-anchor="middle">${esc(short(l, 10))}</text>` : "")).join("");
}

function line(spec) {
  const plot = { l: 56, t: 12, w: W - 56 - 12, h: H - 12 - 36 };
  const { y, grid } = axes(spec, plot);
  const n = spec.labels.length;
  const x = (i) => plot.l + (n === 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
  const paths = spec.series.map((s, k) => `<polyline class="ch-line ${PALETTE[k % PALETTE.length]}" fill="none" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`).join("");
  const dots = spec.series.map((s, k) => s.values.map((v, i) => `<circle class="ch-dot ${PALETTE[k % PALETTE.length]}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 45 ? 2 : 3.5}" tabindex="0" data-tip="${tip(spec.labels[i], spec.series.length > 1 ? s.name : "", v, spec.unit)}"/>`).join("")).join("");
  return `${grid}${paths}${dots}${xLabels(spec.labels, plot, x)}`;
}

function column(spec) {
  const plot = { l: 56, t: 12, w: W - 56 - 12, h: H - 12 - 36 };
  const { y, grid, zero } = axes(spec, plot);
  const n = spec.labels.length;
  const band = plot.w / n;
  const k = spec.series.length;
  const bw = Math.max(2, Math.min(44, (band * 0.7) / k));
  const bars = spec.series.map((s, si) => s.values.map((v, i) => {
    const cx = plot.l + band * i + band / 2 - (bw * k) / 2 + bw * si;
    const top = Math.min(y(v), zero);
    return `<rect class="ch-bar ${PALETTE[si % PALETTE.length]}" x="${cx.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(zero - y(v))).toFixed(1)}" tabindex="0" data-tip="${tip(spec.labels[i], k > 1 ? s.name : "", v, spec.unit)}"/>`;
  }).join("")).join("");
  return `${grid}${bars}${xLabels(spec.labels, plot, (i) => plot.l + band * i + band / 2)}`;
}

function bar(spec) {
  const left = 128;
  const plot = { l: left, t: 8, w: W - left - 16, h: 0 };
  const n = spec.labels.length;
  const rowH = Math.max(18, Math.min(30, 240 / n));
  const k = spec.series.length;
  const all = spec.series.flatMap((s) => s.values);
  const { max } = niceScale(Math.max(...all, 0));
  const x = (v) => (Math.max(0, v) / (max || 1)) * plot.w;
  const bars = spec.labels.map((l, i) => {
    const yy = plot.t + i * rowH;
    return `<text class="ch-axis" x="${left - 6}" y="${(yy + rowH / 2 + 4).toFixed(1)}" text-anchor="end">${esc(short(l, 20))}</text>${spec.series.map((s, si) => `<rect class="ch-bar ${PALETTE[si % PALETTE.length]}" x="${left}" y="${(yy + 3 + (si * (rowH - 6)) / k).toFixed(1)}" width="${Math.max(1, x(s.values[i])).toFixed(1)}" height="${((rowH - 6) / k).toFixed(1)}" tabindex="0" data-tip="${tip(l, k > 1 ? s.name : "", s.values[i], spec.unit)}"/>`).join("")}`;
  }).join("");
  const height = plot.t * 2 + n * rowH;
  return { body: bars, height };
}

function pie(spec) {
  const values = spec.series[0].values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = 130;
  const cy = 130;
  const r = 110;
  let angle = -Math.PI / 2;
  const slices = values.map((v, i) => {
    if (v <= 0) return "";
    const share = v / total;
    const label = `${spec.labels[i]} (${Math.round(share * 1000) / 10}%)`;
    if (share > 0.9999) return `<circle class="ch-slice ${PALETTE[i % PALETTE.length]}" cx="${cx}" cy="${cy}" r="${r}" tabindex="0" data-tip="${tip(label, "", v, spec.unit)}"/>`;
    const a1 = angle + share * Math.PI * 2;
    const large = share > 0.5 ? 1 : 0;
    const d = `M${cx} ${cy} L${(cx + r * Math.cos(angle)).toFixed(1)} ${(cy + r * Math.sin(angle)).toFixed(1)} A${r} ${r} 0 ${large} 1 ${(cx + r * Math.cos(a1)).toFixed(1)} ${(cy + r * Math.sin(a1)).toFixed(1)}Z`;
    angle = a1;
    return `<path class="ch-slice ${PALETTE[i % PALETTE.length]}" d="${d}" tabindex="0" data-tip="${tip(label, "", v, spec.unit)}"/>`;
  }).join("");
  return slices;
}

/** The chart as HTML. Returns an empty-state message when there is nothing to draw. @param {{ type: string, title: string, unit: string, labels: string[], series: { name: string, values: number[] }[] }} spec */
export function renderChart(spec) {
  const has = spec.labels?.length && spec.series?.some((s) => s.values.some((v) => v !== 0 && v !== null));
  const head = `<h3 class="ch-title">${esc(spec.title)}</h3>`;
  if (!has) return `<figure class="ch">${head}<p class="muted ch-empty">No data for this period.</p></figure>`;
  const clean = { ...spec, series: spec.series.map((s) => ({ ...s, values: s.values.map((v) => (Number.isFinite(v) ? v : 0)) })) };
  let svg;
  if (spec.type === "pie") svg = `<svg viewBox="0 0 260 260" class="ch-svg ch-svg--pie" role="img" aria-label="${esc(spec.title)}">${pie(clean)}</svg>`;
  else if (spec.type === "bar") {
    const b = bar(clean);
    svg = `<svg viewBox="0 0 ${W} ${b.height}" class="ch-svg" role="img" aria-label="${esc(spec.title)}">${b.body}</svg>`;
  } else svg = `<svg viewBox="0 0 ${W} ${H}" class="ch-svg" role="img" aria-label="${esc(spec.title)}">${spec.type === "line" ? line(clean) : column(clean)}</svg>`;
  return `<figure class="ch">${head}<div class="ch-wrap">${svg}<div class="ch-tip" role="status" hidden></div></div>${legend(clean)}${dataTable(clean)}</figure>`;
}

/** Make the tooltips work inside a container (call after inserting chart HTML). @param {ParentNode} root */
export function wireCharts(root) {
  root.querySelectorAll(".ch-wrap").forEach((wrap) => {
    const box = /** @type {HTMLElement} */ (wrap.querySelector(".ch-tip"));
    const show = (el) => {
      box.textContent = el.getAttribute("data-tip") ?? "";
      box.hidden = false;
      const w = wrap.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      box.style.left = `${Math.min(Math.max(0, r.left - w.left + r.width / 2 - box.offsetWidth / 2), Math.max(0, w.width - box.offsetWidth))}px`;
      box.style.top = `${Math.max(0, r.top - w.top - box.offsetHeight - 8)}px`;
    };
    const hide = () => (box.hidden = true);
    wrap.addEventListener("pointerover", (e) => {
      const t = /** @type {Element} */ (e.target).closest("[data-tip]");
      if (t) show(t);
    });
    wrap.addEventListener("pointerleave", hide);
    wrap.addEventListener("focusin", (e) => {
      const t = /** @type {Element} */ (e.target).closest("[data-tip]");
      if (t) show(t);
    });
    wrap.addEventListener("focusout", hide);
    wrap.addEventListener("click", (e) => {
      const t = /** @type {Element} */ (e.target).closest("[data-tip]");
      if (t) show(t);
      else hide();
    });
  });
}
