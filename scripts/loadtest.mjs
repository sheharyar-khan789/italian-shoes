/**
 * Load and concurrency test of the real HTTP API (run with `npm run e2e -- --load`, which starts the emulators and the
 * test server and seeds fixtures). It talks to the built app's /api over HTTP, exactly as the browser does.
 *
 * IMPORTANT: this measures ONE laptop running the server, the Firestore EMULATOR and this script together. It proves
 * correctness under concurrency (no overselling, no duplicate sales) and shows relative cost per endpoint. It says nothing
 * about how many users the live site, Vercel or Firestore will carry: that needs a staging project and is not claimed.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.E2E_BASE;
const fx = JSON.parse(process.env.E2E_FIXTURES);
const OUT = process.env.E2E_OUT ?? "e2e-output";
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 25);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 20);
process.env.GCLOUD_PROJECT = "demo-italianshoes";
const { db } = await import("../functions/lib/admin.js");

const signIn = async (p) => (await (await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: p.email, password: p.password, returnSecureToken: true }) })).json()).idToken;
const owner = await signIn(fx.people.owner);
const cashier = await signIn(fx.people.cashier);
const api = async (name, token, data = {}) => {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(60000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, ms: performance.now() - t0, body };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, body: { error: String(e) } };
  }
};
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const today = new Date().toISOString().slice(0, 10);
const report = { config: { concurrency: CONCURRENCY, seconds: SECONDS, machine: `${process.platform} ${process.arch}, node ${process.version}`, target: "local test server + Firestore emulator (single machine)" }, phases: {} };

const log = (m) => console.error(`[load] ${m}`);
log("phase 1: mixed read traffic");
/* ── Phase 1: mixed read traffic ── */
const reads = [
  ["posContext", cashier, {}],
  ["posSearch", cashier, { q: "E2E", warehouseId: fx.ids.shop }],
  ["trialBalance", owner, { from: "2020-01-01", to: today }],
  ["inventoryDashboard", owner, {}],
  ["salesReport", owner, { from: new Date(Date.now() - 30 * 86400000).toISOString(), to: new Date().toISOString() }],
];
const lat = Object.fromEntries(reads.map(([n]) => [n, []]));
const errs = Object.fromEntries(reads.map(([n]) => [n, 0]));
let total = 0;
const stopAt = Date.now() + SECONDS * 1000;
await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
  let i = w;
  while (Date.now() < stopAt) {
    const [name, token, data] = reads[i++ % reads.length];
    const r = await api(name, token, data);
    total += 1;
    if (r.status === 200) lat[name].push(r.ms);
    else errs[name] += 1;
  }
}));
report.phases.reads = {
  requests: total,
  perSecond: Math.round((total / SECONDS) * 10) / 10,
  endpoints: Object.fromEntries(reads.map(([n]) => {
    const s = [...lat[n]].sort((a, b) => a - b);
    return [n, { ok: s.length, errors: errs[n], p50: Math.round(pct(s, 50)), p95: Math.round(pct(s, 95)), p99: Math.round(pct(s, 99)), max: Math.round(s.at(-1) ?? 0) }];
  })),
};

log("phase 2: last-pairs race");
/* ── Phase 2: many tills race for the last pairs ── */
const item = fx.items["derby-e2e"];
const key = () => randomUUID().replace(/-/g, "");
const opened = await api("openRegister", cashier, { idempotencyKey: key(), warehouseId: fx.ids.shop, openingFloat: 0 });
const sessionId = opened.body?.data?.sessionId;
const stockNow = async () => (await db.doc(`inventory/${item.productId}__${item.variantId}`).get()).data().byWarehouse[fx.ids.shop].onHand;
const before = await stockNow();
const attempts = Number(process.env.LOAD_RACE ?? 40);
const race = await Promise.all(Array.from({ length: attempts }, () => api("posCheckout", cashier, { idempotencyKey: key(), sessionId, items: [{ productId: item.productId, variantId: item.variantId, qty: 1 }], tenders: [{ method: "cash", amount: item.price }] })));
log(`race finished: ${race.filter((r) => r.status === 200).length} ok, statuses ${[...new Set(race.map((r) => r.status))].join(",")}, slowest ${Math.round(Math.max(...race.map((r) => r.ms)))} ms`);
const won = race.filter((r) => r.status === 200);
const refused = race.filter((r) => r.status !== 200);
const sales = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item.productId);
let journals = 0;
for (const d of sales) if ((await db.doc(`journalEntries/sale__${d.id}`).get()).exists) journals += 1;
const lastRaceMs = race.map((r) => r.ms).sort((a, b) => a - b);
report.phases.lastPairsRace = {
  stockBefore: before, attempts, sold: won.length, refused: refused.length, stockAfter: await stockNow(),
  refusalStatuses: [...new Set(refused.map((r) => r.status))], salesOnServer: sales.length, salesWithJournal: journals,
  p50: Math.round(pct(lastRaceMs, 50)), p95: Math.round(pct(lastRaceMs, 95)), max: Math.round(lastRaceMs.at(-1)),
  verdict: won.length === before && (await stockNow()) === 0 && sales.length === before && journals === before ? "PASS: exactly the pairs in stock were sold, none oversold, every sale booked" : "FAIL",
};

log("phase 3: duplicate requests");
/* ── Phase 3: the same request sent many times at once ── */
const item2 = fx.items["oxford-e2e"];
const dupKey = key();
const dup = await Promise.all(Array.from({ length: 20 }, () => api("posCheckout", cashier, { idempotencyKey: dupKey, sessionId, items: [{ productId: item2.productId, variantId: item2.variantId, qty: 1 }], tenders: [{ method: "cash", amount: item2.price }] })));
const ids = new Set(dup.filter((r) => r.status === 200).map((r) => r.body.data.saleId));
const oxfordSales = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item2.productId);
report.phases.duplicateRequests = { sent: 20, succeeded: dup.filter((r) => r.status === 200).length, distinctSales: ids.size, salesOnServer: oxfordSales.length, verdict: ids.size === 1 && oxfordSales.length === 1 ? "PASS: one sale, however many times it was sent" : "FAIL" };

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/load-result.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const failed = Object.values(report.phases).some((p) => String(p.verdict ?? "").startsWith("FAIL")) || total === 0;
process.exit(failed ? 1 : 0);
