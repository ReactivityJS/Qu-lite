/**
 * SYNC - the reconciliation plugin, built on `records()`'s sync index
 * (`sx/<sid>/<shard>/<ts>-<id>`, public header only) and on vendored
 * Negentropy (range-based set reconciliation). Cost is proportional to the
 * DIFFERENCE between two peers, never to history: when both sides already
 * match, a reconcile is one small round trip.
 *
 * Messages (all `net.out.<peer>.<type>` / `net.in.<peer>.<type>` bus events):
 *
 *   sub / unsub   {sid, shard?}                   live interest (routing)
 *   neg           {session, sid, shard?, from?, to?, msg}   initiator -> responder
 *   negr          {session, msg}                  responder -> initiator
 *   negend        {session}                       initiator closes the session
 *   want          {session, sid, ids}             ids: concatenated 32-byte ids
 *   wantmiss      {session, ids}                  responder no longer has them
 *   rec           {bytes, sync: true}             handled by records()
 *
 * Interest is demand-driven: `watch()` (what an app mounts) subscribes and
 * reconciles exactly that scope - a space, optionally narrowed to a path's
 * shard and a time window - with every connected peer, and again whenever a
 * peer connects. Live records are only routed to peers that subscribed to
 * their (sid, shard); a peer that never sent `sub` gets everything.
 *
 *   hello         {role}                          'peer' | 'mirror'
 *   ack           {sid, ids}                      receiver stored these records
 *
 * A mirror is just a peer that watches whole spaces.
 *
 * DURABILITY - pending work survives a reload or a dropped connection,
 * because it lives in storage, not in memory:
 *
 *   sync/out/<sid>/<id>            OUTBOX: every local write, until a peer
 *                                  (or, with `ackFrom: 'mirror'`, a mirror)
 *                                  acks it; re-pushed on every connect.
 *   sync/pending/<peer>/<scope>    a reconcile that has not completed with
 *                                  that peer; re-run when it (re)connects and
 *                                  every `retryMs` while connected.
 *
 * Everything is content-addressed and idempotent, so re-sending after an
 * interruption can only produce duplicates, which receivers drop.
 */
import * as crypto from '../crypto.js';
import { Negentropy, NegentropyStorageVector } from './negentropy.js';
import { peekEnvelope } from '../envelope.js';

/**
 * Ingest outcomes after which a record counts as delivered (acked, and a
 * resync waiting for it is satisfied). 'gone': dropped by a drop list,
 * 'control': a drop list itself.
 */
const SETTLED = new Set(['stored', 'duplicate', 'superseded', 'deferred', 'blind', 'gone', 'control']);

const MINUTE = 60_000;
const pad = (ms) => String(ms).padStart(13, '0');
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const randomId = () => crypto.toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));

const later = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

/**
 * @param {{releaseMs?: number, timeoutMs?: number, sessionTtlMs?: number, retryMs?: number, frameSizeLimit?: number, role?: 'peer'|'mirror', ackFrom?: 'any'|'mirror'}} [options]
 *   `releaseMs`: how long an unwatched scope stays subscribed (warm release).
 *   `timeoutMs`: how long a reconcile waits for wanted records to arrive.
 *   `retryMs`: how often pending reconciles are retried while connected.
 *   `role`: announced to peers; `ackFrom: 'mirror'` keeps outbox entries
 *   until a MIRROR has stored them (a plain peer's ack is not enough).
 */
export function sync({
  releaseMs = 30_000,
  timeoutMs = 10_000,
  sessionTtlMs = 60_000,
  retryMs = 30_000,
  frameSizeLimit = 0,
  role = 'peer',
  ackFrom = 'any',
} = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const peers = new Set();
    /** @type {Map<string, Set<string>>} peer -> subscribed `sid` / `sid/shard` (absent: everything). */
    const remoteSubs = new Map();
    /** @type {Map<string, {scope: object, refs: number, timer?: *}>} */
    const watches = new Map();
    /** @type {Map<string, {ne: Negentropy, timer: *}>} `${peer}:${session}` -> responder session. */
    const responding = new Map();
    /** @type {Map<string, object>} session -> initiator state. */
    const initiating = new Map();
    /** @type {Map<string, Set<object>>} record id -> initiator sessions waiting for it. */
    const awaiting = new Map();
    /** @type {Map<string, string>} peer -> announced role. */
    const roles = new Map();
    /** Pending keys with a reconcile currently running. */
    const active = new Set();
    /** @type {Map<string, Map<string, string[]>>} peer -> sid -> ids to ack (batched per tick). */
    const ackQueue = new Map();

    const pendingKey = (peer, { sid, shard, from, to }) => `sync/pending/${peer}/${encodeURIComponent(JSON.stringify([sid, shard, from, to]))}`;

    const scopeKey = (scope) => (scope.shard ? `${scope.sid}/${scope.shard}` : scope.sid);

    /**
     * @param {{space: import('../space.js').Space|{sid: string, shard?: string}, path?: string, from?: number, to?: number}} input
     * @returns {Promise<{sid: string, shard: string|null, from: number|null, to: number|null}>}
     */
    async function resolveScope({ space, path, from, to }) {
      if (path && typeof space.shardOf !== 'function') throw new Error('sync: a path scope needs a Space instance');
      return {
        sid: space.id ?? space.sid,
        shard: path ? crypto.toHex(await space.shardOf(path)) : (space.shard ?? null),
        from: from ?? null,
        to: to ?? null,
      };
    }

    /** All (ts, id) items of a scope, from the public sync index only. */
    async function loadItems({ sid, shard, from, to }) {
      const lo = from !== null && from !== undefined ? floorMinute(from) : null;
      const hi = to !== null && to !== undefined ? floorMinute(to - 1) + MINUTE : null;
      const prefix = shard ? `sx/${sid}/${shard}/` : `sx/${sid}/`;
      const keys = shard
        ? (await storage.range(prefix, { gte: lo !== null ? prefix + pad(lo) : undefined, lt: hi !== null ? prefix + pad(hi) : undefined })).map((r) => r.key)
        : await storage.keys(prefix);
      const vector = new NegentropyStorageVector();
      for (const key of keys) {
        const last = key.slice(key.lastIndexOf('/') + 1);
        const ts = Number(last.slice(0, 13));
        if ((lo !== null && ts < lo) || (hi !== null && ts >= hi)) continue;
        vector.insert(ts, last.slice(14));
      }
      vector.seal();
      return vector;
    }

    const send = (peer, type, payload) => bus.emit(`net.out.${peer}.${type}`, payload);

    async function sendRecord(peer, sid, id, viaSync = true) {
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes) await send(peer, 'rec', viaSync ? { bytes, sync: true } : { bytes });
      return Boolean(bytes);
    }

    /**
     * For reconcile: the record, or - if a drop list dropped it - that drop
     * list (once per `sent` set), which the peer verifies and applies itself.
     * @returns {Promise<boolean>} false if neither is held
     */
    async function sendOrDropList(peer, sid, id, sent, shardOk = () => true) {
      const found = qu.envelopes ? await qu.envelopes.bytesFor(sid, id) : null;
      if (!found) return false;
      const key = found.id;
      if (sent.has(key) || !shardOk(peekEnvelope(found.bytes).shard)) return true;
      sent.add(key);
      await send(peer, 'rec', { bytes: found.bytes, sync: true });
      return true;
    }

    function finish(state, error) {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.timer);
      initiating.delete(state.session);
      for (const id of state.waiting) awaiting.get(id)?.delete(state);
      const summary = {
        peer: state.peer,
        sid: state.scope.sid,
        shard: state.scope.shard,
        sent: state.have.length,
        received: state.received,
        missing: [...state.missing, ...state.waiting],
        ...(error ? { error: error.message } : {}),
      };
      active.delete(state.pending);
      const complete = !error && summary.missing.length === 0;
      Promise.resolve(complete ? storage.remove(state.pending) : undefined).then(() => {
        bus.notify(error ? 'sync.error' : 'sync.done', summary);
        state.resolve(summary);
      });
    }

    /**
     * Reconciles one scope with one peer, in both directions.
     * @returns {Promise<{peer: string, sid: string, shard: string|null, sent: number, received: number, missing: string[], error?: string}>}
     */
    async function reconcileWith(peer, scope) {
      const pending = pendingKey(peer, scope);
      await storage.set(pending, scope);
      active.add(pending);
      const ne = new Negentropy(await loadItems(scope), frameSizeLimit);
      ne.wantUint8ArrayOutput = true;
      const msg = await ne.initiate();
      const session = randomId();
      return new Promise((resolve) => {
        const state = { session, peer, scope, pending, ne, have: [], need: [], waiting: new Set(), received: 0, missing: [], resolve, closed: false };
        state.timer = later(() => finish(state, new Error('timeout')), timeoutMs);
        initiating.set(session, state);
        // The link may have dropped while the item set was being loaded.
        if (!peers.has(peer)) return finish(state, new Error('peer disconnected'));
        bus.notify('sync.start', { peer, sid: scope.sid, shard: scope.shard });
        send(peer, 'neg', { session, ...scope, msg });
      });
    }

    /**
     * Reconciles a scope with every connected peer (or just `peer`).
     * @param {{space: object, path?: string, from?: number, to?: number, peer?: string}} input
     */
    async function resync(input) {
      // Targets are fixed at call time: a link that drops while the scope is
      // being resolved still gets a (failed, therefore pending) session.
      const targets = input.peer ? [input.peer] : [...peers];
      const scope = await resolveScope(input);
      return Promise.all(targets.map((peer) => reconcileWith(peer, scope)));
    }

    /**
     * Declares interest in a scope: subscribes it at every peer (now and on
     * every later connect) and reconciles it. Resolves after the initial
     * reconcile with the currently connected peers.
     * @param {{space: object, path?: string, from?: number, to?: number}} input
     * @returns {Promise<() => void>} unwatch - releases after `releaseMs`.
     */
    async function watch(input) {
      const scope = await resolveScope(input);
      const key = scopeKey(scope);
      let entry = watches.get(key);
      if (entry) {
        entry.refs++;
        clearTimeout(entry.timer);
        entry.timer = undefined;
      } else {
        entry = { scope, refs: 1 };
        watches.set(key, entry);
        for (const peer of peers) await send(peer, 'sub', { sid: scope.sid, shard: scope.shard });
      }
      await Promise.all([...peers].map((peer) => reconcileWith(peer, scope)));

      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.refs > 0) return;
        const release = () => {
          if (entry.refs > 0) return;
          watches.delete(key);
          for (const peer of peers) send(peer, 'unsub', { sid: scope.sid, shard: scope.shard });
        };
        if (releaseMs > 0) entry.timer = later(release, releaseMs);
        else release();
      };
    }

    // --- routing: only to peers that asked for this (sid, shard) ----------
    /** A peer that never subscribed gets everything; otherwise only its (sid[, shard]) subscriptions. */
    function wants(peer, sid, shard) {
      const subs = remoteSubs.get(peer);
      return !subs || subs.has(sid) || subs.has(`${sid}/${shard}`);
    }
    bus.on('qu.route', ({ sid, shard, peers: candidates }) => ({ peers: candidates.filter((peer) => wants(peer, sid, shard)) }));

    // --- `query({ensure: true})` reconciles the window first --------------
    bus.on('qu.query.before', async (q) => {
      if (q.ensure) await resync({ space: q.space, path: q.path, from: q.from, to: q.to });
    });

    // --- peers ------------------------------------------------------------
    bus.on('net.peer.up', async ({ peer }) => {
      peers.add(peer);
      await send(peer, 'hello', { role });
      for (const { scope } of watches.values()) await send(peer, 'sub', { sid: scope.sid, shard: scope.shard });
      const resumed = new Set(await resumePending(peer));
      for (const { scope } of watches.values()) if (!resumed.has(pendingKey(peer, scope))) reconcileWith(peer, scope);
    });
    bus.on('net.peer.down', ({ peer }) => {
      peers.delete(peer);
      remoteSubs.delete(peer);
      roles.delete(peer);
      ackQueue.delete(peer);
      for (const [key, session] of responding) {
        if (key.startsWith(`${peer}:`)) {
          clearTimeout(session.timer);
          responding.delete(key);
        }
      }
      for (const state of [...initiating.values()]) if (state.peer === peer) finish(state, new Error('peer disconnected'));
    });

    bus.on('net.in.*.sub', async ({ sid, shard }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (!remoteSubs.has(peer)) remoteSubs.set(peer, new Set());
      remoteSubs.get(peer).add(shard ? `${sid}/${shard}` : sid);
      if (roles.get(peer) !== 'mirror') await flushOutbox(peer, (s, sh) => s === sid && (!shard || sh === shard));
    });
    bus.on('net.in.*.unsub', ({ sid, shard }, ctx) => {
      remoteSubs.get(ctx.topic.split('.')[2])?.delete(shard ? `${sid}/${shard}` : sid);
    });

    // --- durability: outbox, acks, pending reconciles -------------------------
    // The outbox is flushed to a peer only once it has said it wants the data:
    // a mirror (hello) gets everything, any other peer what it subscribed to.
    // Partial sync stays partial even for unacknowledged writes.
    bus.on('net.in.*.hello', async ({ role: remoteRole }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      roles.set(peer, remoteRole);
      if (remoteRole === 'mirror') await flushOutbox(peer, () => true);
    });

    // A record dropped before it was acknowledged needs no upload any more
    // (the drop list itself is in the outbox).
    bus.on('qu.envelope.stored', ({ sid, ws }) => {
      for (const id of ws?.dropped ?? []) ws.remove(`sync/out/${sid}/${id}`);
    });

    // Same write set as the record itself: a stored local record always has its outbox entry.
    bus.on('qu.write.stored', async ({ sid, id, header, ws }) => {
      ws.set(`sync/out/${sid}/${id}`, { shard: header.shard });
    });

    /** Re-pushes unacknowledged local writes matching `wanted(sid, shard)` to `peer`, as live records. */
    async function flushOutbox(peer, wanted) {
      for (const key of await storage.keys('sync/out/')) {
        const [, , sid, id] = key.split('/');
        const entry = await storage.get(key);
        if (!wanted(sid, entry?.shard)) continue;
        if (!(await sendRecord(peer, sid, id, false))) await storage.remove(key);
      }
    }

    /** Re-runs every reconcile with `peer` that never completed. @returns {Promise<string[]>} the pending keys started. */
    async function resumePending(peer) {
      const started = [];
      for (const key of await storage.keys(`sync/pending/${peer}/`)) {
        if (active.has(key)) continue;
        const scope = await storage.get(key);
        if (!scope) continue;
        started.push(key);
        reconcileWith(peer, scope);
      }
      return started;
    }

    bus.on('qu.record.processed', ({ from, sid, id, status }) => {
      if (!from || !sid || !SETTLED.has(status)) return;
      if (!ackQueue.has(from)) {
        ackQueue.set(from, new Map());
        queueMicrotask(() => flushAcks(from));
      }
      const bySid = ackQueue.get(from);
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid).push(id);
    });

    async function flushAcks(peer) {
      const bySid = ackQueue.get(peer);
      ackQueue.delete(peer);
      if (!bySid || !peers.has(peer)) return;
      for (const [sid, list] of bySid) {
        const ids = new Uint8Array(list.length * 32);
        list.forEach((id, i) => ids.set(crypto.fromHex(id), i * 32));
        await send(peer, 'ack', { sid, ids });
      }
    }

    bus.on('net.in.*.ack', async ({ sid, ids }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      const durable = ackFrom === 'any' || roles.get(peer) === 'mirror';
      for (let i = 0; i < ids.length; i += 32) {
        const id = crypto.toHex(ids.subarray(i, i + 32));
        if (durable && (await storage.has(`sync/out/${sid}/${id}`))) await storage.remove(`sync/out/${sid}/${id}`);
        await bus.notify('qu.record.acked', { sid, id, peer, role: roles.get(peer) ?? 'peer' });
      }
    });

    if (retryMs > 0) {
      const timer = setInterval(() => {
        for (const peer of peers) resumePending(peer);
      }, retryMs);
      timer.unref?.();
    }

    // --- responder ----------------------------------------------------------
    bus.on('net.in.*.neg', async ({ session, sid, shard, from, to, msg }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      const key = `${peer}:${session}`;
      let entry = responding.get(key);
      if (!entry) {
        const ne = new Negentropy(await loadItems({ sid, shard, from, to }), frameSizeLimit);
        ne.wantUint8ArrayOutput = true;
        entry = { ne, sid };
        responding.set(key, entry);
      }
      clearTimeout(entry.timer);
      entry.timer = later(() => responding.delete(key), sessionTtlMs);
      try {
        const [out] = await entry.ne.reconcile(msg);
        await send(peer, 'negr', { session, msg: out });
      } catch (error) {
        responding.delete(key);
        bus.notify('sync.error', { peer, sid, error: error.message });
      }
    });
    bus.on('net.in.*.negend', ({ session }, ctx) => {
      const key = `${ctx.topic.split('.')[2]}:${session}`;
      clearTimeout(responding.get(key)?.timer);
      responding.delete(key);
    });
    bus.on('net.in.*.want', async ({ session, sid, ids }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      const missing = [];
      const sent = new Set();
      for (let i = 0; i < ids.length; i += 32) {
        const id = crypto.toHex(ids.subarray(i, i + 32));
        if (!(await sendOrDropList(peer, sid, id, sent))) missing.push(id);
      }
      if (missing.length) await send(peer, 'wantmiss', { session, ids: missing });
    });

    // --- initiator ----------------------------------------------------------
    bus.on('net.in.*.negr', async ({ session, msg }) => {
      const state = initiating.get(session);
      if (!state || state.closed) return;
      let next, have, need;
      try {
        [next, have, need] = await state.ne.reconcile(msg);
      } catch (error) {
        return finish(state, error);
      }
      state.have.push(...have.map((id) => crypto.toHex(id)));
      state.need.push(...need.map((id) => crypto.toHex(id)));
      if (next !== null) return send(state.peer, 'neg', { session, msg: next });

      await send(state.peer, 'negend', { session });
      // Push what the peer lacks - but only what it subscribed to: a mirror
      // reconciling a whole space must not fill a partially-syncing peer.
      // A dropped id the peer still lacks gets the drop list instead.
      const sent = new Set();
      for (const id of state.have) await sendOrDropList(state.peer, state.scope.sid, id, sent, (shard) => wants(state.peer, state.scope.sid, shard));
      const wanted = [...new Set(state.need)];
      if (wanted.length === 0) return finish(state);
      for (const id of wanted) {
        state.waiting.add(id);
        if (!awaiting.has(id)) awaiting.set(id, new Set());
        awaiting.get(id).add(state);
      }
      const ids = new Uint8Array(wanted.length * 32);
      wanted.forEach((id, i) => ids.set(crypto.fromHex(id), i * 32));
      await send(state.peer, 'want', { session, sid: state.scope.sid, ids });
    });
    bus.on('net.in.*.wantmiss', ({ session, ids }) => {
      const state = initiating.get(session);
      if (!state) return;
      for (const id of ids) settle(state, id, false);
    });
    bus.on('qu.record.processed', ({ id, status }) => {
      const ok = SETTLED.has(status);
      for (const state of [...(awaiting.get(id) ?? [])]) settle(state, id, ok);
    });

    function settle(state, id, ok) {
      awaiting.get(id)?.delete(state);
      if (awaiting.get(id)?.size === 0) awaiting.delete(id);
      if (!state.waiting.delete(id)) return;
      if (ok) state.received++;
      else state.missing.push(id);
      if (state.waiting.size === 0) finish(state);
    }

    /** @returns {Promise<{outbox: number, pending: number}>} What is still waiting to be synced. */
    async function status() {
      return { outbox: (await storage.keys('sync/out/')).length, pending: (await storage.keys('sync/pending/')).length };
    }

    /**
     * Delivery state of one envelope from this device's point of view.
     * @returns {Promise<'pending'|'sent'>} pending while it waits in the outbox
     */
    const syncState = async (sid, id) => ((await storage.has(`sync/out/${sid}/${id}`)) ? 'pending' : 'sent');

    const api = { watch, resync, reconcileWith, status, syncState };
    Object.assign(qu, { watch, resync, syncStatus: status, syncState });
    return api;
  };
}
