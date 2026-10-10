/**
 * RECORDS - the data plugin. Two kinds of record live under a Space:
 *
 *   - log entries (no `key`): append-only, e.g. chat messages;
 *   - keyed entries (`key` set): last-write-wins by (hlc, author), older
 *     versions are dropped locally.
 *
 * Both flows are bus PROCESSES, so any plugin can hook in:
 *
 *   write:   run('qu.write.before', draft)   transform, or throw to veto
 *            -> seal -> store
 *            -> notify('qu.record.<sid>')    listeners
 *            -> emit('net.out.<peer>.rec')   every connected peer
 *
 *   receive: 'net.in.<peer>.rec' -> dedupe by id -> open (outer sig,
 *            decrypt, author sig) -> clock drift check
 *            -> emit('qu.accept', record)   ctx.stop() rejects
 *            -> store -> notify('qu.record.<sid>') -> forward to other peers
 *
 * Storage layout (all through the mount router, so each prefix - or each
 * space, e.g. `rec/<sid>` - can be mounted on its own driver):
 *
 *   rec/<sid>/<id>                         sealed envelope bytes (what syncs)
 *   idx/<sid>/<path>/<hlc>-<id>            opened record (local queries)
 *   head/<sid>/<path>/<key>                {hlc, author, id} of a keyed entry
 *
 * `<path>`/`<key>` are URI-encoded so `/` inside them can't collide.
 */
import { sealEnvelope, openEnvelope, peekEnvelope } from './envelope.js';
import { formatHlc } from './hlc.js';

const seg = (s) => encodeURIComponent(s);

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

    bus.on('net.peer.up', ({ peer }) => peers.add(peer));
    bus.on('net.peer.down', ({ peer }) => peers.delete(peer));
    bus.on('net.in.*.rec', ({ bytes }, ctx) => receive(bytes, ctx.topic.split('.')[2]));

    const spaceOf = (space) => {
      const found = spaces.get(typeof space === 'string' ? space : space.id);
      if (!found) throw new Error(`records: space ${typeof space === 'string' ? space : space.id} not joined`);
      return found;
    };

    async function broadcast(bytes, except) {
      for (const peer of peers) if (peer !== except) await bus.emit(`net.out.${peer}.rec`, { bytes });
    }

    /** @returns {Promise<boolean>} false if an equal-or-newer keyed version already exists. */
    async function apply(space, record, bytes) {
      const base = `idx/${space.id}/${seg(record.path)}/`;
      if (record.key !== null && record.key !== undefined) {
        const headKey = `head/${space.id}/${seg(record.path)}/${seg(record.key)}`;
        const head = await storage.get(headKey);
        if (head && compareVersion(head, record) >= 0) return false;
        if (head) {
          await storage.remove(`${base}${head.hlc}-${head.id}`);
          await storage.remove(`rec/${space.id}/${head.id}`);
        }
        await storage.set(headKey, { hlc: record.hlc, author: record.author, id: record.id });
      }
      await storage.set(`rec/${space.id}/${record.id}`, bytes);
      await storage.set(`${base}${record.hlc}-${record.id}`, record);
      return true;
    }

    async function receive(bytes, from) {
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch (error) {
        return bus.notify('qu.record.rejected', { from, reason: error.message });
      }
      const space = spaces.get(header.sid);
      if (!space) return bus.notify('qu.record.unknown-space', { from, sid: header.sid });

      let record;
      try {
        record = await openEnvelope(space, bytes);
      } catch (error) {
        return bus.notify('qu.record.rejected', { from, space: space.id, reason: error.message });
      }
      if (inFlight.has(record.id) || (await storage.has(`rec/${space.id}/${record.id}`))) {
        return bus.notify('qu.record.duplicate', { from, space: space.id, id: record.id });
      }
      inFlight.add(record.id);
      try {
        if (!clock.recv(record.hlc)) {
          return bus.notify('qu.record.rejected', { from, space: space.id, id: record.id, reason: 'clock drift' });
        }
        const ctx = await bus.emit('qu.accept', record, { space, from });
        if (ctx.stopped) return bus.notify('qu.record.rejected', { from, space: space.id, id: record.id, reason: 'hook' });

        if (!(await apply(space, record, bytes))) return bus.notify('qu.record.superseded', { from, space: space.id, id: record.id });
        await bus.notify(`qu.record.${space.id}`, { ...record, space: space.id, local: false });
        await broadcast(bytes, from);
      } finally {
        inFlight.delete(record.id);
      }
    }

    /** @param {import('./space.js').Space} space */
    function join(space) {
      spaces.set(space.id, space);
      bus.notify('qu.space.joined', { space: space.id });
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
      const { bytes, id } = await sealEnvelope(space, { path: draft.path, key: draft.key, hlc, value: draft.value }, identity);
      const record = await openEnvelope(space, bytes);
      if (!(await apply(space, record, bytes))) throw new Error('records: write lost against a newer version');
      await bus.notify(`qu.record.${space.id}`, { ...record, space: space.id, local: true });
      await broadcast(bytes);
      return { ...record, id };
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
     * Time-window query over one path, ordered by HLC.
     * @param {{space: import('./space.js').Space|string, path: string, from?: number, to?: number, limit?: number, reverse?: boolean}} q
     *   `from` inclusive, `to` exclusive, both wall-clock ms.
     * @returns {Promise<object[]>}
     */
    async function query({ space: spaceRef, path, from, to, limit, reverse }) {
      const space = spaceOf(spaceRef);
      const base = `idx/${space.id}/${seg(path)}/`;
      const rows = await storage.range(base, {
        gte: from !== undefined ? base + formatHlc(from) : undefined,
        lt: to !== undefined ? base + formatHlc(to) : undefined,
        limit,
        reverse,
      });
      return rows.map((r) => r.value);
    }

    Object.assign(qu, { join, leave, write, get, query });
    return { join, leave, write, get, query, receive };
  };
}
