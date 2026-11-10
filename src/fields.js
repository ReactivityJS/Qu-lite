/**
 * FIELD QUERIES - `qu.query()` by any field of a record's value, for every
 * app the same way (a calendar by `start`, a forum by `thread`, a shop by
 * `price`, a game by `round`):
 *
 *   qu.query({ space, path: 'events', where: { start: { gte: monday, lt: nextMonday } }, orderBy: 'start' })
 *   qu.query({ space, path: 'tasks', where: { status: 'open', tags: 'urgent' } })       // equality; arrays: "contains element"
 *   qu.query({ space, path: 'posts', where: { title: { contains: 'qu' } }, limit: 20 }) // case-insensitive search
 *   qu.query({ space, path: 'users', where: { name: { prefix: 'An' } }, orderBy: 'name' })
 *
 * Conditions per field: a plain value (= eq), an array (= in), or
 * `{eq, in, gt, gte, lt, lte, prefix, contains}`; several fields AND.
 * Field names are dot paths into the value (`'meta.date'`), or `$value`
 * (the value itself, e.g. a chat line), `$key`, `$author`. Comparable
 * values are numbers, strings and booleans (ordered in that type order);
 * dates as ms or ISO strings. `orderBy` sorts by a field (missing values
 * last), otherwise results stay in time (HLC) order; `reverse`, `limit`,
 * `from`, `to` work as in a plain query. Only CURRENT versions match
 * (keyed entries: the newest; deleted ones never).
 *
 * HOW: per (space, path, field) a sorted index is built IN MEMORY on first
 * use (one pass over the path's records) and kept up to date by records.js
 * as records arrive, are superseded or deleted. Nothing readable goes to
 * disk - the store keeps only sealed envelopes and opaque pointers, also
 * with an identity lock. Memory: about 200 bytes per record and indexed
 * field (plus the value itself for long strings). At most `maxIndexes`
 * indexes and `maxEntries` entries in all are kept; the least recently used
 * leaves and is rebuilt when needed again.
 */

const BUILD_BATCH = 64;
const TYPE_RANK = { number: 0, string: 1, boolean: 2 };
const comparable = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || typeof v === 'boolean';
/** Total order over comparable values: numbers < strings < booleans. */
export function compareValues(a, b) {
  const ra = TYPE_RANK[typeof a];
  const rb = TYPE_RANK[typeof b];
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The field of a record: `$value`, `$key`, `$author` or a dot path into the value. */
export function fieldOf(record, field) {
  if (field === '$value') return record.value;
  if (field === '$key') return record.key;
  if (field === '$author') return record.author;
  let v = record.value;
  for (const part of field.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

/** The comparable values a record has in a field (arrays: each element). */
const valuesOf = (record, field) => {
  const v = fieldOf(record, field);
  return (Array.isArray(v) ? v : [v]).filter(comparable);
};

const OPS = new Set(['eq', 'in', 'gt', 'gte', 'lt', 'lte', 'prefix', 'contains']);
/** where -> Map(field -> {eq?, in?, ...}) */
function normalize(where = {}) {
  const out = new Map();
  for (const [field, cond] of Object.entries(where)) {
    if (typeof field !== 'string' || !field) throw new Error('query: empty field name');
    let c;
    if (Array.isArray(cond)) c = { in: cond };
    else if (cond !== null && typeof cond === 'object') c = cond;
    else c = { eq: cond };
    for (const op of Object.keys(c)) if (!OPS.has(op)) throw new Error(`query: unknown condition "${op}" on ${field}`);
    out.set(field, c);
  }
  return out;
}

/** Does one value satisfy a condition? */
function matchValue(v, c) {
  if ('eq' in c && compareValues(v, c.eq) !== 0) return false;
  if ('in' in c && !c.in.some((x) => comparable(x) && compareValues(v, x) === 0)) return false;
  if ('gt' in c && !(sameType(v, c.gt) && compareValues(v, c.gt) > 0)) return false;
  if ('gte' in c && !(sameType(v, c.gte) && compareValues(v, c.gte) >= 0)) return false;
  if ('lt' in c && !(sameType(v, c.lt) && compareValues(v, c.lt) < 0)) return false;
  if ('lte' in c && !(sameType(v, c.lte) && compareValues(v, c.lte) <= 0)) return false;
  if ('prefix' in c && !(typeof v === 'string' && v.startsWith(c.prefix))) return false;
  if ('contains' in c && !(typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase()))) return false;
  return true;
}
const sameType = (a, b) => typeof a === typeof b;
/** A record matches a field condition if ANY of its values does (arrays). */
const matchRecord = (record, field, c) => valuesOf(record, field).some((v) => matchValue(v, c));

/** Sorted entries {v, hlc, id} of one (space, path, field). */
class SortedIndex {
  constructor(field) {
    this.field = field;
    this.entries = [];
    this.ids = new Map(); // id -> its values
  }
  static order(a, b) {
    return compareValues(a.v, b.v) || (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  /** first position whose value is >= v (strict: > v) */
  bound(v, strict = false) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = compareValues(this.entries[mid].v, v);
      if (c < 0 || (strict && c === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Building: append without order (keeps only the field's values, not the records) ... */
  collect(record) {
    if (this.ids.has(record.id)) return;
    const values = [...new Set(valuesOf(record, this.field))];
    if (!values.length) return;
    for (const v of values) this.entries.push({ v, hlc: record.hlc, id: record.id });
    this.ids.set(record.id, values);
  }
  /** ... then one sort - not n sorted inserts. */
  finish() {
    this.entries.sort(SortedIndex.order);
  }
  add(record) {
    if (this.ids.has(record.id)) return;
    const values = [...new Set(valuesOf(record, this.field))];
    if (!values.length) return;
    for (const v of values) {
      const entry = { v, hlc: record.hlc, id: record.id };
      let lo = 0;
      let hi = this.entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (SortedIndex.order(this.entries[mid], entry) < 0) lo = mid + 1;
        else hi = mid;
      }
      this.entries.splice(lo, 0, entry);
    }
    this.ids.set(record.id, values);
  }
  remove(id) {
    const values = this.ids.get(id);
    if (!values) return;
    this.ids.delete(id);
    for (const v of values) {
      // within the run of equal values (binary search), find this id
      for (let i = this.bound(v); i < this.entries.length && compareValues(this.entries[i].v, v) === 0; i++) {
        if (this.entries[i].id === id) {
          this.entries.splice(i, 1);
          break;
        }
      }
    }
  }
  /** Entries a condition can match, in value order. */
  candidates(c) {
    const e = this.entries;
    if ('eq' in c) return comparable(c.eq) ? e.slice(this.bound(c.eq), this.bound(c.eq, true)) : [];
    if ('in' in c) return c.in.filter(comparable).flatMap((x) => e.slice(this.bound(x), this.bound(x, true)));
    let lo = 0;
    let hi = e.length;
    if ('prefix' in c) {
      lo = Math.max(lo, this.bound(String(c.prefix)));
      hi = Math.min(hi, this.bound(`${c.prefix}￿`));
    }
    if ('gte' in c) lo = Math.max(lo, this.bound(c.gte));
    if ('gt' in c) lo = Math.max(lo, this.bound(c.gt, true));
    if ('lt' in c) hi = Math.min(hi, this.bound(c.lt));
    if ('lte' in c) hi = Math.min(hi, this.bound(c.lte, true));
    return e.slice(lo, Math.max(lo, hi));
  }
}

/**
 * @param {{read: (space: object, id: string) => Promise<object|null>,
 *          current: (space: object, path: string) => Promise<Array<{id: string}>>,
 *          maxIndexes?: number, maxEntries?: number}} deps
 */
export function fieldIndexes({ read, current, maxIndexes = 64, maxEntries = 200_000 }) {
  /** key -> {index: SortedIndex, ready: Promise, pending: Array|null, sid, path} */
  const indexes = new Map();
  const keyOf = (sid, path, field) => `${sid}\u0000${path}\u0000${field}`;

  function get(space, path, field) {
    const key = keyOf(space.id, path, field);
    let slot = indexes.get(key);
    if (slot) {
      indexes.delete(key); // LRU: move to the end
      indexes.set(key, slot);
      return slot.ready.then(() => slot.index);
    }
    slot = { index: new SortedIndex(field), pending: [], sid: space.id, path };
    slot.ready = (async () => {
      const ids = (await current(space, path)).map((p) => p.id);
      // decrypt in parallel batches (WebCrypto overlaps them), keep only the field's values
      for (let i = 0; i < ids.length; i += BUILD_BATCH) {
        const batch = await Promise.all(ids.slice(i, i + BUILD_BATCH).map((id) => read(space, id)));
        for (const r of batch) if (r && !r.deleted) slot.index.collect(r);
      }
      slot.index.finish();
      // what changed while the index was built
      for (const op of slot.pending) op(slot.index);
      slot.pending = null;
    })();
    slot.ready.catch(() => indexes.delete(key));
    indexes.set(key, slot);
    if (indexes.size > maxIndexes) indexes.delete(indexes.keys().next().value);
    return slot.ready.then(() => {
      trim(key);
      return slot.index;
    });
  }

  /** Total entries over `maxEntries` (~200 bytes each): the least recently used indexes leave (never `keep`). */
  function trim(keep) {
    let total = 0;
    for (const slot of indexes.values()) total += slot.index.entries.length;
    for (const [key, slot] of indexes) {
      if (total <= maxEntries) break;
      if (key === keep || slot.pending) continue;
      total -= slot.index.entries.length;
      indexes.delete(key);
    }
  }

  const each = (sid, path, op) => {
    for (const slot of indexes.values()) {
      if (slot.sid !== sid || (path !== null && slot.path !== path)) continue;
      if (slot.pending) slot.pending.push(op);
      else op(slot.index);
    }
  };

  return {
    /** records.js: a record became the current version of its path */
    added(sid, record) {
      if (!record.deleted) each(sid, record.path, (index) => index.add(record));
    },
    /** records.js: a record left (superseded, deleted, dropped, retired) */
    removed(sid, id) {
      each(sid, null, (index) => index.remove(id));
    },
    /** records.js: a space was left or forgotten */
    dropSpace(sid) {
      for (const [key, slot] of indexes) if (slot.sid === sid) indexes.delete(key);
    },
    /** @returns {{indexes: number, entries: number}} what is held in memory */
    size: () => ({ indexes: indexes.size, entries: [...indexes.values()].reduce((n, s) => n + s.index.entries.length, 0) }),

    /**
     * @param {object} space
     * @param {{path: string, where?: object, orderBy?: string, from?: number, to?: number, limit?: number, reverse?: boolean}} q
     * @returns {Promise<object[]>}
     */
    async select(space, q) {
      const conds = normalize(q.where);
      const fields = [...conds.keys()];
      // the field that narrows most: equality first, then a range, then the sort field
      const kind = (c) => ('eq' in c || 'in' in c ? 0 : 'gt' in c || 'gte' in c || 'lt' in c || 'lte' in c || 'prefix' in c ? 1 : 2);
      const driver = [...fields].sort((a, b) => kind(conds.get(a)) - kind(conds.get(b)))[0];
      let ids;
      if (driver) {
        const index = await get(space, q.path, driver);
        const c = conds.get(driver);
        let entries = index.candidates(c);
        if ('contains' in c) entries = entries.filter((e) => matchValue(e.v, c));
        ids = [...new Set(entries.map((e) => e.id))];
      } else ids = (await current(space, q.path)).map((p) => p.id);

      const fromHlc = q.from !== undefined ? String(q.from).padStart(13, '0') : null;
      const toHlc = q.to !== undefined ? String(q.to).padStart(13, '0') : null;
      const out = [];
      for (const id of ids) {
        const record = await read(space, id);
        if (!record || record.deleted) continue;
        if (fromHlc && record.hlc < fromHlc) continue;
        if (toHlc && record.hlc >= toHlc) continue;
        if (fields.every((f) => matchRecord(record, f, conds.get(f)))) out.push(record);
      }
      const byHlc = (a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : 1);
      const dir = q.reverse ? -1 : 1;
      if (q.orderBy) {
        const first = (r) => {
          const vs = valuesOf(r, q.orderBy);
          return vs.length ? vs.reduce((m, v) => (compareValues(v, m) < 0 ? v : m)) : undefined;
        };
        const keyed = out.map((r) => [first(r), r]);
        // records without the field go last, also when reversed
        keyed.sort(([a, ra], [b, rb]) => (a === undefined ? (b === undefined ? dir * byHlc(ra, rb) : 1) : b === undefined ? -1 : dir * (compareValues(a, b) || byHlc(ra, rb))));
        out.splice(0, out.length, ...keyed.map(([, r]) => r));
      } else out.sort((a, b) => dir * byHlc(a, b));
      return q.limit !== undefined ? out.slice(0, q.limit) : out;
    },
  };
}
