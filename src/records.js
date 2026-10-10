/**
 * RECORDS - the data plugin. Two kinds of record live under a Space:
 *
 *   - log entries (no `key`): append-only, e.g. chat messages;
 *   - keyed entries (`key` set): last-write-wins by (hlc, author). Older
 *     versions leave the query index but their sealed envelope is KEPT, so
 *     every peer and a key-less mirror hold the same set of envelopes and
 *     reconciliation converges (pruning them is a later compaction step).
 *
 * Both flows are bus PROCESSES, so any plugin can hook in:
 *
 *   write:   run('qu.write.before', draft)   transform, or throw to veto
 *            -> seal -> store -> emit('qu.write.stored', {sid, id})
 *            -> notify('qu.record.<sid>')    listeners
 *            -> route + emit('net.out.<peer>.rec')
 *
 *   receive: 'net.in.<peer>.rec' -> dedupe by id -> open (outer sig,
 *            decrypt, author sig) -> clock drift check
 *            -> emit('qu.accept', record)   ctx.stop() rejects
 *            -> store -> notify('qu.record.<sid>')
 *            -> route + forward to other peers (live records only; records
 *               fetched by a resync carry `sync: true` and are not forwarded)
 *            every outcome ends in notify('qu.record.processed', {id, status})
 *
 *   route:   run('qu.route', {sid, shard, peers, except}) - a plugin (sync)
 *            may narrow `peers`; without one, every connected peer gets it.
 *
 *   grants:  on join and on every `net.peer.up`, each joined space's write
 *            public keys go out as `net.out.<peer>.grant` - what a mirror
 *            needs to verify (never read) the space's records.
 *
 * Storage layout (all through the mount router, so each prefix - or each
 * space, e.g. `rec/<sid>/` - can be mounted on its own driver):
 *
 *   rec/<sid>/<id>                         sealed envelope bytes (what syncs)
 *   sx/<sid>/<shard>/<ts>-<id>             sync index: public header only
 *   idx/<sid>/<path>/<hlc>-<id>            opened record (local queries)
 *   head/<sid>/<path>/<key>                {hlc, author, id} of a keyed entry
 *   loc/<sid>/<id>                         {sx, idx|null, head?} - where it's indexed
 *                                          (idx null: a superseded keyed version)
 *
 * `<path>`/`<key>` are URI-encoded so `/` inside them can't collide; `<ts>`
 * is the envelope's minute-rounded time, zero-padded to 13 digits.
 */
import { sealEnvelope, openEnvelope, peekEnvelope, envelopeId } from './envelope.js';
import { formatHlc } from './hlc.js';

const seg = (s) => encodeURIComponent(s);
const pad = (ms) => String(ms).padStart(13, '0');

/** Sync-index key for a record - derivable from the public header alone (a mirror can build it too). */
export const sxKey = (header, id) => `sx/${header.sid}/${header.shard}/${pad(header.ts)}-${id}`;

/** (hlc, author) order - the LWW tiebreak. @returns {number} */
function compareVersion(a, b) {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return 0;
}

export function records() {
  return (qu) => {
    const { bus, storage, clock, identity } = qu;
    /** @type {Map<string, import('./space.js').Space>} */
    const spaces = new Map();
    const peers = new Set();
    const inFlight = new Set();

    bus.on('net.peer.up', async ({ peer }) => {
      peers.add(peer);
      for (const space of spaces.values()) await announce(space, [peer]);
    });
    bus.on('net.peer.down', ({ peer }) => peers.delete(peer));
    bus.on('net.in.*.rec', ({ bytes, sync }, ctx) => receive(bytes, { from: ctx.topic.split('.')[2], sync }));

    const spaceOf = (space) => {
      const found = spaces.get(typeof space === 'string' ? space : space.id);
      if (!found) throw new Error(`records: space ${typeof space === 'string' ? space : space.id} not joined`);
      return found;
    };

    async function route(bytes, except) {
      const header = peekEnvelope(bytes);
      const { peers: targets } = await bus.run('qu.route', { sid: header.sid, shard: header.shard, peers: [...peers], except });
      for (const peer of targets) if (peer !== except) await bus.emit(`net.out.${peer}.rec`, { bytes });
    }

    /** Removes a record and every index entry pointing at it. */
    async function drop(sid, id) {
      const loc = await storage.get(`loc/${sid}/${id}`);
      if (loc) {
        await storage.remove(loc.sx);
        if (loc.idx) await storage.remove(loc.idx);
        if (loc.head) {
          const head = await storage.get(loc.head);
          if (head?.id === id) await storage.remove(loc.head);
        }
      }
      await storage.remove(`loc/${sid}/${id}`);
      await storage.remove(`rec/${sid}/${id}`);
    }

    /** Takes a former head out of the query index; its envelope stays for sync. */
    async function demote(sid, id) {
      const loc = await storage.get(`loc/${sid}/${id}`);
      if (!loc?.idx) return;
      await storage.remove(loc.idx);
      await storage.set(`loc/${sid}/${id}`, { ...loc, idx: null });
    }

    /**
     * Stores the envelope and indexes it. A keyed record that is older than
     * the current head is stored as a superseded version (no query index).
     * @returns {Promise<boolean>} true if it is (now) the current value.
     */
    async function apply(space, record, bytes) {
      const loc = { sx: sxKey(peekEnvelope(bytes), record.id), idx: null };
      let current = true;
      if (record.key !== null && record.key !== undefined) {
        loc.head = `head/${space.id}/${seg(record.path)}/${seg(record.key)}`;
        const head = await storage.get(loc.head);
        if (head && compareVersion(head, record) >= 0) current = false;
        else {
          if (head) await demote(space.id, head.id);
          await storage.set(loc.head, { hlc: record.hlc, author: record.author, id: record.id });
        }
      }
      if (current) {
        loc.idx = `idx/${space.id}/${seg(record.path)}/${record.hlc}-${record.id}`;
        await storage.set(loc.idx, record);
      }
      await storage.set(`rec/${space.id}/${record.id}`, bytes);
      await storage.set(loc.sx, 1);
      await storage.set(`loc/${space.id}/${record.id}`, loc);
      return current;
    }

    async function receive(bytes, { from, sync = false } = {}) {
      const done = (status, extra = {}) => bus.notify('qu.record.processed', { from, status, ...extra });
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch (error) {
        await bus.notify('qu.record.rejected', { from, reason: error.message });
        return done('rejected');
      }
      const space = spaces.get(header.sid);
      if (!space) {
        await bus.notify('qu.record.unknown-space', { from, sid: header.sid });
        return done('unknown-space', { sid: header.sid, id: await envelopeId(bytes) });
      }

      let record;
      try {
        record = await openEnvelope(space, bytes);
      } catch (error) {
        await bus.notify('qu.record.rejected', { from, space: space.id, reason: error.message });
        return done('rejected', { sid: space.id, id: await envelopeId(bytes) });
      }
      const result = (status, extra) => done(status, { sid: space.id, id: record.id, ...extra });
      if (inFlight.has(record.id) || (await storage.has(`rec/${space.id}/${record.id}`))) {
        await bus.notify('qu.record.duplicate', { from, space: space.id, id: record.id });
        return result('duplicate');
      }
      inFlight.add(record.id);
      try {
        if (!clock.recv(record.hlc)) {
          await bus.notify('qu.record.rejected', { from, space: space.id, id: record.id, reason: 'clock drift' });
          return result('rejected');
        }
        const ctx = await bus.emit('qu.accept', record, { space, from });
        if (ctx.stopped) {
          await bus.notify('qu.record.rejected', { from, space: space.id, id: record.id, reason: 'hook' });
          return result('rejected');
        }
        const current = await apply(space, record, bytes);
        if (current) await bus.notify(`qu.record.${space.id}`, { ...record, space: space.id, local: false });
        else await bus.notify('qu.record.superseded', { from, space: space.id, id: record.id });
        if (!sync) await route(bytes, from);
        return result(current ? 'stored' : 'superseded');
      } finally {
        inFlight.delete(record.id);
      }
    }

    /**
     * Sends the space's write-key grants (public keys only) to `targets` -
     * call again after `space.rotate()`/`acceptEpoch()` so mirrors follow.
     * @param {import('./space.js').Space|string} spaceRef
     * @param {string[]} [targets] - default: every connected peer.
     */
    async function announce(spaceRef, targets = [...peers]) {
      const space = spaceOf(spaceRef);
      const grants = await space.grants();
      for (const peer of targets) await bus.emit(`net.out.${peer}.grant`, { sid: space.id, grants });
    }

    /** @param {import('./space.js').Space} space */
    function join(space) {
      spaces.set(space.id, space);
      bus.notify('qu.space.joined', { space: space.id });
      if (peers.size > 0) announce(space);
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
     * @param {{key?: string}} [options] - Set `key` for a last-write-wins entry.
     * @returns {Promise<object>} The stored record.
     */
    async function write(spaceRef, path, value, { key = null } = {}) {
      const space = spaceOf(spaceRef);
      const draft = await bus.run('qu.write.before', { space: space.id, path, key, value });
      const hlc = clock.tick();
      const { bytes } = await sealEnvelope(space, { path: draft.path, key: draft.key, hlc, value: draft.value }, identity);
      const record = await openEnvelope(space, bytes);
      if (!(await apply(space, record, bytes))) throw new Error('records: write lost against a newer version');
      await bus.emit('qu.write.stored', { sid: space.id, id: record.id });
      await bus.notify(`qu.record.${space.id}`, { ...record, space: space.id, local: true });
      await route(bytes);
      return record;
    }

    /**
     * @param {import('./space.js').Space|string} spaceRef
     * @param {string} path
     * @param {string} key
     * @returns {Promise<*|null>} Current value of a keyed entry.
     */
    async function get(spaceRef, path, key) {
      const space = spaceOf(spaceRef);
      const head = await storage.get(`head/${space.id}/${seg(path)}/${seg(key)}`);
      if (!head) return null;
      const record = await storage.get(`idx/${space.id}/${seg(path)}/${head.hlc}-${head.id}`);
      return record ? record.value : null;
    }

    /**
     * Time-window query over one path, ordered by HLC. Runs the
     * `qu.query.before` process first - the sync plugin hooks in there to
     * reconcile the window when `ensure: true`.
     * @param {{space: import('./space.js').Space|string, path: string, from?: number, to?: number, limit?: number, reverse?: boolean, ensure?: boolean}} q
     *   `from` inclusive, `to` exclusive, both wall-clock ms.
     * @returns {Promise<object[]>}
     */
    async function query(q) {
      const space = spaceOf(q.space);
      await bus.emit('qu.query.before', { ...q, space });
      const { path, from, to, limit, reverse } = q;
      const base = `idx/${space.id}/${seg(path)}/`;
      const rows = await storage.range(base, {
        gte: from !== undefined ? base + formatHlc(from) : undefined,
        lt: to !== undefined ? base + formatHlc(to) : undefined,
        limit,
        reverse,
      });
      return rows.map((r) => r.value);
    }

    /**
     * Local integrity repair for one space: every stored envelope must hash
     * to its id and open; a broken one is dropped (a later resync fetches a
     * good copy from a peer), a good one with missing indexes is re-indexed.
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
          if ((await envelopeId(bytes)) === id) record = await openEnvelope(space, bytes);
        } catch {
          record = null;
        }
        if (!record) {
          await drop(space.id, id);
          report.dropped.push(id);
          continue;
        }
        const loc = await storage.get(`loc/${space.id}/${id}`);
        const intact = loc && (await storage.has(loc.sx)) && (loc.idx === null || (await storage.has(loc.idx)));
        if (!intact) {
          await drop(space.id, id);
          if (record.key !== null && record.key !== undefined) {
            const headKey = `head/${space.id}/${seg(record.path)}/${seg(record.key)}`;
            if ((await storage.get(headKey))?.id === id) await storage.remove(headKey);
          }
          await apply(space, record, bytes);
          report.reindexed.push(id);
        }
      }
      for (const key of await storage.keys(`loc/${space.id}/`)) {
        const id = key.slice(key.lastIndexOf('/') + 1);
        if (!(await storage.has(`rec/${space.id}/${id}`))) {
          await drop(space.id, id);
          report.dropped.push(id);
        }
      }
      await bus.notify('qu.scrub.done', { space: space.id, ...report });
      return report;
    }

    Object.assign(qu, { join, leave, write, get, query, scrub, announce });
    return { join, leave, write, get, query, scrub, announce, receive, spaceOf };
  };
}
