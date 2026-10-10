/**
 * MEMORY DRIVER - the reference implementation of the driver contract
 * `mount.js` routes to: `get/set/remove/keys` (unstorage-shaped) plus the
 * optional `range()` that time-window queries rely on and the optional
 * atomic `batch(ops)`. Keys are kept in a
 * sorted array next to the Map so `range()` is a binary search, not a scan.
 */
export function memoryDriver() {
  const data = new Map();
  /** @type {string[]} */
  const sorted = [];

  const lowerBound = (key) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const setSync = (key, value) => {
    if (!data.has(key)) sorted.splice(lowerBound(key), 0, key);
    data.set(key, value);
  };
  const removeSync = (key) => {
    if (data.delete(key)) sorted.splice(lowerBound(key), 1);
  };

  return {
    name: 'memory',
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async has(key) {
      return data.has(key);
    },
    async set(key, value) {
      setSync(key, value);
    },
    async remove(key) {
      removeSync(key);
    },
    /** Applies all ops in one synchronous step - nothing can interleave. */
    async batch(ops) {
      const bad = ops.find(({ op }) => op !== 'set' && op !== 'remove');
      if (bad) throw new Error(`memory: unknown op ${bad.op}`); // checked first: nothing applied
      for (const { op, key, value } of ops) {
        if (op === 'set') setSync(key, value);
        else removeSync(key);
      }
    },
    async keys(prefix = '') {
      const out = [];
      for (let i = lowerBound(prefix); i < sorted.length && sorted[i].startsWith(prefix); i++) out.push(sorted[i]);
      return out;
    },
    /**
     * @param {string} prefix
     * @param {{gte?: string, lt?: string, limit?: number, reverse?: boolean}} [options] - Bounds are full keys.
     * @returns {Promise<Array<{key: string, value: *}>>}
     */
    async range(prefix, { gte, lt, limit = Infinity, reverse = false } = {}) {
      const start = lowerBound(gte !== undefined && gte > prefix ? gte : prefix);
      const keys = [];
      for (let i = start; i < sorted.length; i++) {
        const key = sorted[i];
        if (!key.startsWith(prefix) || (lt !== undefined && key >= lt)) break;
        keys.push(key);
      }
      if (reverse) keys.reverse();
      return keys.slice(0, limit).map((key) => ({ key, value: data.get(key) }));
    },
    async clear() {
      data.clear();
      sorted.length = 0;
    },
  };
}
