/**
 * The offline till's runtime: opens local storage, owns the sync engine for the signed-in cashier, and tells screens
 * when the connection comes and goes. Started once per page; screens subscribe to changes.
 */
import { openIdbStore } from "../lib/offlineStore.js";
import { createSyncEngine } from "../lib/offlineSync.js";
import { callApi } from "../app/api.js";

const TICK_MS = 20000;
let runtime = null;

/** @param {{ uid: string }} user @returns {Promise<{ engine: ReturnType<typeof createSyncEngine>, store: any, state: { reachable: boolean }, isOffline: () => boolean, subscribe: (fn: () => void) => () => void } | null>} null when the browser can't store offline sales */
export function offlineRuntime(user) {
  runtime ??= start(user).catch(() => null);
  return runtime;
}

async function start(user) {
  const store = await openIdbStore();
  try {
    await navigator.storage?.persist?.(); // ask the browser not to evict the queue
  } catch {
    /* best effort */
  }
  const listeners = new Set();
  const state = { reachable: true };
  const notify = () => listeners.forEach((fn) => fn());
  // Every server call tells us whether the server is reachable.
  const call = async (name, data) => {
    try {
      const r = await callApi(name, data);
      if (!state.reachable) {
        state.reachable = true;
        notify();
      }
      return r;
    } catch (e) {
      if (/^(functions[/])?unavailable$/.test(String(/** @type {any} */ (e)?.code ?? "")) && state.reachable) {
        state.reachable = false;
        notify();
      }
      throw e;
    }
  };
  const engine = createSyncEngine({ store, call, uid: () => user.uid, onChange: notify, locks: navigator.locks ?? null });
  const isOffline = () => !navigator.onLine || !state.reachable;
  const trySync = (force) => engine.syncOnce({ force }).catch(() => {});
  window.addEventListener("online", () => {
    state.reachable = true;
    notify();
    trySync(true);
  });
  window.addEventListener("offline", notify);
  setInterval(() => {
    if (navigator.onLine) trySync(false);
  }, TICK_MS);
  trySync(false);
  return { engine, store, state, isOffline, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)), call };
}
