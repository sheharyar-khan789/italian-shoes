/**
 * Local storage for the offline till: the queue of sales made offline, a cached catalogue, and a little metadata.
 * IndexedDB survives page refreshes and browser restarts (unlike memory or sessionStorage), which is the point: a sale
 * that has been written here is not lost until the server has accepted it. A memory version with the same interface
 * is used by tests.
 *
 * Store interface (all async): getQueue(id) putQueue(item) allQueue() deleteQueue(id)
 *                              getMeta(key) setMeta(key, value)  getCatalog(warehouseId) putCatalog(warehouseId, data)
 */
const DB_NAME = "italian-shoes-pos";
const VERSION = 1;

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** @returns {Promise<ReturnType<typeof memoryStore>>} Rejects if the browser has no usable IndexedDB (e.g. some private windows). */
export function openIdbStore(factory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(new Error("This browser can't store offline sales."));
    const open = factory.open(DB_NAME, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("queue", { keyPath: "offlineId" });
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("catalog", { keyPath: "warehouseId" });
    };
    open.onerror = () => reject(open.error ?? new Error("Couldn't open offline storage."));
    open.onsuccess = () => {
      const db = open.result;
      const tx = (store) => db.transaction(store, "readonly").objectStore(store);
      // A write counts as done only when its transaction has COMMITTED to disk, not merely when the request was accepted.
      const write = (store, fn) =>
        new Promise((res, rej) => {
          const t = db.transaction(store, "readwrite");
          fn(t.objectStore(store));
          t.oncomplete = () => res(undefined);
          t.onerror = () => rej(t.error);
          t.onabort = () => rej(t.error ?? new Error("The browser refused to save."));
        });
      resolve({
        persistent: true,
        getQueue: (id) => wrap(tx("queue").get(id)).then((v) => v ?? null),
        putQueue: (item) => write("queue", (o) => o.put(item)),
        allQueue: () => wrap(tx("queue").getAll()),
        deleteQueue: (id) => write("queue", (o) => o.delete(id)),
        getMeta: (key) => wrap(tx("meta").get(key)).then((v) => v?.value ?? null),
        setMeta: (key, value) => write("meta", (o) => o.put({ key, value })),
        getCatalog: (warehouseId) => wrap(tx("catalog").get(warehouseId)).then((v) => v ?? null),
        putCatalog: (warehouseId, data) => write("catalog", (o) => o.put({ warehouseId, ...data })),
      });
    };
  });
}

/** Same interface, in memory (tests). */
export function memoryStore() {
  const queue = new Map();
  const meta = new Map();
  const catalog = new Map();
  const copy = (v) => (v === undefined || v === null ? null : structuredClone(v));
  return {
    persistent: false,
    getQueue: async (id) => copy(queue.get(id)),
    putQueue: async (item) => void queue.set(item.offlineId, structuredClone(item)),
    allQueue: async () => [...queue.values()].map((v) => structuredClone(v)),
    deleteQueue: async (id) => void queue.delete(id),
    getMeta: async (key) => copy(meta.get(key)),
    setMeta: async (key, value) => void meta.set(key, structuredClone(value)),
    getCatalog: async (id) => copy(catalog.get(id)),
    putCatalog: async (id, data) => void catalog.set(id, structuredClone({ warehouseId: id, ...data })),
  };
}
