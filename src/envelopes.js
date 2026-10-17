/**
 * ENVELOPES - the blind envelope layer every peer runs, browser client and
 * mirror alike. It never decrypts: it checks the public header and BOTH
 * signatures against the space's write public key (from the keyring),
 * dedupes, stores the sealed bytes plus the public sync index, routes live
 * records on, and reports the outcome. Reading is a separate plugin
 * (`records()`), which hooks into `qu.envelope.stored`.
 *
 *   ingest:  net.in.<peer>.rec | local write
 *            -> emit('qu.envelope.accept', {header, from})   ctx.stop() refuses (policy)
 *            -> dedupe -> gone marker? (dropped before: 'gone', not stored)
 *            -> keyring lookup -> verifyEnvelope
 *            -> a public drop list (gc.js) adds its drops to the write set
 *            -> emit('qu.envelope.stored', {..., ws})         a reader adds its indexes
 *                                                             to the write set, may
 *                                                             ctx.stop() (nothing is
 *                                                             written) or set ctx.status
 *            -> emit('qu.write.stored', {..., ws}) for local  (sync: outbox entry)
 *            -> per-space lock: ws.locked() decisions (LWW head), then
 *               ONE atomic storage.batch: rec/ + sx/ + indexes + outbox
 *               (a failed commit leaves nothing behind: status 'failed',
 *               a later resync fetches the envelope again)
 *            -> ws.after() side effects (record notifications)
 *            -> run('qu.route') + emit('net.out.<peer>.rec')  unless fetched by a resync
 *                                                             (a hub sets `forwardSynced`)
 *            -> notify('qu.record.processed', {from, sid, id, status})
 *
 *   keyring: per sid the verified grant state (owner, admins, epoch -> write
 *            public key). Members register their own spaces (`register()`);
 *            a mirror fills it from verified grants (owner/admin-signed chain).
 *
 *   grants:  `register(space, {mirror: true})` spaces are announced - write
 *            PUBLIC keys only - to peers that said `hello {role: 'mirror'}`,
 *            never to ordinary peers. With `acceptGrants` (mirrors) offered
 *            grants are verified (space.js `verifyGrants`) into the keyring
 *            and reported as `qu.grant.accepted`; `qu.grant.offer` can veto.
 *
 *   retire:  `retire(sid, ids)` removes envelopes from THIS peer only - no drop
 *            list, nothing is sent (sync.js: a device back after the drop-list
 *            horizon must not resurrect what the network dropped meanwhile).
 *            Readers remove their indexes via `qu.envelope.retire` in the same
 *            write set; `qu.envelope.retired` reports it.
 *
 * Storage: rec/<sid>/<id> (sealed bytes), sx/<sid>/<shard>/<ts>-<id> (sync
 * index; value 1 = held, 0 = dropped - still counted by reconcile),
 * gone/<sid>/<id> {gc, author, sx} (dropped by drop list `gc`),
 * gcs/<sid>/<ts>-<gcId> (drop lists by time, for expiry).
 */
import { peekEnvelope, verifyEnvelope, envelopeId, readPublic } from './envelope.js';
import { GC_TYPE, isGcPath, decodeEntries, mayDrop, gcCutoff } from './gc.js';
import { verifyGrants, emptyGrantState } from './space.js';
import { writeSet } from './writeset.js';

const pad = (ms) => String(ms).padStart(13, '0');

/** Sync-index key for a record - derivable from the public header alone. */
export const sxKey = (header, id) => `sx/${header.sid}/${header.shard}/${pad(header.ts)}-${id}`;

/** @param {{acceptGrants?: boolean}} [options] */
export function envelopes({ acceptGrants = false } = {}) {
  return (qu) => {
    if (qu.envelopes) return qu.envelopes;
    const { bus, storage } = qu;
    const peers = new Set();
    const roles = new Map();
    /** @type {Map<string, Promise<object>>} id -> outcome of the ingest currently running for it. */
    const inFlight = new Map();
    /** @type {Map<string, Promise<void>>} sid -> tail of its commit queue. */
    const commits = new Map();
    /** @type {Map<string, import('./space.js').GrantState>} */
    const keyring = new Map();
    /** @type {Map<string, {space: import('./space.js').Space, mirror: boolean}>} */
    const registered = new Map();

    const stateOf = (sid) => keyring.get(sid) ?? emptyGrantState();
    const ring = {
      /** Trusted insert of one epoch key (own spaces, tests). */
      set(sid, epoch, writePub) {
        const state = stateOf(sid);
        state.epochs.set(epoch, writePub);
        keyring.set(sid, state);
      },
      get: (sid, epoch) => keyring.get(sid)?.epochs.get(epoch),
      epochs: (sid) => new Map(keyring.get(sid)?.epochs ?? []),
      state: (sid) => keyring.get(sid),
      setState: (sid, state) => keyring.set(sid, state),
      has: (sid) => keyring.has(sid),
      sids: () => [...keyring.keys()],
      /**
       * Verifies grants into the keyring.
       * @returns {Promise<{changed: string[], accepted: object[], isNew: boolean}>}
       */
      async accept(sid, grants) {
        const isNew = !keyring.has(sid);
        const { state, changed } = await verifyGrants(sid, grants, stateOf(sid));
        if (changed.length) keyring.set(sid, state);
        const label = (g) => (g.kind === 'admins' ? `admins:${g.seq}` : `epoch:${g.epoch}`);
        return { changed, accepted: grants.filter((g) => changed.includes(label(g))), isNew: isNew && changed.length > 0 };
      },
    };

    bus.on('net.peer.up', ({ peer }) => peers.add(peer));
    bus.on('net.peer.down', ({ peer }) => {
      peers.delete(peer);
      roles.delete(peer);
    });
    bus.on('net.in.*.hello', async ({ role }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      roles.set(peer, role);
      if (role === 'mirror') for (const [sid, entry] of registered) if (entry.mirror) await announce(sid, [peer]);
    });
    bus.on('net.in.*.rec', ({ bytes, sync }, ctx) => ingest(bytes, { from: ctx.topic.split('.')[2], sync }));
    bus.on('net.in.*.grant', async ({ sid, grants }, ctx) => {
      if (!api.acceptGrants || typeof sid !== 'string' || !Array.isArray(grants)) return;
      const from = ctx.topic.split('.')[2];
      const offer = await bus.emit('qu.grant.offer', { sid, from });
      if (offer.stopped) return;
      const { changed, accepted, isNew } = await ring.accept(sid, grants);
      if (changed.length) await bus.notify('qu.grant.accepted', { sid, from, isNew, changed, accepted });
    });

    /**
     * Removes a sealed envelope and its sync-index entry - into `ws` when
     * given (the caller commits), else right away.
     * @param {string} sid
     * @param {string} id
     * @param {ReturnType<typeof writeSet>} [ws]
     */
    async function remove(sid, id, ws) {
      const own = ws ?? writeSet(storage);
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes) own.remove(sxKey(peekEnvelope(bytes), id));
      own.remove(`rec/${sid}/${id}`);
      if (!ws) await own.commit();
    }

    /**
     * Runs `fn` exclusively per space: a reader decides from the committed
     * indexes (e.g. which version of a keyed entry is current), so two
     * envelopes of one space must not decide on the same state concurrently.
     * Kept short: only the `ws.locked()` decisions and the batch run in it.
     */
    async function exclusive(sid, fn) {
      const prev = commits.get(sid) ?? Promise.resolve();
      let release;
      const mine = new Promise((resolve) => (release = resolve));
      const tail = prev.then(() => mine);
      commits.set(sid, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (commits.get(sid) === tail) commits.delete(sid);
      }
    }

    const goneKey = (sid, id) => `gone/${sid}/${id}`;
    const stateFor = (sid) => keyring.get(sid) ?? registered.get(sid)?.space.grantState();

    /**
     * Adds the drops of a verified drop list to `ws`.
     * @returns {Promise<string[]|null>} dropped ids, or null if the list is malformed
     */
    async function applyDropList(sid, gcId, header, inner, ws) {
      const entries = isGcPath(inner.p) ? decodeEntries(inner.v) : null;
      if (!entries) return null;
      const dropped = [];
      for (const entry of entries) {
        if (entry.id === gcId || !(await mayDrop(stateFor(sid), sid, header.author, entry.author))) continue;
        if (await storage.has(goneKey(sid, entry.id))) continue;
        const held = await storage.get(`rec/${sid}/${entry.id}`);
        let sx;
        if (held) {
          const target = peekEnvelope(held);
          if (target.author !== entry.author || target.shard !== header.shard) continue;
          sx = sxKey(target, entry.id);
          ws.remove(`rec/${sid}/${entry.id}`);
        } else sx = sxKey({ sid, shard: header.shard, ts: entry.ts }, entry.id);
        ws.set(sx, 0);
        ws.set(goneKey(sid, entry.id), { gc: gcId, author: entry.author, sx });
        dropped.push(entry.id);
      }
      ws.set(`gcs/${sid}/${pad(header.ts)}-${gcId}`, 1);
      return dropped;
    }

    /**
     * What to send for a wanted id: the envelope, or - if it was dropped -
     * the drop list that dropped it (the receiver verifies that one itself).
     * @returns {Promise<{bytes: Uint8Array, id: string, gone: boolean}|null>}
     */
    async function bytesFor(sid, id) {
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes) return { bytes, id, gone: false };
      const marker = await storage.get(goneKey(sid, id));
      const gc = marker && (await storage.get(`rec/${sid}/${marker.gc}`));
      return gc ? { bytes: gc, id: marker.gc, gone: true } : null;
    }

    const isGone = (sid, id) => storage.has(goneKey(sid, id));

    /**
     * Removes envelopes from this peer only (no drop list, nothing sent), in
     * one write set together with the readers' indexes (`qu.envelope.retire`).
     * @param {string} sid
     * @param {string[]} ids
     * @returns {Promise<number>} envelopes removed
     */
    async function retire(sid, ids) {
      if (!ids.length) return 0;
      const ws = writeSet(storage);
      for (const id of ids) await remove(sid, id, ws);
      await bus.emit('qu.envelope.retire', { sid, ids, ws });
      await exclusive(sid, () => ws.flush());
      await ws.settle();
      await bus.notify('qu.envelope.retired', { sid, ids });
      return ids.length;
    }

    /**
     * Expires drop lists older than the horizon (gc.js) together with their
     * gone markers - the same set on every peer, so reconcile stays quiet.
     * @param {string} sid
     * @param {number} now - wall-clock ms
     * @returns {Promise<number>} drop lists expired (`qu.gc.expired` reports the bytes freed)
     */
    async function expire(sid, now) {
      let freed = 0;
      const base = `gcs/${sid}/`;
      const due = await storage.range(base, { lt: base + pad(gcCutoff(now)) });
      for (const { key } of due) {
        const gcId = key.slice(key.lastIndexOf('-') + 1);
        const ws = writeSet(storage);
        await exclusive(sid, async () => {
          const bytes = await storage.get(`rec/${sid}/${gcId}`);
          ws.remove(key);
          ws.remove(`defer/${sid}/${gcId}`);
          if (bytes) {
            freed += bytes.length;
            ws.remove(`rec/${sid}/${gcId}`);
            ws.remove(sxKey(peekEnvelope(bytes), gcId));
            for (const { id } of decodeEntries(readPublic(bytes)?.v) ?? []) {
              const marker = await storage.get(goneKey(sid, id));
              if (marker?.gc !== gcId) continue;
              ws.remove(goneKey(sid, id));
              ws.remove(marker.sx);
            }
          }
          await ws.flush();
        });
      }
      if (due.length) await bus.notify('qu.gc.expired', { sid, count: due.length, bytes: freed });
      return due.length;
    }

    /**
     * The one way an envelope enters this peer - from the network or from a
     * local write.
     * @param {Uint8Array} bytes
     * @param {{from?: string, sync?: boolean, local?: boolean}} [options]
     * @returns {Promise<{id?: string, sid?: string, status: string, reason?: string}>}
     */
    async function ingest(bytes, { from, sync = false, local = false } = {}) {
      const finish = async (outcome) => {
        await bus.notify('qu.record.processed', { from, ...outcome });
        return outcome;
      };
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch (error) {
        await bus.notify('qu.record.rejected', { from, reason: error.message });
        return finish({ status: 'rejected', reason: error.message });
      }
      const { sid } = header;
      // scoped links (one connection per space): a space arriving on the wrong link is ignored, never acked
      if (from && qu.net && !qu.net.allows(from, sid)) return finish({ sid, status: 'rejected', reason: 'not on this link' });
      const id = await envelopeId(bytes);
      // One ingest per id at a time: a second copy (live push + resync reply)
      // waits for the first, so "processed" always means "settled".
      while (inFlight.has(id)) await inFlight.get(id);
      let settle;
      inFlight.set(id, new Promise((resolve) => (settle = resolve)));
      try {
        const policy = await bus.emit('qu.envelope.accept', { header, id, bytes, from, local });
        if (policy.stopped) {
          const reason = policy.reason ?? 'policy';
          // tell the sender, so its outbox keeps the record and the app can show why
          if (from && peers.has(from)) await bus.emit(`net.out.${from}.nack`, { sid, id, reason });
          return finish({ sid, id, status: 'rejected', reason });
        }
        if (await storage.has(`rec/${sid}/${id}`)) {
          await bus.notify('qu.record.duplicate', { from, space: sid, id });
          return finish({ sid, id, status: 'duplicate' });
        }
        // Dropped before (a stale peer pushing an old version): not taken back.
        // A marker whose author claim does not match is ignored - and replaced.
        const marker = await storage.get(goneKey(sid, id));
        if (marker?.author === header.author) return finish({ sid, id, status: 'gone' });
        // A member's own space may have rotated since it registered: refresh from the Space itself.
        const writePub = ring.get(sid, header.epoch) ?? registered.get(sid)?.space.writeKeys().get(header.epoch);
        if (writePub && !ring.get(sid, header.epoch)) ring.set(sid, header.epoch, writePub);
        if (!writePub) {
          await bus.notify('qu.record.unknown-space', { from, sid, epoch: header.epoch });
          return finish({ sid, id, status: 'unknown-space' });
        }
        if (!local && !(await verifyEnvelope(bytes, writePub))) {
          await bus.notify('qu.record.rejected', { from, space: sid, id, reason: 'signature invalid' });
          return finish({ sid, id, status: 'rejected', reason: 'signature invalid' });
        }
        const ws = writeSet(storage);
        ws.set(`rec/${sid}/${id}`, bytes);
        if (marker) {
          ws.remove(marker.sx);
          ws.remove(goneKey(sid, id));
        }
        ws.set(sxKey(header, id), 1);
        // A drop list for this id may commit while this envelope is in flight.
        ws.locked(async () => {
          if ((await storage.get(goneKey(sid, id)))?.author === header.author) throw Object.assign(new Error('dropped meanwhile'), { gone: true });
        });

        const inner = header.visibility === 'public' ? readPublic(bytes) : null;
        let dropped = [];
        if (inner?.t === GC_TYPE) {
          dropped = await applyDropList(sid, id, header, inner, ws);
          if (!dropped) {
            await bus.notify('qu.record.rejected', { from, space: sid, id, reason: 'malformed drop list' });
            return finish({ sid, id, status: 'rejected', reason: 'malformed drop list' });
          }
        }
        ws.dropped = dropped;

        const stored = await bus.emit('qu.envelope.stored', { sid, id, header, bytes, from, sync, local, ws });
        if (stored.stopped) {
          const reason = stored.reason ?? 'refused';
          await bus.notify('qu.record.rejected', { from, space: sid, id, reason });
          return finish({ sid, id, status: 'rejected', reason });
        }
        if (local) await bus.emit('qu.write.stored', { sid, id, header, ws });
        try {
          await exclusive(sid, () => ws.flush());
        } catch (error) {
          if (error.gone) return finish({ sid, id, status: 'gone' });
          await bus.notify('qu.record.failed', { from, space: sid, id, reason: error.message });
          return finish({ sid, id, status: 'failed', reason: error.message });
        }
        await ws.settle();
        if (dropped.length) {
          await bus.notify('qu.envelope.dropped', { sid, ids: dropped, by: header.author, gc: id });
          // settles anyone waiting for these ids (a resync that wanted them)
          for (const target of dropped) await bus.notify('qu.record.processed', { sid, id: target, status: 'gone' });
        }
        // Records fetched by a resync are normally not forwarded (the other peers
        // reconcile themselves). A hub (mirror) forwards them anyway: for its
        // subscribers it is the only path, and the record is new to it.
        if (!sync || api.forwardSynced) {
          const { peers: targets } = await bus.run('qu.route', { sid, shard: header.shard, peers: [...peers], except: from });
          for (const peer of targets) if (peer !== from) await bus.emit(`net.out.${peer}.rec`, { bytes });
        }
        return finish({ sid, id, status: ws.status ?? stored.status ?? 'stored' });
      } finally {
        inFlight.delete(id);
        settle();
      }
    }

    /**
     * Sends a registered space's grants to `targets` (default: every
     * connected mirror). Call again after `space.rotate()`/`acceptEpoch()`.
     * @param {string} sid
     * @param {string[]} [targets]
     */
    async function announce(sid, targets) {
      const entry = registered.get(sid);
      if (!entry) return;
      const grants = await entry.space.grants();
      keyring.set(sid, entry.space.grantState());
      const to = (targets ?? [...peers].filter((p) => roles.get(p) === 'mirror')).filter((p) => !qu.net || qu.net.allows(p, sid));
      for (const peer of to) await bus.emit(`net.out.${peer}.grant`, { sid, grants });
    }

    /**
     * Makes a space's write keys known to this peer's keyring and (if
     * `mirror`) announces them to connected mirrors.
     * @param {import('./space.js').Space} space
     * @param {{mirror?: boolean}} [options]
     */
    async function register(space, { mirror = true } = {}) {
      registered.set(space.id, { space, mirror });
      keyring.set(space.id, space.grantState());
      await announce(space.id, mirror ? undefined : []);
    }

    const api = { ingest, remove, retire, exclusive, bytesFor, isGone, expire, register, announce, keyring: ring, acceptGrants, forwardSynced: false, roles };
    qu.envelopes = api;
    qu.keyring = ring;
    return api;
  };
}
