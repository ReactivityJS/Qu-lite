/**
 * MEMORY DRIVER - the reference implementation of the driver contract
 * `mount.js` routes to: `get/set/remove/keys` (unstorage-shaped) plus the
 * optional `range()` that time-window queries rely on. Keys are kept in a
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

  return {
    name: 'memory',
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async has(key) {
      return data.has(key);
    },
    async set(key, value) {
      if (!data.has(key)) sorted.splice(lowerBound(key), 0, key);
      data.set(key, value);
    },
    async remove(key) {
      if (!data.delete(key)) return;
      sorted.splice(lowerBound(key), 1);
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
