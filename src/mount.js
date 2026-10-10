/**
 * MOUNT ROUTER - the unjs/unstorage idea: one key space, drivers mounted on
 * key prefixes, the longest matching prefix wins, `''` (root) is always
 * mounted. Keys are `/`-separated (`rec/<sid>/<id>`, `idx/<sid>/...`).
 *
 * Driver contract: `get(key)`, `set(key, value)`, `remove(key)`,
 * `keys(prefix)`, and OPTIONALLY `has(key)`, `range(prefix, {gte, lt,
 * limit, reverse})` and `batch(ops)` (atomic multi-key write). A driver without `range()` still works - the router
 * falls back to `keys(prefix)` + filter + sort, correct but O(prefix size).
 * Every driver sees the FULL key (unstorage strips the mount base; we don't,
 * so a driver can be moved between mounts without its data changing shape).
 */
import { memoryDriver } from './drivers/memory.js';

/**
 * @param {{root?: object, bus?: import('./bus.js').Bus}} [options]
 *   `bus` (optional) receives `store.mount`/`store.unmount` events.
 */
export function createMountRouter({ root = memoryDriver(), bus } = {}) {
  /** @type {Array<{base: string, driver: object}>} longest base first. */
  let mounts = [{ base: '', driver: root }];

  const resolve = (key) => mounts.find((m) => key.startsWith(m.base));

  /** Every mount that may hold keys under `prefix`: the one owning `prefix` itself plus any mounted deeper. */
  const mountsFor = (prefix) => {
    const owner = resolve(prefix);
    return mounts.filter((m) => m === owner || (m.base.startsWith(prefix) && m.base.length > prefix.length));
  };

  /** Keys under `prefix` that actually belong to `m` (not shadowed by a deeper mount). */
  const owned = (m, key) => resolve(key) === m;

  async function rangeIn(m, prefix, options) {
    const { driver } = m;
    if (typeof driver.range === 'function') {
      return driver.range(prefix, { ...options, limit: undefined, reverse: false });
    }
    const { gte, lt } = options;
    const keys = (await driver.keys(prefix)).filter((k) => (gte === undefined || k >= gte) && (lt === undefined || k < lt)).sort();
    const out = [];
    for (const key of keys) out.push({ key, value: await driver.get(key) });
    return out;
  }

  return {
    /** @param {string} base @param {object} driver */
    mount(base, driver) {
      if (mounts.some((m) => m.base === base)) throw new Error(`mount: "${base}" is already mounted`);
      mounts = [...mounts, { base, driver }].sort((a, b) => b.base.length - a.base.length);
      bus?.notify('store.mount', { base, driver: driver.name });
    },
    /** @param {string} base */
    unmount(base) {
      if (base === '') throw new Error('unmount: the root mount cannot be removed');
      mounts = mounts.filter((m) => m.base !== base);
      bus?.notify('store.unmount', { base });
    },
    /** @returns {Array<{base: string, driver: string}>} */
    mounts() {
      return mounts.map((m) => ({ base: m.base, driver: m.driver.name }));
    },
    get(key) {
      return resolve(key).driver.get(key);
    },
    async has(key) {
      const { driver } = resolve(key);
      if (typeof driver.has === 'function') return driver.has(key);
      return (await driver.get(key)) !== null;
    },
    set(key, value) {
      return resolve(key).driver.set(key, value);
    },
    remove(key) {
      return resolve(key).driver.remove(key);
    },
    /**
     * Applies `[{op: 'set', key, value} | {op: 'remove', key}]`. Ops are
     * grouped by mount; each group goes to the driver's atomic `batch()`
     * (or, for a driver without one, one by one). Atomic within a mount,
     * not across mounts.
     * @param {Array<{op: 'set'|'remove', key: string, value?: *}>} ops
     */
    async batch(ops) {
      const groups = new Map();
      for (const op of ops) {
        const m = resolve(op.key);
        if (!groups.has(m)) groups.set(m, []);
        groups.get(m).push(op);
      }
      for (const [{ driver }, group] of groups) {
        if (typeof driver.batch === 'function') await driver.batch(group);
        else for (const { op, key, value } of group) await (op === 'set' ? driver.set(key, value) : driver.remove(key));
      }
    },
    async keys(prefix = '') {
      const all = [];
      for (const m of mountsFor(prefix)) all.push(...(await m.driver.keys(prefix)).filter((k) => owned(m, k)));
      return all.sort();
    },
    /**
     * Ordered range over full keys under `prefix`, merged across every
     * mount involved. `gte`/`lt` are full-key bounds.
     * @param {string} prefix
     * @param {{gte?: string, lt?: string, limit?: number, reverse?: boolean}} [options]
     * @returns {Promise<Array<{key: string, value: *}>>}
     */
    async range(prefix, options = {}) {
      const { limit = Infinity, reverse = false } = options;
      const involved = mountsFor(prefix);
      if (involved.length === 1 && typeof involved[0].driver.range === 'function') {
        return involved[0].driver.range(prefix, options);
      }
      const rows = [];
      for (const m of involved) rows.push(...(await rangeIn(m, prefix, options)).filter((r) => owned(m, r.key)));
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (reverse) rows.reverse();
      return rows.slice(0, limit);
    },
  };
}
