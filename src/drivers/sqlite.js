/**
 * SQLITE DRIVER (Node >= 22.5, built-in `node:sqlite`, no dependency) - the
 * mirror's and any Node peer's durable store. One table, `key TEXT PRIMARY
 * KEY`; SQLite's default BINARY collation orders keys exactly like JS string
 * comparison for our ASCII keys, so `range()` is an index scan.
 *
 * Values: a bare Uint8Array is stored as a BLOB; anything else as JSON, with
 * nested Uint8Arrays tagged (`{"$u8": base64}`) so identities etc. survive.
 * WAL mode + synchronous=NORMAL: crash-safe, and fast enough for a mirror.
 *
 * Import it from `@qu/lite/sqlite` - never from the barrel, so browser
 * bundles don't see `node:sqlite`.
 */
import { DatabaseSync } from 'node:sqlite';

const toJson = (value) =>
  JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $u8: Buffer.from(v).toString('base64') } : v));
const fromJson = (text) =>
  JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.$u8 === 'string' ? new Uint8Array(Buffer.from(v.$u8, 'base64')) : v));

/** Smallest string greater than every key starting with `prefix`. */
const prefixEnd = (prefix) => prefix + '￿';

/** @param {{path?: string}} [options] - `path` default `':memory:'`. */
export function sqliteDriver({ path = ':memory:' } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
           CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, bin INTEGER NOT NULL, value BLOB) WITHOUT ROWID;`);
  const q = {
    get: db.prepare('SELECT bin, value FROM kv WHERE key = ?'),
    has: db.prepare('SELECT 1 FROM kv WHERE key = ?'),
    set: db.prepare('INSERT INTO kv (key, bin, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET bin = excluded.bin, value = excluded.value'),
    remove: db.prepare('DELETE FROM kv WHERE key = ?'),
    keys: db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key'),
    range: db.prepare('SELECT key, bin, value FROM kv WHERE key >= ? AND key < ? ORDER BY key ASC LIMIT ?'),
    rangeDesc: db.prepare('SELECT key, bin, value FROM kv WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?'),
    clear: db.prepare('DELETE FROM kv'),
  };
  const setSync = (key, value) => {
    if (value instanceof Uint8Array) q.set.run(key, 1, value);
    else q.set.run(key, 0, Buffer.from(toJson(value), 'utf8'));
  };
  const decode = (row) => (row.bin ? new Uint8Array(row.value) : fromJson(Buffer.from(row.value).toString('utf8')));

  return {
    name: 'sqlite',
    async get(key) {
      const row = q.get.get(key);
      return row ? decode(row) : null;
    },
    async has(key) {
      return q.has.get(key) !== undefined;
    },
    async set(key, value) {
      setSync(key, value);
    },
    /** All ops in one transaction: committed together or rolled back together. */
    async batch(ops) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const { op, key, value } of ops) {
          if (op === 'set') setSync(key, value);
          else if (op === 'remove') q.remove.run(key);
          else throw new Error(`sqlite: unknown op ${op}`);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async remove(key) {
      q.remove.run(key);
    },
    async keys(prefix = '') {
      return q.keys.all(prefix, prefixEnd(prefix)).map((r) => r.key);
    },
    async range(prefix, { gte, lt, limit = Infinity, reverse = false } = {}) {
      const lower = gte !== undefined && gte > prefix ? gte : prefix;
      const upper = lt !== undefined && lt < prefixEnd(prefix) ? lt : prefixEnd(prefix);
      const n = Number.isFinite(limit) ? limit : -1;
      return (reverse ? q.rangeDesc : q.range).all(lower, upper, n).map((row) => ({ key: row.key, value: decode(row) }));
    },
    async clear() {
      q.clear.run();
    },
    /** @returns {Promise<number>} bytes the database file uses (pages, incl. free ones) */
    async size() {
      const { page_count: pages } = db.prepare('PRAGMA page_count').get();
      const { page_size: pageSize } = db.prepare('PRAGMA page_size').get();
      return pages * pageSize;
    },
    close() {
      db.close();
    },
  };
}
