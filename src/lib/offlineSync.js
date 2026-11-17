/**
 * Sends the offline queue to the server. Pure logic with injected storage, network call and clock, so it is tested
 * without a browser.
 *
 * Rules:
 *  - A queued sale keeps ONE id (also its checkout idempotency key) for life, so resending can never duplicate it.
 *  - Sales are sent oldest first, one at a time; only one sync runs at once (in this tab, and across tabs with a lock).
 *  - Connection trouble (or a server hiccup) keeps the sale "pending" and retries with exponential backoff + jitter.
 *    A sale is never dropped because the network was down.
 *  - A refusal the cashier can't fix by resending is kept, with the server's reason: "conflict" (stock, price,
 *    register) waits for a person; "failed" is a refusal such as a validation error. Neither is retried automatically.
 *  - A sale the server accepted is "synced" (kept for a while as a record, then tidied away).
 *
 * Statuses: pending → syncing → synced | conflict | failed | discarded
 */

export const STATUS = /** @type {const} */ (["pending", "syncing", "synced", "conflict", "failed", "discarded"]);
export const DEFAULTS = { baseMs: 2000, maxMs: 15 * 60 * 1000, maxServerErrors: 12, staleSyncingMs: 2 * 60 * 1000, keepSyncedMs: 7 * 24 * 3600 * 1000 };

/** Milliseconds to wait before attempt number `attempts` (0-based), with jitter. */
export const backoffDelay = (attempts, random = Math.random, { baseMs, maxMs } = DEFAULTS) => Math.round(Math.min(maxMs, baseMs * 2 ** attempts) * (0.5 + random() * 0.5));

const isNetwork = (e) => /^(functions[/])?unavailable$/.test(String(e?.code ?? "")) || e?.name === "TypeError";

/**
 * @param {{ store: ReturnType<typeof import("./offlineStore.js").memoryStore>, call: (name: string, data: any) => Promise<any>, uid: () => string | null, now?: () => number, random?: () => number, onChange?: () => void, locks?: any, options?: Partial<typeof DEFAULTS> }} deps
 */
export function createSyncEngine({ store, call, uid, now = Date.now, random = Math.random, onChange = () => {}, locks = null, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  /** @type {Promise<any> | null} */
  let running = null;

  const save = async (item) => {
    await store.putQueue(item);
    onChange();
  };

  async function list() {
    return (await store.allQueue()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async function counts() {
    const c = { pending: 0, syncing: 0, synced: 0, conflict: 0, failed: 0, discarded: 0 };
    for (const q of await store.allQueue()) c[q.status] += 1;
    return { ...c, unsent: c.pending + c.syncing + c.conflict + c.failed, lastSyncAt: await store.getMeta("lastSyncAt") };
  }

  /** Writes the sale to local storage BEFORE anything else happens to it. Resolves only once it is stored. */
  async function enqueue(entry) {
    const existing = await store.getQueue(entry.offlineId);
    if (existing) return existing; // the same sale is never queued twice
    const item = { attempts: 0, serverErrors: 0, nextAttemptAt: 0, lastError: null, conflict: null, details: null, result: null, warning: null, resolution: null, syncedAt: null, ...entry, uid: entry.uid ?? uid(), status: "pending", createdAt: entry.createdAt ?? now() };
    await save(item);
    return item;
  }

  /** A "syncing" item left by a tab that closed mid-send goes back to pending (the server's idempotency makes resending safe). */
  async function recoverStale() {
    for (const q of await store.allQueue()) if (q.status === "syncing" && now() - (q.syncStartedAt ?? 0) > opt.staleSyncingMs) await save({ ...q, status: "pending", nextAttemptAt: 0 });
  }

  async function sendOne(item) {
    await save({ ...item, status: "syncing", syncStartedAt: now() });
    try {
      const r = await call("posSyncSale", { ...item.payload, ...(item.resolution ? { resolution: item.resolution } : {}) });
      if (r.status === "synced") {
        await save({ ...item, status: "synced", syncedAt: now(), attempts: item.attempts + 1, lastError: null, conflict: null, details: null, result: { saleId: r.saleId, number: r.number, total: r.total, paidTotal: r.paidTotal, posting: r.posting ?? null }, warning: r.failedPayment ? `The sale was recorded but its payment wasn't: ${r.failedPayment.message}` : r.posting === "failed" ? "The sale was recorded, but its accounting entry failed. The owner can retry it in Accounting." : null });
        await store.setMeta("lastSyncAt", now());
        return "synced";
      }
      await save({ ...item, status: r.status === "conflict" ? "conflict" : "failed", attempts: item.attempts + 1, lastError: r.message, conflict: r.conflict ?? null, details: r.details ?? null, resolution: null });
      await store.setMeta("lastSyncAt", now());
      return r.status;
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (isNetwork(err)) {
        await save({ ...item, status: "pending", attempts: item.attempts + 1, lastError: "No connection. Will retry automatically.", nextAttemptAt: now() + backoffDelay(item.attempts, random, opt) });
        return "offline";
      }
      if (err?.code === "unauthenticated") {
        await save({ ...item, status: "pending", lastError: "Signed out. Sign in again to send this sale.", nextAttemptAt: now() + 60000 });
        return "offline";
      }
      const transient = ["internal", "aborted", "resource-exhausted"].includes(err?.code);
      if (transient && item.serverErrors + 1 < opt.maxServerErrors) {
        await save({ ...item, status: "pending", attempts: item.attempts + 1, serverErrors: item.serverErrors + 1, lastError: err?.message ?? "The server had a problem.", nextAttemptAt: now() + backoffDelay(item.serverErrors, random, opt) });
        return "retry";
      }
      await save({ ...item, status: "failed", attempts: item.attempts + 1, serverErrors: item.serverErrors + 1, lastError: err?.message ?? "The server refused this sale.", details: err?.details ?? null, resolution: null });
      return "failed";
    }
  }

  async function run({ force }) {
    await recoverStale();
    const result = { sent: 0, synced: 0, held: 0, failed: 0, offline: false };
    const me = uid();
    for (const q of await list()) {
      if (q.status !== "pending" || q.uid !== me) continue;
      if (!force && q.nextAttemptAt > now()) break; // keep order: later sales wait behind one that is backing off
      result.sent += 1;
      const outcome = await sendOne(q);
      if (outcome === "synced") result.synced += 1;
      else if (outcome === "conflict") result.held += 1;
      else if (outcome === "failed") result.failed += 1;
      else if (outcome === "offline") {
        result.offline = true;
        break; // no point trying the rest while the connection is down
      }
    }
    // Tidy: synced records older than a week are dropped; they are on the server.
    for (const q of await store.allQueue()) if ((q.status === "synced" || q.status === "discarded") && now() - (q.syncedAt ?? q.createdAt) > opt.keepSyncedMs) await store.deleteQueue(q.offlineId);
    onChange();
    return result;
  }

  /** Send everything that is due. Safe to call from timers, the "online" event and buttons: only one runs at a time. */
  function syncOnce({ force = false } = {}) {
    if (running) return running;
    const go = async () => {
      try {
        return await run({ force });
      } finally {
        running = null;
      }
    };
    running = locks ? locks.request("pos-offline-sync", { ifAvailable: true }, (lock) => (lock ? go() : ((running = null), { skipped: true }))) : go();
    return running;
  }

  /** Retry a held or failed sale as it is (e.g. after stock arrived). */
  async function retry(id) {
    const q = await store.getQueue(id);
    if (!q || !["conflict", "failed"].includes(q.status)) throw new Error("That sale can't be retried.");
    await save({ ...q, status: "pending", nextAttemptAt: 0, serverErrors: 0 });
    return syncOnce({ force: true });
  }

  /** A manager accepts the server's price for a sale held because prices changed. */
  async function acceptServerPrice(id) {
    const q = await store.getQueue(id);
    if (!q || q.status !== "conflict" || q.conflict !== "price_changed") throw new Error("That sale isn't waiting on a price.");
    await save({ ...q, status: "pending", resolution: "accept_server_price", nextAttemptAt: 0 });
    return syncOnce({ force: true });
  }

  /** A manager gives up on a held sale (recorded on the server with the reason). Not possible once the server has the sale. */
  async function discard(id, reason) {
    const q = await store.getQueue(id);
    if (!q || !["conflict", "failed"].includes(q.status)) throw new Error("Only a held or failed sale can be discarded.");
    await call("posSyncDiscard", { offlineId: id, reason });
    await save({ ...q, status: "discarded", lastError: `Discarded: ${reason}`, syncedAt: now() });
  }

  return { enqueue, syncOnce, retry, acceptServerPrice, discard, counts, list, recoverStale };
}
