/**
 * INDEXEDDB DRIVER - the browser's durable store: one object store with
 * out-of-line string keys. IndexedDB orders string keys by UTF-16 code
 * units, the same order as JS `<`, so `range()` maps onto a key cursor.
 * Values are stored by structured clone (Uint8Arrays included).
 *
 * `indexedDB`/`IDBKeyRange` are injectable so the driver also runs under
 * `fake-indexeddb` in Node tests.
 */
const prefixEnd = (prefix) => prefix + '￿';

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * @param {{name?: string, store?: string, indexedDB?: IDBFactory, IDBKeyRange?: typeof IDBKeyRange}} [options]
 */
export function indexedDbDriver({ name = 'qu-lite', store = 'kv', indexedDB = globalThis.indexedDB, IDBKeyRange: KeyRange = globalThis.IDBKeyRange } = {}) {
  if (!indexedDB || !KeyRange) throw new Error('indexedDbDriver: IndexedDB is not available here');
  let dbPromise = null;
  const db = () => {
    if (!dbPromise) {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(store);
      dbPromise = done(request);
    }
    return dbPromise;
  };
  const objectStore = async (mode) => (await db()).transaction(store, mode).objectStore(store);
  const bounds = (prefix, gte, lt) => {
    const lower = gte !== undefined && gte > prefix ? gte : prefix;
    const upper = lt !== undefined && lt < prefixEnd(prefix) ? lt : prefixEnd(prefix);
    return lower < upper ? KeyRange.bound(lower, upper, false, true) : null;
  };

  return {
    name: 'indexeddb',
    async get(key) {
      const value = await done((await objectStore('readonly')).get(key));
      return value === undefined ? null : value;
    },
    async has(key) {
      return (await done((await objectStore('readonly')).getKey(key))) !== undefined;
    },
    async set(key, value) {
      await done((await objectStore('readwrite')).put(value, key));
    },
    async remove(key) {
      await done((await objectStore('readwrite')).delete(key));
    },
    /** All ops in one readwrite transaction: IndexedDB commits all or aborts all. */
    async batch(ops) {
      const tx = (await db()).transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const finished = new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('indexeddb: transaction aborted'));
        tx.onerror = () => reject(tx.error);
      });
      try {
        for (const { op, key, value } of ops) {
          if (op === 'set') os.put(value, key);
          else if (op === 'remove') os.delete(key);
          else throw new Error(`indexeddb: unknown op ${op}`);
        }
      } catch (error) {
        tx.abort();
        await finished.catch(() => {});
        throw error;
      }
      await finished;
    },
    async keys(prefix = '') {
      const range = bounds(prefix);
      return range ? done((await objectStore('readonly')).getAllKeys(range)) : [];
    },
    async range(prefix, { gte, lt, limit = Infinity, reverse = false } = {}) {
      const range = bounds(prefix, gte, lt);
      if (!range) return [];
      const os = await objectStore('readonly');
      return new Promise((resolve, reject) => {
        const out = [];
        const request = os.openCursor(range, reverse ? 'prev' : 'next');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= limit) return resolve(out);
          out.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        };
      });
    },
    async clear() {
      await done((await objectStore('readwrite')).clear());
    },
    async close() {
      if (dbPromise) (await dbPromise).close();
      dbPromise = null;
    },
  };
}
