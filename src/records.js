/**
 * RECORDS - the reader/writer plugin of a space MEMBER, on top of the blind
 * envelope layer (envelopes.js, installed automatically). Envelopes stay
 * sealed in storage; this plugin only keeps POINTER indexes and decrypts on
 * read (with a small in-memory cache), so nothing readable is ever stored
 * and every stored record stays verifiable by anyone.
 *
 * Two kinds of record live under a Space:
 *   - log entries (no `key`): append-only, e.g. chat messages;
 *   - keyed entries (`key` set): last-write-wins by (hlc, author). Older
 *     versions leave the index but their envelope is KEPT, so every peer
 *     and a key-less mirror hold the same set (pruning: later compaction).
 *
 * Both flows are bus processes:
 *
 *   write:   run('qu.write.before', draft)   transform, or throw to veto
 *            -> seal (author = per-space alias by default) -> envelopes.ingest(local)
 *   read:    'qu.envelope.stored' -> open -> clock drift check
 *            -> emit('qu.accept', record)   ctx.stop() rejects (envelope removed)
 *            -> pointer indexes -> notify('qu.record.<sid>')
 *
 * Storage (besides rec/ and sx/ owned by envelopes.js) - pointers only,
 * paths and keys as opaque per-space tags (space.tag):
 *
 *   idx/<sid>/<pathTag>/<hlc>-<id>     {id, hlc, author}
 *   head/<sid>/<pathTag>/<keyTag>      {id, hlc, author} of a keyed entry
 *   loc/<sid>/<id>                     {idx|null, head?} (idx null: superseded version)
 */
import { sealEnvelope, openEnvelope, envelopeId, verifyEnvelope, peekEnvelope } from './envelope.js';
import { envelopes as envelopeLayer, sxKey } from './envelopes.js';
import { formatHlc } from './hlc.js';

/** (hlc, author) order - the LWW tiebreak. @returns {number} */
function compareVersion(a, b) {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return 0;
}

/**
 * @param {{author?: 'alias'|'identity', cacheSize?: number}} [options]
 *   `author`: default signing key for group spaces (user nodes always sign
 *   with the identity). Overridable per space in `join()`.
 */
export function records({ author: defaultAuthor = 'alias', cacheSize = 1000 } = {}) {
  return (qu) => {
    const { bus, storage, clock, identity } = qu;
    const env = envelopeLayer()(qu);
    /** @type {Map<string, {space: import('./space.js').Space, author: string}>} */
    const spaces = new Map();
    /** @type {Map<string, object>} id -> opened record (LRU by insertion order). */
    const cache = new Map();

    const remember = (record) => {
      cache.delete(record.id);
      cache.set(record.id, record);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
      return record;
    };

    const spaceOf = (ref) => {
      const id = typeof ref === 'string' ? ref : ref.id;
      const entry = spaces.get(id);
      if (!entry) throw new Error(`records: space ${id} not joined`);
      return entry.space;
    };

    async function tags(space, record) {
      const pathTag = await space.tag(record.path);
      const keyTag = record.key !== null && record.key !== undefined ? await space.tag(`${record.path}\u0000${record.key}`) : null;
      return { pathTag, keyTag };
    }

    /** Opens a stored envelope (no re-verification: stored means verified). */
    async function read(space, id) {
      if (cache.has(id)) return cache.get(id);
      const bytes = await storage.get(`rec/${space.id}/${id}`);
      if (!bytes) return null;
      return remember(await openEnvelope(space, bytes, { verify: false }));
    }

    async function demote(sid, id) {
      const loc = await storage.get(`loc/${sid}/${id}`);
      if (!loc?.idx) return;
      await storage.remove(loc.idx);
      await storage.set(`loc/${sid}/${id}`, { ...loc, idx: null });
    }

    /** Removes a record's indexes and its envelope. */
    async function drop(sid, id) {
      const loc = await storage.get(`loc/${sid}/${id}`);
      if (loc?.idx) await storage.remove(loc.idx);
      if (loc?.head && (await storage.get(loc.head))?.id === id) await storage.remove(loc.head);
      await storage.remove(`loc/${sid}/${id}`);
      cache.delete(id);
      await env.remove(sid, id);
    }

    /** @returns {Promise<boolean>} true if the record is (now) the current value. */
    async function index(space, record) {
      const { pathTag, keyTag } = await tags(space, record);
      const pointer = { id: record.id, hlc: record.hlc, author: record.author };
      const loc = { idx: null };
      let current = true;
      if (keyTag) {
        loc.head = `head/${space.id}/${pathTag}/${keyTag}`;
        const head = await storage.get(loc.head);
        if (head && compareVersion(head, record) >= 0) current = false;
        else {
          if (head) await demote(space.id, head.id);
          await storage.set(loc.head, pointer);
        }
      }
      if (current) {
        loc.idx = `idx/${space.id}/${pathTag}/${record.hlc}-${record.id}`;
        await storage.set(loc.idx, pointer);
      }
      await storage.set(`loc/${space.id}/${record.id}`, loc);
      return current;
    }

    bus.on('qu.envelope.stored', async ({ sid, id, bytes, from, local }, ctx) => {
      const entry = spaces.get(sid);
      if (!entry) return; // not a member: kept blind (verified, unreadable)
      let record;
      try {
        record = await openEnvelope(entry.space, bytes, { verify: false });
      } catch (error) {
        if (/no key to read/.test(error.message)) return; // e.g. a private field of someone else's user node
        ctx.reason = error.message;
        return ctx.stop();
      }
      if (!local) {
        if (!clock.recv(record.hlc)) {
          ctx.reason = 'clock drift';
          return ctx.stop();
        }
        const accepted = await bus.emit('qu.accept', record, { space: entry.space, from });
        if (accepted.stopped) {
          ctx.reason = 'hook';
          return ctx.stop();
        }
      }
      const current = await index(entry.space, record);
      remember(record);
      ctx.status = current ? 'stored' : 'superseded';
      if (current) await bus.notify(`qu.record.${sid}`, { ...record, space: sid, local: Boolean(local) });
      else await bus.notify('qu.record.superseded', { from, space: sid, id });
    });

    /**
     * @param {import('./space.js').Space} space
     * @param {{author?: 'alias'|'identity', mirror?: boolean}} [options]
     *   `mirror` (default true): announce this space's write keys to mirrors.
     */
    function join(space, { author = defaultAuthor, mirror = true } = {}) {
      spaces.set(space.id, { space, author });
      bus.notify('qu.space.joined', { space: space.id });
      env.register(space, { mirror });
      return space;
    }

    /** @param {import('./space.js').Space|string} space */
    function leave(space) {
      const id = typeof space === 'string' ? space : space.id;
      spaces.delete(id);
      bus.notify('qu.space.left', { space: id });
    }

    /**
     * @param {import('./space.js').Space|string} spaceRef
     * @param {string} path
     * @param {*} value - Anything JSON-serialisable.
     * @param {{key?: string, visibility?: 'private'|'public'}} [options]
     *   `key`: last-write-wins entry. `visibility: 'public'`: signed but not
     *   encrypted (e.g. public fields of a user node).
     * @returns {Promise<object>} The stored record.
     */
    async function write(spaceRef, path, value, { key = null, visibility = 'private' } = {}) {
      const space = spaceOf(spaceRef);
      const draft = await bus.run('qu.write.before', { space: space.id, path, key, value, visibility });
      const signer = await space.authorFor(identity, spaces.get(space.id).author);
      const { bytes, id } = await sealEnvelope(space, { path: draft.path, key: draft.key, hlc: clock.tick(), value: draft.value, visibility: draft.visibility }, signer);
      const outcome = await env.ingest(bytes, { local: true });
      if (outcome.status !== 'stored') throw new Error(`records: write not stored (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ''})`);
      return read(space, id);
    }

    /**
     * @param {import('./space.js').Space|string} spaceRef
     * @param {string} path
     * @param {string} key
     * @returns {Promise<*|null>} Current value of a keyed entry.
     */
    async function get(spaceRef, path, key) {
      const space = spaceOf(spaceRef);
      const head = await storage.get(`head/${space.id}/${await space.tag(path)}/${await space.tag(`${path}\u0000${key}`)}`);
      if (!head) return null;
      return (await read(space, head.id))?.value ?? null;
    }

    /**
     * Time-window query over one path, ordered by HLC; decrypts on read.
     * Runs the `qu.query.before` process first - the sync plugin hooks in
     * there to reconcile the window when `ensure: true`.
     * @param {{space: import('./space.js').Space|string, path: string, from?: number, to?: number, limit?: number, reverse?: boolean, ensure?: boolean}} q
     *   `from` inclusive, `to` exclusive, both wall-clock ms.
     * @returns {Promise<object[]>}
     */
    async function query(q) {
      const space = spaceOf(q.space);
      await bus.emit('qu.query.before', { ...q, space });
      const { path, from, to, limit, reverse } = q;
      const base = `idx/${space.id}/${await space.tag(path)}/`;
      const rows = await storage.range(base, {
        gte: from !== undefined ? base + formatHlc(from) : undefined,
        lt: to !== undefined ? base + formatHlc(to) : undefined,
        limit,
        reverse,
      });
      const out = [];
      for (const { value: pointer } of rows) {
        const record = await read(space, pointer.id);
        if (record) out.push(record);
      }
      return out;
    }

    /**
     * Integrity repair for one space. Every stored envelope must hash to its
     * id and carry valid signatures (checked WITHOUT decrypting); a broken
     * one is dropped - a later resync fetches a good copy - and a good one
     * with lost indexes is re-indexed.
     * @param {import('./space.js').Space|string} spaceRef
     * @returns {Promise<{checked: number, dropped: string[], reindexed: string[]}>}
     */
    async function scrub(spaceRef) {
      const space = spaceOf(spaceRef);
      const report = { checked: 0, dropped: [], reindexed: [] };
      for (const key of await storage.keys(`rec/${space.id}/`)) {
        const id = key.slice(key.lastIndexOf('/') + 1);
        const bytes = await storage.get(key);
        report.checked++;
        let record = null;
        try {
          const header = peekEnvelope(bytes);
          const writePub = qu.keyring.get(space.id, header.epoch);
          if ((await envelopeId(bytes)) === id && writePub && (await verifyEnvelope(bytes, writePub))) record = await openEnvelope(space, bytes, { verify: false });
        } catch {
          record = null;
        }
        cache.delete(id);
        if (!record) {
          await storage.remove(key); // can't trust its header to find the sx entry
          await drop(space.id, id);
          report.dropped.push(id);
          continue;
        }
        const loc = await storage.get(`loc/${space.id}/${id}`);
        const intact = loc && (await storage.has(sxKey(peekEnvelope(bytes), id))) && (loc.idx === null || (await storage.has(loc.idx)));
        if (!intact) {
          if (loc?.idx) await storage.remove(loc.idx);
          if (loc?.head && (await storage.get(loc.head))?.id === id) await storage.remove(loc.head);
          await storage.set(sxKey(peekEnvelope(bytes), id), 1);
          await index(space, record);
          report.reindexed.push(id);
        }
      }
      // Orphaned sync-index entries (envelope gone) would make reconcile claim records we don't have.
      for (const key of await storage.keys(`sx/${space.id}/`)) {
        const id = key.slice(key.lastIndexOf('-') + 1);
        if (!(await storage.has(`rec/${space.id}/${id}`))) {
          await storage.remove(key);
          await drop(space.id, id);
          if (!report.dropped.includes(id)) report.dropped.push(id);
        }
      }
      await bus.notify('qu.scrub.done', { space: space.id, ...report });
      return report;
    }

    /** Re-announces a space's write keys (after `rotate()`/`acceptEpoch()`). */
    const announce = (spaceRef) => env.announce(spaceOf(spaceRef).id);

    Object.assign(qu, { join, leave, write, get, query, scrub, announce });
    return { join, leave, write, get, query, scrub, announce, spaceOf };
  };
}
