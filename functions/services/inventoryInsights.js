/**
 * Inventory overview: items with stock per warehouse, levels and locations, alerts, valuation (weighted average cost,
 * reconciled to the general ledger), barcodes, the dashboard and the report tables. Every number is read from the real
 * inventory, cost, movement, adjustment, transfer and count records; nothing is typed in or estimated.
 *
 *   inventory/{pid__vid}        stock per warehouse (existing)      variantCosts/{pid__vid}  average cost (existing)
 *   stockPolicies/{pid__vid}    minimum, reorder level, maximum, storage location per warehouse
 *   barcodes/{code}             barcode → variant (unique: the code is the document id)
 *   settings/inventory          alert thresholds and adjustment approval limits
 *
 * A scan of the inventory is bounded (SCAN_LIMIT variants); beyond that the screens say so instead of showing partial totals.
 */
import { Timestamp } from "firebase-admin/firestore";
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey, naturalBalance } from "../shared/accounting.js";
import { ALERT_DEFAULTS, ADJUST_REASONS, TRANSFER_STATUS_LABEL, internalEan13, isEan13 } from "../shared/inventory.js";
import { effectivePrice, inventoryId } from "./products.js";
import { entriesOf, warehouseMap } from "./inventory.js";
import { configRef } from "./accounting.js";
import { balancesAsOf } from "./accountingReports.js";

const SCAN_LIMIT = 2000;
const MAX_DOCS = 5000;
const col = (key, label, type = "text") => ({ key, label, type });
const table = (title, columns, rows, totals = null) => ({ title, columns, rows, totals });
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
const startOf = (k) => Timestamp.fromDate(new Date(`${k}T00:00:00+05:00`));
const endOf = (k) => Timestamp.fromDate(new Date(`${k}T23:59:59.999+05:00`));
const dayOf = (t) => (t?.toDate ? pktDateKey(t.toDate()) : "");

/** @typedef {{ uid: string, name: string }} Actor */

/* ───────── Settings and stock levels ───────── */

export async function getInventorySettings() {
  const s = await db.collection("settings").doc("inventory").get();
  return { ...ALERT_DEFAULTS, ...(s.exists ? s.data() : {}), updatedAt: undefined };
}

/** @param {Record<string, any>} input validated inventorySettingsInput @param {Actor} actor */
export async function saveInventorySettings(input, actor) {
  await db.collection("settings").doc("inventory").set({ ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: true });
  await writeAudit({ actorUid: actor.uid, action: "inventory.settings_updated", entityType: "settings", entityId: "inventory", changes: input });
  return input;
}

/** Minimum / reorder / maximum and where the pairs are kept. @param {Record<string, any>} input validated stockPolicyInput @param {Actor} actor */
export async function setStockPolicy({ productId, variantId, minStock, reorderLevel, maxStock, locations }, actor) {
  const variant = await db.collection("products").doc(productId).collection("variants").doc(variantId).get();
  if (!variant.exists) throw new AppError("not-found", "That size/colour doesn't exist.");
  const whs = warehouseMap((await db.collection("warehouses").get()).docs);
  for (const wid of Object.keys(locations)) if (!whs.has(wid)) throw new AppError("invalid-argument", "A storage location names a warehouse that doesn't exist.", { fields: { locations: "Unknown warehouse" } });
  await db.collection("stockPolicies").doc(inventoryId(productId, variantId)).set({ productId, variantId, minStock, reorderLevel, maxStock, locations: Object.fromEntries(Object.entries(locations).filter(([, v]) => v.trim())), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
  await writeAudit({ actorUid: actor.uid, action: "inventory.policy_set", entityType: "stockPolicy", entityId: inventoryId(productId, variantId), changes: { minStock, reorderLevel, maxStock, locations } });
  return { ok: true };
}

/* ───────── The inventory scan ───────── */

/**
 * Every variant with its stock per warehouse, cost, value and levels.
 * @returns {Promise<{ rows: any[], warehouses: Map<string, any>, settings: Record<string, any> }>}
 */
async function scan() {
  const [inv, costs, policies, whSnap, variants, products, settings] = await Promise.all([
    db.collection("inventory").limit(SCAN_LIMIT + 1).get(),
    db.collection("variantCosts").limit(SCAN_LIMIT + 1).get(),
    db.collection("stockPolicies").limit(SCAN_LIMIT + 1).get(),
    db.collection("warehouses").get(),
    db.collectionGroup("variants").limit(SCAN_LIMIT + 1).get(),
    db.collection("products").limit(SCAN_LIMIT + 1).get(),
    getInventorySettings(),
  ]);
  if (inv.size > SCAN_LIMIT) throw new AppError("failed-precondition", `There are more than ${SCAN_LIMIT} sizes/colours; this overview can't total them all.`);
  const warehouses = warehouseMap(whSnap.docs);
  const cost = new Map(costs.docs.map((d) => [d.id, d.data().costPrice ?? null]));
  const policy = new Map(policies.docs.map((d) => [d.id, d.data()]));
  const variant = new Map(variants.docs.map((d) => [`${d.ref.parent.parent?.id}__${d.id}`, d.data()]));
  const product = new Map(products.docs.map((d) => [d.id, d.data()]));
  const rows = [];
  for (const d of inv.docs) {
    const [productId, variantId] = d.id.split("__");
    const v = variant.get(d.id);
    const p = product.get(productId);
    if (!v || !p || p.status === "archived") continue;
    const entries = entriesOf(/** @type {any} */ ({ exists: true, data: () => d.data() }));
    const byWh = Object.fromEntries(Object.entries(entries).map(([wid, e]) => [wid, { onHand: e.onHand ?? 0, reserved: e.reserved ?? 0 }]));
    const onHand = Object.values(byWh).reduce((n, e) => n + e.onHand, 0);
    const reserved = Object.values(byWh).reduce((n, e) => n + e.reserved, 0);
    const c = cost.get(d.id) ?? null;
    const pol = policy.get(d.id) ?? {};
    rows.push({ id: d.id, productId, variantId, productName: p.name, colorName: v.colorName ?? "", sizeLabel: v.sizeLabel ?? "", variantLabel: `${v.colorName ?? ""} / ${v.sizeLabel ?? ""}`, sku: v.sku ?? "", barcode: v.barcode ?? "", price: effectivePrice(v), isActive: v.isActive !== false, byWh, onHand, reserved, available: onHand - reserved, cost: c, value: c === null ? 0 : onHand * c, minStock: pol.minStock ?? null, reorderLevel: pol.reorderLevel ?? null, maxStock: pol.maxStock ?? null, locations: pol.locations ?? {} });
  }
  return { rows, warehouses, settings };
}

/* ───────── Alerts ───────── */

function classify(rows, settings, sold, moved) {
  const alerts = [];
  for (const r of rows) {
    if (!r.isActive) continue;
    const low = r.minStock ?? settings.lowStock;
    const base = { id: r.id, productId: r.productId, variantId: r.variantId, product: r.productName, variant: r.variantLabel, sku: r.sku, available: r.available, onHand: r.onHand };
    if (r.available <= 0) alerts.push({ ...base, kind: "out", detail: "None available" });
    else if (r.available <= low) alerts.push({ ...base, kind: "low", detail: `${r.available} left (alert at ${low})` });
    if (r.reorderLevel !== null && r.available <= r.reorderLevel) alerts.push({ ...base, kind: "reorder", detail: `${r.available} left, reorder level ${r.reorderLevel}` });
    if (r.maxStock !== null && r.onHand > r.maxStock) alerts.push({ ...base, kind: "over", detail: `${r.onHand} on hand, maximum ${r.maxStock}` });
    if (sold && moved && r.onHand > 0) {
      if (!moved.has(r.id)) alerts.push({ ...base, kind: "dead", detail: `No movement in ${settings.deadDays}+ days` });
      else if (!sold.has(r.id)) alerts.push({ ...base, kind: "slow", detail: `Not sold in ${settings.slowDays}+ days` });
    }
  }
  return alerts;
}

async function movementSets(settings) {
  const since = Timestamp.fromMillis(Date.now() - settings.deadDays * 86400000);
  const snap = await db.collection("stockMovements").where("at", ">=", since).orderBy("at").limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) return null;
  const slowSince = Date.now() - settings.slowDays * 86400000;
  const sold = new Set();
  const moved = new Set();
  for (const d of snap.docs) {
    const m = d.data();
    moved.add(m.inventoryId);
    if (m.reason === "sale" && m.at.toMillis() >= slowSince) sold.add(m.inventoryId);
  }
  return { sold, moved };
}

export async function inventoryAlerts() {
  const { rows, settings } = await scan();
  const sets = await movementSets(settings);
  const alerts = classify(rows, settings, sets?.sold, sets?.moved);
  const counts = {};
  for (const a of alerts) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return { alerts, counts, settings, note: sets ? "" : "Slow-moving and dead-stock checks were skipped: there are too many stock movements in the period to scan." };
}

/* ───────── Items list (screen) ───────── */

export async function inventoryItems() {
  const { rows, warehouses } = await scan();
  return { items: rows.sort((a, b) => a.productName.localeCompare(b.productName) || a.variantLabel.localeCompare(b.variantLabel)), warehouses: [...warehouses.values()].map((w) => ({ id: w.id, name: w.name, isActive: w.isActive !== false })) };
}

/* ───────── Dashboard ───────── */

export async function inventoryDashboard() {
  const { rows, warehouses, settings } = await scan();
  const [recent, adjDamaged, transfers, returns] = await Promise.all([
    db.collection("stockMovements").orderBy("at", "desc").limit(10).get(),
    db.collection("stockAdjustments").where("reason", "==", "damaged").limit(MAX_DOCS).get(),
    db.collection("stockTransfers").limit(1000).get(),
    db.collection("purchaseReturns").limit(2000).get(),
  ]);
  const sets = await movementSets(settings);
  const alerts = classify(rows, settings, sets?.sold, sets?.moved);
  const whRows = [...warehouses.values()].map((w) => {
    const per = rows.map((r) => r.byWh[w.id]).filter(Boolean);
    return { id: w.id, name: w.name, isActive: w.isActive !== false, onHand: per.reduce((n, e) => n + e.onHand, 0), reserved: per.reduce((n, e) => n + e.reserved, 0), value: rows.reduce((n, r) => n + (r.cost === null ? 0 : (r.byWh[w.id]?.onHand ?? 0) * r.cost), 0) };
  });
  const damagedAdj = adjDamaged.docs.filter((d) => d.data().status === "applied").reduce((n, d) => n + Math.abs(d.data().changeQty), 0);
  const damagedTransfer = transfers.docs.reduce((n, d) => n + (d.data().lines ?? []).reduce((m, l) => m + (l.damagedQty ?? 0), 0), 0);
  const missingTransfer = transfers.docs.reduce((n, d) => n + (d.data().lines ?? []).reduce((m, l) => m + (l.missingQty ?? 0), 0), 0);
  return {
    products: new Set(rows.map((r) => r.productId)).size,
    variants: rows.length,
    onHand: sum(rows, "onHand"),
    reserved: sum(rows, "reserved"),
    available: sum(rows, "available"),
    damagedWrittenOff: damagedAdj + damagedTransfer,
    missingInTransfer: missingTransfer,
    returnedToSuppliers: returns.docs.reduce((n, d) => n + (d.data().lines ?? []).reduce((m, l) => m + (l.qty ?? 0), 0), 0),
    value: sum(rows, "value"),
    unitsWithoutCost: rows.filter((r) => r.cost === null).reduce((n, r) => n + r.onHand, 0),
    lowStock: alerts.filter((a) => a.kind === "low").length,
    outOfStock: alerts.filter((a) => a.kind === "out").length,
    reorder: alerts.filter((a) => a.kind === "reorder").length,
    overstock: alerts.filter((a) => a.kind === "over").length,
    slow: alerts.filter((a) => a.kind === "slow").length,
    dead: alerts.filter((a) => a.kind === "dead").length,
    topAlerts: alerts.filter((a) => ["out", "low"].includes(a.kind)).slice(0, 10),
    warehouses: whRows,
    recentMovements: recent.docs.map((d) => ({ id: d.id, date: dayOf(d.data().at), product: d.data().productName, variant: d.data().variantLabel, warehouseId: d.data().warehouseId, change: d.data().change, reason: d.data().reason, onHandAfter: d.data().onHandAfter })),
    movementNote: sets ? "" : "Slow-moving and dead-stock counts are unavailable (too many movements to scan).",
  };
}

/* ───────── Valuation ───────── */

/** Weighted-average-cost valuation of the stock on hand now, compared with the inventory account in the books. @param {{ asOf?: string }} [input] */
export async function inventoryValuation({ asOf } = {}) {
  const { rows, warehouses } = await scan();
  const today = pktDateKey(new Date());
  const cfgSnap = await configRef().get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : null;
  let glNow = null;
  let glAsOf = null;
  if (cfg?.enabled && cfg.roles?.inventory) {
    const code = cfg.roles.inventory;
    const nat = (map) => naturalBalance(cfg.accounts[code], map.get(code)?.debit ?? 0, map.get(code)?.credit ?? 0);
    glNow = nat(await balancesAsOf(today));
    glAsOf = asOf && asOf !== today ? nat(await balancesAsOf(asOf)) : glNow;
  }
  const total = sum(rows, "value");
  return {
    method: "Weighted average cost (moving average, updated by every goods receipt)",
    total,
    units: sum(rows, "onHand"),
    unitsWithoutCost: rows.filter((r) => r.cost === null).reduce((n, r) => n + r.onHand, 0),
    byWarehouse: [...warehouses.values()].map((w) => ({ id: w.id, name: w.name, units: rows.reduce((n, r) => n + (r.byWh[w.id]?.onHand ?? 0), 0), value: rows.reduce((n, r) => n + (r.cost === null ? 0 : (r.byWh[w.id]?.onHand ?? 0) * r.cost), 0) })),
    ledger: cfg?.enabled ? { account: cfg.roles?.inventory ?? null, accountName: cfg.roles?.inventory ? cfg.accounts[cfg.roles.inventory]?.name : null, balanceNow: glNow, balanceAsOf: glAsOf, asOf: asOf ?? today, difference: glNow === null ? null : glNow - total } : null,
    note: "The detailed valuation is of the stock on hand now. A past date is shown from the general ledger (posted journals); pairs without a recorded cost are valued at zero and listed.",
  };
}

/* ───────── Barcodes ───────── */

/** Give a variant a barcode: the one supplied, or a new in-store EAN-13. A code can belong to only one variant. @param {{ productId: string, variantId: string, barcode?: string }} input @param {Actor} actor */
export async function assignBarcode({ productId, variantId, barcode }, actor) {
  if (barcode && barcode.length === 13 && !isEan13(barcode)) throw new AppError("invalid-argument", "That isn't a valid EAN-13 barcode (the last digit doesn't match).", { fields: { barcode: "Invalid check digit" } });
  const variantRef = db.collection("products").doc(productId).collection("variants").doc(variantId);
  const counterRef = db.collection("counters").doc("barcodes");
  return db.runTransaction(async (tx) => {
    const [variant, counter, product] = await Promise.all([tx.get(variantRef), tx.get(counterRef), tx.get(db.collection("products").doc(productId))]);
    if (!variant.exists) throw new AppError("not-found", "That size/colour doesn't exist.");
    let code = barcode;
    let seq = (counter.exists ? counter.data().next : 1) ?? 1;
    if (!code) code = internalEan13(seq++);
    const regRef = db.collection("barcodes").doc(code);
    const reg = await tx.get(regRef);
    if (reg.exists && !(reg.data().productId === productId && reg.data().variantId === variantId)) throw new AppError("already-exists", `That barcode is already used by ${reg.data().productName} (${reg.data().variantLabel}).`, { fields: { barcode: "Already used" } });
    const old = variant.data().barcode;
    if (old && old !== code) tx.delete(db.collection("barcodes").doc(old));
    tx.set(regRef, { productId, variantId, productName: product.data()?.name ?? "", variantLabel: `${variant.data().colorName ?? ""} / ${variant.data().sizeLabel ?? ""}`, sku: variant.data().sku ?? "", assignedBy: actor.uid, assignedAt: FieldValue.serverTimestamp() });
    tx.update(variantRef, { barcode: code });
    if (!barcode) tx.set(counterRef, { next: seq });
    writeAudit({ actorUid: actor.uid, action: "inventory.barcode_assigned", entityType: "variant", entityId: `${productId}/${variantId}`, changes: { barcode: code, previous: old ?? null } }, tx);
    return { barcode: code, previous: old ?? null };
  });
}

/** Find the variant for a scanned barcode (or SKU), with its stock. @param {{ code: string }} input */
export async function lookupBarcode({ code }) {
  const c = code.trim();
  let hit = (await db.collection("barcodes").doc(c).get()).data();
  let via = "barcode";
  if (!hit) {
    const sku = (await db.collection("skus").doc(c.toUpperCase()).get()).data();
    const owner = sku?.owner ?? "";
    const m = /^variant:([^/]+)\/(.+)$/.exec(owner);
    if (m) {
      hit = { productId: m[1], variantId: m[2] };
      via = "sku";
    }
  }
  if (!hit) return { found: false };
  const [variant, product, inv, cost] = await Promise.all([
    db.collection("products").doc(hit.productId).collection("variants").doc(hit.variantId).get(),
    db.collection("products").doc(hit.productId).get(),
    db.collection("inventory").doc(inventoryId(hit.productId, hit.variantId)).get(),
    db.collection("variantCosts").doc(inventoryId(hit.productId, hit.variantId)).get(),
  ]);
  if (!variant.exists) return { found: false };
  const entries = inv.exists ? entriesOf(/** @type {any} */ (inv)) : {};
  return { found: true, via, productId: hit.productId, variantId: hit.variantId, product: product.data()?.name ?? "", variant: `${variant.data().colorName ?? ""} / ${variant.data().sizeLabel ?? ""}`, sku: variant.data().sku ?? "", barcode: variant.data().barcode ?? "", price: effectivePrice(variant.data()), cost: cost.exists ? cost.data().costPrice ?? null : null, onHand: Object.values(entries).reduce((n, e) => n + e.onHand, 0), byWarehouse: Object.fromEntries(Object.entries(entries).map(([w, e]) => [w, e.onHand])) };
}

/* ───────── Reports ───────── */

/** @returns {Promise<Record<string, any>[]>} */
async function inRange(collection, from, to, field = "createdAt") {
  const snap = await db.collection(collection).where(field, ">=", startOf(from)).where(field, "<=", endOf(to)).orderBy(field).limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new AppError("failed-precondition", `That range has more than ${MAX_DOCS} records. Please choose a shorter range.`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** @param {{ report: string, from: string, to: string, warehouseId?: string }} input */
export async function inventoryReport({ report, from, to, warehouseId }) {
  const money = "money";
  const num = "number";
  if (["summary", "product", "size", "colour", "warehouse", "valuation", "low", "slow"].includes(report)) {
    const { rows, warehouses, settings } = await scan();
    const wid = warehouseId;
    const qtyOf = (r) => (wid ? r.byWh[wid]?.onHand ?? 0 : r.onHand);
    const valOf = (r) => (r.cost === null ? 0 : qtyOf(r) * r.cost);
    const note = wid ? [`Warehouse: ${warehouses.get(wid)?.name ?? wid}`] : [];
    const group = (keyFn, label) => {
      /** @type {Map<string, any>} */
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        const g = m.get(k) ?? { name: k, variants: 0, onHand: 0, reserved: 0, available: 0, value: 0 };
        g.variants += 1;
        g.onHand += qtyOf(r);
        g.reserved += wid ? r.byWh[wid]?.reserved ?? 0 : r.reserved;
        g.value += valOf(r);
        m.set(k, g);
      }
      const out = [...m.values()].map((g) => ({ ...g, available: g.onHand - g.reserved })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return table(label, [col("name", label.replace(/^By /, "")), col("variants", "Variants", num), col("onHand", "On hand", num), col("reserved", "Reserved", num), col("available", "Available", num), col("value", "Value at cost", money)], out, { name: "Total", variants: sum(out, "variants"), onHand: sum(out, "onHand"), reserved: sum(out, "reserved"), available: sum(out, "available"), value: sum(out, "value") });
    };
    if (report === "summary") {
      const wh = [...warehouses.values()].map((w) => ({ name: w.name, variants: rows.filter((r) => (r.byWh[w.id]?.onHand ?? 0) > 0).length, onHand: rows.reduce((n, r) => n + (r.byWh[w.id]?.onHand ?? 0), 0), reserved: rows.reduce((n, r) => n + (r.byWh[w.id]?.reserved ?? 0), 0), value: rows.reduce((n, r) => n + (r.cost === null ? 0 : (r.byWh[w.id]?.onHand ?? 0) * r.cost), 0) })).map((w) => ({ ...w, available: w.onHand - w.reserved }));
      return { title: "Stock summary", from, to, tables: [table("By warehouse", [col("name", "Warehouse"), col("variants", "Variants in stock", num), col("onHand", "On hand", num), col("reserved", "Reserved", num), col("available", "Available", num), col("value", "Value at cost", money)], wh, { name: "Total", variants: new Set(rows.filter((r) => r.onHand > 0).map((r) => r.id)).size, onHand: sum(wh, "onHand"), reserved: sum(wh, "reserved"), available: sum(wh, "available"), value: sum(wh, "value") }), group((r) => r.productName, "By product")], notes: ["Stock now, from the inventory records."] };
    }
    if (report === "product") return { title: "Product stock report", from, to, tables: [table("Variants", [col("product", "Product"), col("variant", "Size / colour"), col("sku", "SKU"), col("barcode", "Barcode"), col("onHand", "On hand", num), col("reserved", "Reserved", num), col("available", "Available", num), col("cost", "Average cost", money), col("value", "Value", money), col("location", "Location")], rows.map((r) => ({ product: r.productName, variant: r.variantLabel, sku: r.sku, barcode: r.barcode, onHand: qtyOf(r), reserved: wid ? r.byWh[wid]?.reserved ?? 0 : r.reserved, available: qtyOf(r) - (wid ? r.byWh[wid]?.reserved ?? 0 : r.reserved), cost: r.cost, value: valOf(r), location: wid ? r.locations[wid] ?? "" : Object.entries(r.locations).map(([w, l]) => `${warehouses.get(w)?.name ?? w}: ${l}`).join("; ") })).sort((a, b) => a.product.localeCompare(b.product)))], notes: note };
    if (report === "size") return { title: "Size-wise stock report", from, to, tables: [group((r) => r.sizeLabel || "(none)", "By size")], notes: note };
    if (report === "colour") return { title: "Colour-wise stock report", from, to, tables: [group((r) => r.colorName || "(none)", "By colour")], notes: note };
    if (report === "warehouse") {
      const list = [...warehouses.values()].filter((w) => !wid || w.id === wid);
      return { title: "Warehouse stock report", from, to, tables: list.map((w) => { const items = rows.filter((r) => (r.byWh[w.id]?.onHand ?? 0) > 0 || (r.byWh[w.id]?.reserved ?? 0) > 0).map((r) => ({ product: r.productName, variant: r.variantLabel, sku: r.sku, location: r.locations[w.id] ?? "", onHand: r.byWh[w.id].onHand, reserved: r.byWh[w.id].reserved, value: r.cost === null ? 0 : r.byWh[w.id].onHand * r.cost })); return table(`${w.name}${w.isActive === false ? " (off)" : ""}`, [col("product", "Product"), col("variant", "Size / colour"), col("sku", "SKU"), col("location", "Location"), col("onHand", "On hand", num), col("reserved", "Reserved", num), col("value", "Value", money)], items, { product: "Total", variant: "", sku: "", location: "", onHand: sum(items, "onHand"), reserved: sum(items, "reserved"), value: sum(items, "value") }); }), notes: [] };
    }
    if (report === "valuation") {
      const v = await inventoryValuation({ asOf: to });
      const items = rows.filter((r) => qtyOf(r) > 0).map((r) => ({ product: r.productName, variant: r.variantLabel, sku: r.sku, qty: qtyOf(r), cost: r.cost, value: valOf(r), note: r.cost === null ? "No cost recorded" : "" }));
      return { title: "Inventory valuation report", from, to, tables: [table("Stock on hand valued at weighted average cost", [col("product", "Product"), col("variant", "Size / colour"), col("sku", "SKU"), col("qty", "Pairs", num), col("cost", "Average cost", money), col("value", "Value", money), col("note", "Note")], items, { product: "Total", variant: "", sku: "", qty: sum(items, "qty"), cost: null, value: sum(items, "value"), note: "" }), ...(v.ledger ? [table("Reconciliation with the general ledger", [col("what", "What"), col("amount", "Amount", money)], [{ what: `Stock valuation (${v.method})`, amount: v.total }, { what: `${v.ledger.accountName ?? "Inventory account"} balance now`, amount: v.ledger.balanceNow }, { what: `${v.ledger.accountName ?? "Inventory account"} balance at ${v.ledger.asOf}`, amount: v.ledger.balanceAsOf }, { what: "Difference (ledger − valuation, now)", amount: v.ledger.difference }])] : [])], notes: [v.note, v.unitsWithoutCost ? `${v.unitsWithoutCost} pairs have no recorded cost and are valued at zero.` : ""].filter(Boolean) };
    }
    const sets = await movementSets(settings);
    const alerts = classify(rows, settings, sets?.sold, sets?.moved);
    const pick = report === "low" ? ["out", "low", "reorder", "over"] : ["slow", "dead"];
    const list = alerts.filter((a) => pick.includes(a.kind));
    return { title: report === "low" ? "Low stock report" : "Slow moving products report", from, to, tables: [table(report === "low" ? "Stock alerts" : "Slow-moving and dead stock", [col("kind", "Alert"), col("product", "Product"), col("variant", "Size / colour"), col("sku", "SKU"), col("onHand", "On hand", num), col("available", "Available", num), col("detail", "Detail")], list.map((a) => ({ ...a, kind: { out: "Out of stock", low: "Low stock", reorder: "Reorder", over: "Overstock", slow: "Slow moving", dead: "Dead stock" }[a.kind] })))], notes: report === "slow" ? [`Slow: stock on hand but no sale in ${settings.slowDays} days. Dead: no stock movement at all in ${settings.deadDays} days.`, ...(sets ? [] : ["Skipped: too many stock movements in the period to scan."])] : [`Low-stock alert at ${settings.lowStock} pairs unless a variant has its own minimum.`] };
  }

  if (report === "movements") {
    const moves = (await inRange("stockMovements", from, to, "at")).filter((m) => !warehouseId || m.warehouseId === warehouseId);
    const whs = warehouseMap((await db.collection("warehouses").get()).docs);
    return { title: "Stock movement ledger", from, to, tables: [table("Movements", [col("date", "Date"), col("product", "Product"), col("variant", "Size / colour"), col("warehouse", "Warehouse"), col("reason", "Reason"), col("source", "Source"), col("in", "In", num), col("out", "Out", num), col("after", "On hand after", num)], moves.map((m) => ({ date: dayOf(m.at), product: m.productName, variant: m.variantLabel, warehouse: whs.get(m.warehouseId ?? "main")?.name ?? m.warehouseId ?? "Main warehouse", reason: m.reason, source: m.sourceType ?? "", in: m.change > 0 ? m.change : 0, out: m.change < 0 ? -m.change : 0, after: m.onHandAfter })), { date: "Total", product: "", variant: "", warehouse: "", reason: "", source: "", in: sum(moves.map((m) => ({ v: m.change > 0 ? m.change : 0 })), "v"), out: sum(moves.map((m) => ({ v: m.change < 0 ? -m.change : 0 })), "v"), after: null })], notes: [] };
  }
  if (report === "adjustments") {
    const adj = (await inRange("stockAdjustments", from, to)).filter((a) => !warehouseId || a.warehouseId === warehouseId);
    return { title: "Stock adjustment report", from, to, tables: [table("Adjustments", [col("date", "Date"), col("number", "Ref"), col("product", "Item"), col("warehouse", "Warehouse"), col("reason", "Reason"), col("prev", "Previous", num), col("change", "Change", num), col("next", "New", num), col("value", "Value at cost", money), col("status", "Status"), col("by", "By"), col("description", "Description")], adj.map((a) => ({ date: dayOf(a.createdAt), number: a.number, product: `${a.productName} (${a.variantLabel})`, warehouse: a.warehouseName, reason: ADJUST_REASONS[a.reason]?.label ?? a.reason, prev: a.previousQty, change: a.changeQty, next: a.newQty, value: a.status === "applied" ? (a.changeQty < 0 ? -(a.value ?? 0) : a.value ?? 0) : null, status: a.status, by: a.createdByName, description: a.description })))], notes: ["Value: negative = written off, positive = stock gain, at the average cost when applied."] };
  }
  if (report === "transfers") {
    const tr = await inRange("stockTransfers", from, to);
    return { title: "Stock transfer report", from, to, tables: [table("Transfers", [col("date", "Date"), col("number", "Ref"), col("from", "From"), col("to", "To"), col("status", "Status"), col("sent", "Pairs sent", num), col("received", "Received", num), col("damaged", "Damaged", num), col("missing", "Missing", num), col("lossValue", "Written off", money)], tr.map((t) => ({ date: dayOf(t.createdAt), number: t.number, from: t.fromName, to: t.toName, status: TRANSFER_STATUS_LABEL[t.status] ?? t.status, sent: t.itemCount, received: (t.lines ?? []).reduce((n, l) => n + (l.receivedQty ?? 0), 0), damaged: (t.lines ?? []).reduce((n, l) => n + (l.damagedQty ?? 0), 0), missing: (t.lines ?? []).reduce((n, l) => n + (l.missingQty ?? 0), 0), lossValue: t.lossValue ?? 0 })))], notes: [] };
  }
  // counts
  const cs = (await inRange("stockCounts", from, to)).filter((c) => !warehouseId || c.warehouseId === warehouseId);
  const lines = cs.flatMap((c) => Object.values(c.lines ?? {}).filter((l) => l.countedQty !== null && l.countedQty !== undefined && l.variance !== 0).map((l) => ({ number: c.number, warehouse: c.warehouseName, status: c.status, product: `${l.productName} (${l.variantLabel})`, system: l.systemQty, counted: l.countedQty, variance: l.variance, value: l.unitCost === null ? null : l.variance * l.unitCost, applied: l.applied ? "Applied" : l.error ? "Needs attention" : "—" })));
  return { title: "Physical stock count report", from, to, tables: [table("Counts", [col("date", "Date"), col("number", "Count"), col("warehouse", "Warehouse"), col("status", "Status"), col("counted", "Items counted", num), col("variances", "With a difference", num), col("short", "Short pairs", num), col("over", "Over pairs", num), col("value", "Difference value", money)], cs.map((c) => ({ date: dayOf(c.createdAt), number: c.number, warehouse: c.warehouseName, status: c.status, counted: c.summary?.counted ?? 0, variances: c.summary?.withVariance ?? 0, short: c.summary?.shortUnits ?? 0, over: c.summary?.overUnits ?? 0, value: c.summary?.varianceValue ?? 0 }))), table("Variances (counted − system)", [col("number", "Count"), col("warehouse", "Warehouse"), col("product", "Item"), col("system", "System", num), col("counted", "Counted", num), col("variance", "Variance", num), col("value", "Value at cost", money), col("applied", "Result")], lines)], notes: [] };
}
