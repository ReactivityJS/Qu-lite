/**
 * COMPACTION - deleting and compacting for members, on top of drop lists
 * (gc.js) that every peer and the blind mirror apply alike:
 *
 *   qu.del(space, record|id)       a log entry (chat message) leaves every peer
 *                                  - your own, or any as owner/admin
 *   qu.del(space, path, key)       a keyed entry: tombstone version (stays the
 *                                  head, so older versions can't come back),
 *                                  the version it replaced is dropped
 *   qu.compact(space, {all})       drops superseded versions - your own, with
 *                                  `all` (owner/admin) everyone's - and expires
 *                                  drop lists past the horizon
 *
 * `auto` (default on): your own versions that get superseded (profile
 * fields, receipt cursors, ...) are collected and dropped in one drop list
 * after `delayMs`. A timer expires old drop lists every `expireEveryMs`.
 *
 * Hooks: emit('qu.compact.candidate', {space, id, path, author}) - ctx.stop()
 * keeps a version. Paths whose first segment is in `keep` are never compacted.
 */
import { peekEnvelope } from './envelope.js';
import { mayDrop } from './gc.js';

/**
 * @param {{auto?: boolean, delayMs?: number, expireEveryMs?: number, keep?: string[]}} [options]
 */
export function compaction({ auto = true, delayMs = 60_000, expireEveryMs = 6 * 60 * 60 * 1000, keep = ['_keys', '_grants'] } = {}) {
  return (qu) => {
    if (!qu.records) throw new Error('compaction(): install records() first');
    if (qu.compaction) return qu.compaction;
    const { bus, storage, clock } = qu;
    const records = qu.records;
    const env = qu.envelopes;
    /** @type {Map<string, Set<string>>} sid -> own superseded ids waiting to be dropped */
    const queued = new Map();
    const timers = new Map();

    const joined = (sid) => {
      try {
        return records.spaceOf(sid);
      } catch {
        return null;
      }
    };

    /** @returns {Promise<{id: string, path: string, ts: number, author: string}|null>} */
    async function target(space, id) {
      const bytes = await storage.get(`rec/${space.id}/${id}`);
      if (!bytes) return null;
      let record;
      try {
        record = await records.read(space, id);
      } catch {
        return null; // can't read it: can't name its drop-list path either
      }
      return record && { id, path: record.path, ts: peekEnvelope(bytes).ts, author: record.author };
    }

    const allowed = async (space, author) => mayDrop(qu.keyring.state(space.id) ?? space.grantState(), space.id, await records.authorOf(space), author);

    /** Applies `keep` and the veto hook. */
    async function compactable(space, t) {
      if (keep.includes(t.path.split('/')[0])) return false;
      const ctx = await bus.emit('qu.compact.candidate', { space: space.id, id: t.id, path: t.path, author: t.author });
      return !ctx.stopped;
    }

    /**
     * Deletes a log entry, or (with `path, key`) a keyed entry.
     * @param {import('./space.js').Space|string} spaceRef
     * @param {object|string} recordOrPath - a record / record id, or a path
     * @param {string} [key]
     */
    async function del(spaceRef, recordOrPath, key) {
      const space = records.spaceOf(spaceRef);
      if (typeof key === 'string') {
        const previous = await records.headOf(space, recordOrPath, key);
        await records.write(space, recordOrPath, null, { key, deleted: true });
        const me = await records.authorOf(space);
        // the replaced version: your own one is queued already, someone else's needs owner/admin
        if (previous && previous.author !== me && (await allowed(space, previous.author))) {
          const t = await target(space, previous.id);
          if (t) await records.dropList(space, [t]);
        }
        await flush(space.id);
        return;
      }
      const id = typeof recordOrPath === 'string' ? recordOrPath : recordOrPath.id;
      const t = await target(space, id);
      if (!t) throw new Error(`compaction: record ${id} not found`);
      if (!(await allowed(space, t.author))) throw new Error('compaction: you may only delete your own records (or be an admin)');
      await records.dropList(space, [t]);
    }

    /**
     * @param {import('./space.js').Space|string} spaceRef
     * @param {{all?: boolean}} [options]
     * @returns {Promise<{dropped: number, expired: number}>}
     */
    async function compact(spaceRef, { all = false } = {}) {
      const space = records.spaceOf(spaceRef);
      const me = await records.authorOf(space);
      const targets = [];
      for (const key of await storage.keys(`loc/${space.id}/`)) {
        const loc = await storage.get(key);
        if (!loc?.head || loc.idx) continue; // log entries and current versions stay
        const id = key.slice(key.lastIndexOf('/') + 1);
        if ((await storage.get(loc.head))?.id === id) continue; // the current version (or tombstone)
        const t = await target(space, id);
        if (!t || !(t.author === me || (all && (await allowed(space, t.author))))) continue;
        if (await compactable(space, t)) targets.push(t);
      }
      if (targets.length) await records.dropList(space, targets);
      const expired = await env.expire(space.id, clock.now());
      await bus.notify('qu.compact.done', { space: space.id, dropped: targets.length, expired });
      return { dropped: targets.length, expired };
    }

    /** Drops the queued own superseded versions of a space now. */
    async function flush(sid) {
      clearTimeout(timers.get(sid));
      timers.delete(sid);
      const ids = queued.get(sid);
      queued.delete(sid);
      const space = joined(sid);
      if (!ids?.size || !space) return 0;
      const targets = [];
      for (const id of ids) {
        const t = await target(space, id);
        if (t && (await compactable(space, t))) targets.push(t);
      }
      if (targets.length) await records.dropList(space, targets);
      return targets.length;
    }

    if (auto) {
      bus.on('qu.record.superseded', async ({ space: sid, id, author }) => {
        const space = joined(sid);
        if (!space || author !== (await records.authorOf(space))) return;
        if (!queued.has(sid)) queued.set(sid, new Set());
        queued.get(sid).add(id);
        if (!timers.has(sid)) {
          const timer = setTimeout(() => flush(sid).catch((error) => bus.error?.(error)), delayMs);
          timer.unref?.();
          timers.set(sid, timer);
        }
      });
    }

    async function expireAll() {
      let expired = 0;
      for (const sid of qu.keyring.sids()) expired += await env.expire(sid, clock.now());
      return expired;
    }
    if (expireEveryMs > 0) {
      const timer = setInterval(() => expireAll().catch(() => {}), expireEveryMs);
      timer.unref?.();
    }

    const api = { del, compact, flush, expireAll };
    Object.assign(qu, { del, compact });
    qu.compaction = api;
    return api;
  };
}
