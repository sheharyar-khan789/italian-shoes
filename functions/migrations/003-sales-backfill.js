/**
 * Sales backfill: gives every online order placed BEFORE the unified sales model a linked sale
 * (sales/{orderId}), built only from what the order and its payment record already say.
 *
 *  - Nothing is deleted. The only change to an existing order is two new fields (saleId, saleNumber); its dates,
 *    totals, status, history and payment records are not touched (updatedAt is left alone).
 *  - The sale keeps the order's own createdAt/updatedAt, so history keeps its original timing.
 *  - Historical cost is NOT invented: those sales are saved with "cost not recorded", so they never contribute
 *    to profit figures. Only sales placed after this feature carry a cost snapshot.
 *  - Where the order has no record of which warehouse its pairs came from, they are attributed to the default
 *    warehouse (that is where every pair came from before warehouses existed).
 *  - Idempotent: an order that already has a sale is skipped, and each sale is created in its own transaction
 *    that re-checks. Sale numbers are given in order-date order. Run it right after deploying, so the older
 *    orders get their numbers before many newer ones do.
 *
 * It is NOT in MIGRATIONS (so `npm run migrate` never runs it by accident). `npm run migrate:sales` is a dry run
 * unless --apply is given.
 */
import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_WAREHOUSE_ID } from "../shared/schemas/warehouses.js";
import { saleFromOrder, createSale, nextSaleNumber } from "../services/sales.js";

export const MIGRATION_ID = "003-sales-backfill";
const PAGE = 300;
const sum = (items, f) => items.reduce((n, l) => n + l[f], 0);

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{ apply?: boolean, log?: (line: string) => void }} [options]
 */
export async function runSalesBackfill(db, { apply = false, log = () => {} } = {}) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    ordersScanned: 0,
    alreadyLinked: 0,
    toBackfill: 0,
    backfilled: 0,
    skipped: 0,
    problems: {
      orderTotalsDontAdd: /** @type {string[]} */ ([]),
      orderWithoutItems: /** @type {string[]} */ ([]),
      orderWithoutDate: /** @type {string[]} */ ([]),
      orderWithoutPaymentRecord: /** @type {string[]} */ ([]),
      saleDisagreesWithOrder: /** @type {string[]} */ ([]),
      orderMissingSaleLink: /** @type {string[]} */ ([]),
      saleWithoutOrder: /** @type {string[]} */ ([]),
    },
    verification: { checked: 0, mismatches: /** @type {string[]} */ ([]) },
  };

  /** @type {{ id: string, safe: boolean }[]} */
  const todo = [];
  let last = null;
  for (;;) {
    let q = db.collection("orders").orderBy("createdAt").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    const [sales, pays] = await Promise.all([db.getAll(...page.docs.map((d) => db.collection("sales").doc(d.id))), db.getAll(...page.docs.map((d) => db.collection("payments").doc(d.id)))]);
    page.docs.forEach((doc, i) => {
      const o = doc.data();
      report.ordersScanned += 1;
      const sale = sales[i];
      if (sale.exists) {
        report.alreadyLinked += 1;
        const s = sale.data();
        if (s.orderId !== doc.id || s.total !== o.grandTotal || s.status !== o.status) report.problems.saleDisagreesWithOrder.push(doc.id);
        if (o.saleId !== doc.id) report.problems.orderMissingSaleLink.push(doc.id);
        return;
      }
      let safe = true;
      if (!Array.isArray(o.items) || !o.items.length) {
        report.problems.orderWithoutItems.push(doc.id);
        safe = false;
      } else if (sum(o.items, "lineTotal") !== o.subtotal || o.subtotal - (o.discountTotal ?? 0) + (o.taxTotal ?? 0) + (o.shippingTotal ?? 0) !== o.grandTotal) {
        report.problems.orderTotalsDontAdd.push(doc.id);
        safe = false;
      }
      if (!o.createdAt) {
        report.problems.orderWithoutDate.push(doc.id);
        safe = false;
      }
      if (!pays[i].exists) report.problems.orderWithoutPaymentRecord.push(doc.id); // still backfilled: the order's own payment fields are used
      todo.push({ id: doc.id, safe });
    });
    last = page.docs[page.size - 1];
    if (page.size < PAGE) break;
  }
  report.toBackfill = todo.filter((t) => t.safe).length;
  report.skipped = todo.filter((t) => !t.safe).length;

  // Sales whose order doesn't exist (online sales only).
  last = null;
  for (;;) {
    let q = db.collection("sales").where("channel", "==", "online").orderBy("createdAt").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    const orders = await db.getAll(...page.docs.map((d) => db.collection("orders").doc(d.data().orderId ?? d.id)));
    page.docs.forEach((d, i) => {
      if (!orders[i].exists) report.problems.saleWithoutOrder.push(d.id);
    });
    last = page.docs[page.size - 1];
    if (page.size < PAGE) break;
  }
  log(`${report.ordersScanned} orders scanned: ${report.alreadyLinked} already have a sale, ${report.toBackfill} to backfill, ${report.skipped} skipped for review.`);
  if (!apply) return report;

  // Apply, oldest order first, one transaction each.
  for (const item of todo.filter((t) => t.safe)) {
    const orderRef = db.collection("orders").doc(item.id);
    const done = await db.runTransaction(async (tx) => {
      const [order, sale, pay, alloc, counter] = await Promise.all([tx.get(orderRef), tx.get(db.collection("sales").doc(item.id)), tx.get(db.collection("payments").doc(item.id)), tx.get(orderRef.collection("stock").doc("allocations")), tx.get(db.collection("counters").doc("sales"))]);
      if (!order.exists || sale.exists) return false;
      const o = order.data();
      const no = nextSaleNumber(counter);
      const taken = alloc.exists ? alloc.data().lines : [];
      const built = saleFromOrder(o, {
        orderId: item.id,
        number: no.number,
        unitCosts: o.items.map(() => null), // historical cost was never recorded; it is not guessed
        allocations: o.items.map((_, i) => taken[i]?.allocations ?? null),
        actorUid: o.userId ?? "system",
        idempotencyKey: null,
        pay: pay.exists ? pay.data() : { amount: o.grandTotal, status: o.paymentStatus ?? "pending", refundedTotal: 0 },
      });
      tx.set(db.collection("counters").doc("sales"), { next: no.nextValue });
      createSale(tx, item.id, built, { createdAt: o.createdAt, updatedAt: o.updatedAt ?? o.createdAt });
      tx.update(orderRef, { saleId: item.id, saleNumber: no.number });
      return true;
    });
    if (done) report.backfilled += 1;
  }

  // Verify: every backfilled order now has exactly one sale with the same totals and status.
  const refs = todo.filter((t) => t.safe).slice(0, 5000).flatMap((t) => [db.collection("orders").doc(t.id), db.collection("sales").doc(t.id)]);
  const checked = refs.length ? await db.getAll(...refs) : [];
  for (let i = 0; i < checked.length; i += 2) {
    const [order, sale] = [checked[i], checked[i + 1]];
    report.verification.checked += 1;
    const o = order.data();
    const s = sale.data();
    if (!sale.exists || s.total !== o.grandTotal || s.subtotal !== o.subtotal || s.status !== o.status || s.orderId !== order.id || o.saleId !== order.id) report.verification.mismatches.push(order.id);
  }
  await db.collection("_migrations").doc(MIGRATION_ID).set(
    {
      status: report.verification.mismatches.length ? "done-with-mismatches" : "done",
      description: "Linked sale for every earlier online order (no cost invented)",
      summary: { scanned: report.ordersScanned, backfilled: report.backfilled, skipped: report.skipped },
      finishedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return report;
}

export { DEFAULT_WAREHOUSE_ID };
