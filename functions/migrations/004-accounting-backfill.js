/**
 * Accounting backfill: posts journals for business events that happened BEFORE accounting was switched on, using
 * the very same posting rules as live postings (services/accountingRules.js), dated on the day each event happened.
 *
 * What it reads: sales and their cost snapshots, customer payment records (collections, refunds, reversals),
 * goods received notes, supplier payments and purchase returns. What it will NOT do:
 *  - invent anything. A sale whose cost was never recorded is posted as revenue only (no cost of goods sold, no
 *    inventory movement) and counted in the report; a payment with no sale, or a sale whose amounts don't add up,
 *    is skipped and listed;
 *  - post opening balances (owner-controlled, see Opening Balances) or supplier opening balances;
 *  - touch stock, sales, payments or the supplier ledger. It only writes journals and their ledger lines.
 * It is idempotent: an event whose journal already exists is left alone (journal ids come from the source), so it
 * can be re-run safely. It posts in date order, one transaction per event. It needs the chart of accounts to exist.
 *
 * NOT in MIGRATIONS (so `npm run migrate` never runs it). `npm run migrate:accounting` is a dry run unless --apply.
 */
import { FieldValue } from "firebase-admin/firestore";
import { pktDateKey } from "../shared/accounting.js";
import { saleSpec, customerPaymentSpec, refundSpec, grnSpec, supplierPaymentSpec, purchaseReturnSpec, toDateKey } from "../services/accountingRules.js";
import { buildJournal, reversalSpec, reversalIdOf, postStandalone, AccountingError } from "../services/accounting.js";

export const MIGRATION_ID = "004-accounting-backfill";
const PAGE = 300;
const ms = (t) => t?.toMillis?.() ?? (t instanceof Date ? t.getTime() : 0);

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{ apply?: boolean, log?: (line: string) => void }} [options]
 */
export async function runAccountingBackfill(db, { apply = false, log = () => {} } = {}) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    ready: false,
    events: /** @type {Record<string, number>} */ ({}),
    toPost: 0,
    alreadyPosted: 0,
    posted: 0,
    postedWithoutCost: 0,
    skipped: /** @type {{ source: string, id: string, reason: string }[]} */ ([]),
    wouldFail: /** @type {{ source: string, id: string, reason: string }[]} */ ([]),
    failed: 0,
    verification: { journalsFound: 0, missing: /** @type {string[]} */ ([]), trialBalanceBalanced: /** @type {boolean | null} */ (null) },
    notPosted: ["Opening balances (set up through Opening Balances)", "Supplier opening balances", "Anything before accounting needs an owner decision, not a guess"],
  };
  const cfgSnap = await db.collection("accountingConfig").doc("main").get();
  if (!cfgSnap.exists) {
    log("Accounting hasn't been set up (no chart of accounts), so nothing can be posted yet.");
    return report;
  }
  report.ready = true;
  const config = cfgSnap.data();
  const skip = (source, id, reason) => report.skipped.push({ source, id, reason });

  /** @type {{ time: number, source: string, id: string, journalId: string, spec?: any, reverseOf?: string, reason?: string, costMissing?: boolean }[]} */
  const events = [];
  const pageThrough = async (collection, orderField, each) => {
    let last = null;
    for (;;) {
      let q = db.collection(collection).orderBy(orderField).limit(PAGE);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      await each(page.docs);
      last = page.docs[page.size - 1];
      if (page.size < PAGE) break;
    }
  };

  // Sales (and the reversal of cancelled / returned ones).
  await pageThrough("sales", "createdAt", async (docs) => {
    const costs = await db.getAll(...docs.map((d) => db.collection("saleCosts").doc(d.id)));
    docs.forEach((d, i) => {
      const s = d.data();
      if (!Number.isSafeInteger(s.total) || s.netSales + s.taxTotal + s.shippingTotal !== s.total) return skip("sale", d.id, "the sale's amounts don't add up");
      const cost = costs[i].exists ? costs[i].data() : null;
      const spec = saleSpec(d.id, s, cost, s.createdAt);
      events.push({ time: ms(s.createdAt), source: "sale", id: d.id, journalId: `sale__${d.id}`, spec, costMissing: !cost?.costComplete });
      if (["cancelled", "returned", "refunded"].includes(s.status)) {
        const when = s.cancelledAt ?? s.returnedAt ?? s.refundedAt ?? s.updatedAt ?? s.createdAt;
        events.push({ time: ms(when) + 1, source: "sale_reversal", id: d.id, journalId: reversalIdOf(`sale__${d.id}`), reverseOf: `sale__${d.id}`, spec: { reason: `Order ${s.status}`, dateKey: toDateKey(when) } });
      }
    });
  });

  // Customer payments, refunds and reversals.
  await pageThrough("payments", "createdAt", async (docs) => {
    const sales = await db.getAll(...docs.map((d) => db.collection("sales").doc(d.id)));
    for (const [i, d] of docs.entries()) {
      const txs = await d.ref.collection("transactions").orderBy("at").get();
      for (const t of txs.docs) {
        const x = t.data();
        const sale = sales[i];
        if (x.type === "reversal") {
          events.push({ time: ms(x.at), source: "payment_reversal", id: `${d.id}/${t.id}`, journalId: reversalIdOf(`payment__${x.reverses}`), reverseOf: `payment__${x.reverses}`, spec: { reason: `Payment entry reversed: ${x.reason ?? ""}`, dateKey: toDateKey(x.at) } });
          continue;
        }
        if (!sale.exists) {
          skip("payment", `${d.id}/${t.id}`, "no sale to attach the payment to");
          continue;
        }
        if (!Number.isSafeInteger(x.amount) || x.amount <= 0) {
          skip("payment", `${d.id}/${t.id}`, "the amount isn't a positive whole number of paisa");
          continue;
        }
        if (x.type === "collection") events.push({ time: ms(x.at), source: "payment", id: `${d.id}/${t.id}`, journalId: `payment__${t.id}`, spec: customerPaymentSpec({ sale: sale.data(), txnId: t.id, amount: x.amount, method: x.method ?? "cod", reference: x.reference ?? "", when: x.at }) });
        else if (x.type === "refund") events.push({ time: ms(x.at), source: "refund", id: `${d.id}/${t.id}`, journalId: `refund__${t.id}`, spec: refundSpec({ sale: sale.data(), txnId: t.id, amount: x.amount, reason: x.reason ?? "", when: x.at }) });
      }
    }
  });

  await pageThrough("goodsReceipts", "createdAt", async (docs) => {
    for (const d of docs) {
      if (!(d.data().value > 0)) continue;
      events.push({ time: ms(d.data().receivedDate ?? d.data().createdAt), source: "grn", id: d.id, journalId: `grn__${d.id}`, spec: grnSpec(d.id, d.data()) });
    }
  });
  await pageThrough("supplierPayments", "createdAt", async (docs) => {
    for (const d of docs) events.push({ time: ms(d.data().paidAt ?? d.data().createdAt), source: "supplier_payment", id: d.id, journalId: `supplierpayment__${d.id}`, spec: supplierPaymentSpec(d.id, d.data()) });
  });
  await pageThrough("purchaseReturns", "createdAt", async (docs) => {
    for (const d of docs) if (d.data().value > 0) events.push({ time: ms(d.data().createdAt), source: "purchase_return", id: d.id, journalId: `purchasereturn__${d.id}`, spec: purchaseReturnSpec(d.id, d.data()) });
  });

  events.sort((a, b) => a.time - b.time || a.journalId.localeCompare(b.journalId));
  for (const e of events) report.events[e.source] = (report.events[e.source] ?? 0) + 1;

  // Which already have a journal?
  const have = new Set();
  for (let i = 0; i < events.length; i += 300) {
    const part = events.slice(i, i + 300);
    (await db.getAll(...part.map((e) => db.collection("journalEntries").doc(e.journalId)))).forEach((s) => s.exists && have.add(s.id));
  }
  const todo = events.filter((e) => !have.has(e.journalId));
  report.alreadyPosted = events.length - todo.length;
  report.toPost = todo.length;
  log(`${events.length} events found: ${report.alreadyPosted} already have a journal, ${todo.length} to post.`);

  const planned = new Set(todo.map((e) => e.journalId));
  // Dry run: check each journal WOULD be accepted by the engine (accounts exist, are active, amounts balance).
  if (!apply) {
    for (const e of todo) {
      if (e.reverseOf) {
        if (!have.has(e.reverseOf) && !planned.has(e.reverseOf)) report.wouldFail.push({ source: e.source, id: e.id, reason: "the journal it would reverse doesn't exist and isn't being posted" });
        continue;
      }
      try {
        buildJournal(config, e.spec);
        if (e.costMissing) report.postedWithoutCost += 1;
      } catch (error) {
        if (!(error instanceof AccountingError)) throw error;
        report.wouldFail.push({ source: e.source, id: e.id, reason: error.message });
      }
    }
    return report;
  }

  for (const e of todo) {
    let spec = e.spec;
    if (e.reverseOf) {
      const original = await db.collection("journalEntries").doc(e.reverseOf).get();
      if (!original.exists || original.data().status !== "posted") {
        skip(e.source, e.id, "the journal it would reverse doesn't exist");
        continue;
      }
      spec = reversalSpec({ id: original.id, ...original.data() }, e.spec.reason, e.spec.dateKey);
    }
    const r = await postStandalone(spec, "system");
    if (r.status === "posted") {
      report.posted += 1;
      if (e.costMissing) report.postedWithoutCost += 1;
    } else if (r.status === "failed") report.failed += 1;
  }

  // Verify: the journals exist, and the books balance.
  for (let i = 0; i < todo.length; i += 300) {
    const part = todo.slice(i, i + 300);
    (await db.getAll(...part.map((e) => db.collection("journalEntries").doc(e.journalId)))).forEach((s) => (s.exists ? (report.verification.journalsFound += 1) : report.verification.missing.push(s.id)));
  }
  const today = pktDateKey(new Date());
  const months = await db.collection("accountMonths").get();
  void today;
  let dr = 0;
  let cr = 0;
  for (const m of months.docs) for (const t of Object.values(m.data().accounts ?? {})) {
    dr += t.debit ?? 0;
    cr += t.credit ?? 0;
  }
  report.verification.trialBalanceBalanced = dr === cr;
  await db.collection("_migrations").doc(MIGRATION_ID).set(
    { status: report.failed || report.verification.missing.length ? "done-with-issues" : "done", description: "Journals for events before accounting was switched on", summary: { events: events.length, posted: report.posted, skipped: report.skipped.length, failed: report.failed }, finishedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return report;
}
