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
 *   hello         {role, subs, only?}             'peer' | 'mirror', current subscriptions;
 *                                                 `only`: the list is exhaustive (even if empty)
 *   ack           {sid, ids}                      receiver stored these records
 *   nack          {sid, id, reason}               receiver refused it (e.g. a mirror's quota)
 *   negerr        {session, reason}               responder declined a session (busy)
 *
 * A mirror is just a peer that watches whole spaces. ONE reconcile per pair:
 * reconciles start when the other side's `hello` (role + subs) arrived; a
 * mirror never initiates towards a client (the client reconciles its own
 * watches and pushes what the mirror lacks) and never sends it `sub`s - so a
 * client never learns which other spaces a mirror serves, and connecting
 * costs the mirror nothing per stored space. Between equals watching the
 * same scope only the smaller network id initiates.
 *
 * Scoped links (link.js, one connection per space): only what
 * `qu.net.allows(peer, sid)` permits travels over a link.
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
 *
 * STALE DEVICES - drop lists and their gone markers expire after the
 * horizon (gc.js, 90 days). A device that was away longer still holds
 * records the others dropped meanwhile; pushing them in a reconcile would
 * bring them back everywhere. So every complete reconcile is remembered:
 *
 *   sync/last/<sid>[/<shard>]      start time of the last complete reconcile
 *                                  of that (whole-space or shard) scope
 *
 * A scope whose last complete reconcile is older than the horizon (minus a
 * day of margin) is STALE. Its reconcile still pushes the outbox (own
 * unsent writes) and every record younger than the horizon - a peer lacking
 * those really lost them, since a deletion would have left a gone marker -
 * but a record OLDER than the horizon that the peer lacks is ambiguous and
 * is retired locally (envelopes.js `retire`) instead of pushed: `sync.stale`
 * reports it, `qu.record.deleted {stale: true}` tells the app. The same
 * applies when another peer asks a stale device for such records (`want`).
 * `stale: 'push'` restores the old behaviour (e.g. to repair a mirror that
 * lost its data); a mirror never retires.
 */
import * as crypto from '../crypto.js';
import { Negentropy, NegentropyStorageVector } from './negentropy.js';
import { peekEnvelope } from '../envelope.js';
import { gcCutoff } from '../gc.js';

/**
 * Ingest outcomes after which a record counts as delivered (acked, and a
 * resync waiting for it is satisfied). 'gone': dropped by a drop list,
 * 'control': a drop list itself.
 */
const SETTLED = new Set(['stored', 'duplicate', 'superseded', 'deferred', 'blind', 'gone', 'control']);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const pad = (ms) => String(ms).padStart(13, '0');
const floorMinute = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const randomId = () => crypto.toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));

const later = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

/**
 * @param {{releaseMs?: number, timeoutMs?: number, sessionTtlMs?: number, retryMs?: number, frameSizeLimit?: number, role?: 'peer'|'mirror', ackFrom?: 'any'|'mirror', maxSessionsPerPeer?: number, stale?: 'retire'|'push'}} [options]
 *   `releaseMs`: how long an unwatched scope stays subscribed (warm release).
 *   `timeoutMs`: how long a reconcile waits for wanted records to arrive.
 *   `retryMs`: how often pending reconciles are retried while connected.
 *   `role`: announced to peers; `ackFrom: 'mirror'` keeps outbox entries
 *   until a MIRROR has stored them (a plain peer's ack is not enough).
 *   `stale`: what a stale scope does with old records the peer lacks
 *   (see STALE DEVICES above) - 'retire' (default) or 'push'.
 */
export function sync({
  releaseMs = 30_000,
  timeoutMs = 10_000,
  sessionTtlMs = 60_000,
  retryMs = 30_000,
  frameSizeLimit = 0,
  role = 'peer',
  ackFrom = 'any',
  maxSessionsPerPeer = 8,
  stale = 'retire',
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

    /** May `sid` travel over the link to `peer`? (scoped links, link.js) */
    const allows = (peer, sid) => (qu.net ? qu.net.allows(peer, sid) : true);
    const subKey = (scope) => (scope.shard ? `${scope.sid}/${scope.shard}` : scope.sid);
    /** A mirror subscribes only at other mirrors: clients must not learn the spaces it serves. */
    const subscribesAt = (peer, scope) => allows(peer, scope.sid) && !(role === 'mirror' && roles.get(peer) !== 'mirror');
    /** Who starts the reconcile of `scope` with `peer` after connecting (one per pair). */
    function initiates(peer, scope) {
      if (!allows(peer, scope.sid)) return false;
      if (role === 'mirror' && roles.get(peer) !== 'mirror') return false;
      const windowed = scope.from != null || scope.to != null;
      if (!windowed && roles.get(peer) === role && remoteSubs.get(peer)?.has(subKey(scope)) && peer < qu.peerId) return false;
      return true;
    }
    /** Pending keys with a reconcile currently running. */
    const active = new Set();
    /** @type {Map<string, Map<string, string[]>>} peer -> sid -> ids to ack (batched per tick). */
    const ackQueue = new Map();

    const pendingKey = (peer, { sid, shard, from, to }) => `sync/pending/${peer}/${encodeURIComponent(JSON.stringify([sid, shard, from, to]))}`;

    const scopeKey = (scope) => (scope.shard ? `${scope.sid}/${scope.shard}` : scope.sid);

    // --- stale devices (see header) -------------------------------------------
    /** @returns {Promise<number|null>} start of the last complete reconcile covering (sid[, shard]) */
    async function lastSync(sid, shard) {
      const times = [await storage.get(`sync/last/${sid}`), shard ? await storage.get(`sync/last/${sid}/${shard}`) : undefined];
      const known = times.filter((t) => typeof t === 'number');
      return known.length ? Math.max(...known) : null;
    }
    /** Unknown (never reconciled) is not stale: there is nothing old to doubt. */
    async function isStale(sid, shard) {
      if (role === 'mirror' || stale !== 'retire') return false;
      const last = await lastSync(sid, shard);
      return last !== null && last < gcCutoff(qu.clock.now()) + DAY;
    }
    /**
     * Splits ids a peer lacks: what may still be pushed, and what is older
     * than the horizon, not an own unsent write and in a stale shard
     * (-> retire locally).
     * @param {(shard: string) => Promise<boolean>} [staleShard] - default: the whole scope is stale
     * @returns {Promise<{push: string[], retire: string[]}>}
     */
    async function sortStale(sid, ids, staleShard = async () => true) {
      const cutoff = gcCutoff(qu.clock.now());
      const out = { push: [], retire: [] };
      for (const id of ids) {
        const bytes = await storage.get(`rec/${sid}/${id}`);
        const header = bytes && peekEnvelope(bytes);
        const old = header && header.ts < cutoff && !(await storage.has(`sync/out/${sid}/${id}`)) && (await staleShard(header.shard));
        out[old ? 'retire' : 'push'].push(id);
      }
      return out;
    }
    async function retireStale(peer, scope, ids, since) {
      if (!ids.length) return;
      await qu.envelopes?.retire(scope.sid, ids);
      await bus.notify('sync.stale', { peer, sid: scope.sid, shard: scope.shard ?? null, since, retired: ids.length });
    }

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
        ...(state.retired ? { retired: state.retired } : {}),
        ...(error ? { error: error.message } : {}),
      };
      active.delete(state.pending);
      const complete = !error && summary.missing.length === 0;
      // a complete reconcile of a whole space or shard (not a time window) proves this device current
      const windowed = state.scope.from != null || state.scope.to != null;
      const current = complete && !windowed && role !== 'mirror' ? storage.set(`sync/last/${scopeKey(state.scope)}`, state.startedAt) : undefined;
      Promise.all([complete ? storage.remove(state.pending) : undefined, current]).then(() => {
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
      const startedAt = qu.clock.now();
      const stale = (await isStale(scope.sid, scope.shard)) ? await lastSync(scope.sid, scope.shard) : null;
      const ne = new Negentropy(await loadItems(scope), frameSizeLimit);
      ne.wantUint8ArrayOutput = true;
      const msg = await ne.initiate();
      const session = randomId();
      return new Promise((resolve) => {
        const state = { session, peer, scope, pending, ne, have: [], need: [], waiting: new Set(), received: 0, missing: [], retired: 0, startedAt, stale, resolve, closed: false };
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
      return Promise.all(targets.filter((peer) => allows(peer, scope.sid)).map((peer) => reconcileWith(peer, scope)));
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
        for (const peer of peers) if (subscribesAt(peer, scope)) await send(peer, 'sub', { sid: scope.sid, shard: scope.shard });
      }
      // new interest: reconcile now with every peer that may carry it (and that we'd talk to as a mirror)
      await Promise.all([...peers].filter((peer) => allows(peer, scope.sid) && !(role === 'mirror' && roles.get(peer) !== 'mirror')).map((peer) => reconcileWith(peer, scope)));

      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--entry.refs > 0) return;
        const release = () => {
          if (entry.refs > 0) return;
          watches.delete(key);
          for (const peer of peers) if (subscribesAt(peer, scope)) send(peer, 'unsub', { sid: scope.sid, shard: scope.shard });
        };
        if (releaseMs > 0) entry.timer = later(release, releaseMs);
        else release();
      };
    }

    // --- routing: only to peers that asked for this (sid, shard) ----------
    /** A peer that never subscribed gets everything; otherwise only its (sid[, shard]) subscriptions. */
    function wants(peer, sid, shard) {
      const subs = remoteSubs.get(peer);
      if (!allows(peer, sid)) return false;
      return !subs || subs.has(sid) || subs.has(`${sid}/${shard}`);
    }
    bus.on('qu.route', ({ sid, shard, peers: candidates }) => ({ peers: candidates.filter((peer) => wants(peer, sid, shard)) }));

    // --- `query({ensure: true})` reconciles the window first --------------
    bus.on('qu.query.before', async (q) => {
      if (q.ensure) await resync({ space: q.space, path: q.path, from: q.from, to: q.to });
    });

    // --- peers ------------------------------------------------------------
    // Subscriptions travel inside `hello`; reconciles start once the other
    // side's hello (its role and subs) is known - see `initiates()`.
    bus.on('net.peer.up', async ({ peer }) => {
      peers.add(peer);
      const subs = role === 'mirror' ? [] : [...watches.values()].filter(({ scope }) => allows(peer, scope.sid)).map(({ scope }) => ({ sid: scope.sid, shard: scope.shard }));
      // A scoped link (one connection per space) subscribes exactly its space;
      // with isolation on, every link's list is exhaustive - nothing else may arrive on it.
      const scoped = qu.net?.scopes.get(peer);
      for (const sid of scoped ?? []) if (!subs.some((sub) => sub.sid === sid && !sub.shard)) subs.push({ sid });
      const only = Boolean(scoped || qu.net?.exclusive);
      await send(peer, 'hello', { role, subs, ...(only ? { only } : {}) });
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
    bus.on('net.in.*.hello', async ({ role: remoteRole, subs, only }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (!peers.has(peer)) return;
      roles.set(peer, remoteRole);
      if (Array.isArray(subs) && (subs.length || only)) {
        if (!remoteSubs.has(peer)) remoteSubs.set(peer, new Set());
        for (const sub of subs) if (typeof sub?.sid === 'string') remoteSubs.get(peer).add(sub.shard ? `${sub.sid}/${sub.shard}` : sub.sid);
      }
      // mirror <-> mirror: subscribe now that we know it is one
      if (role === 'mirror' && remoteRole === 'mirror') for (const { scope } of watches.values()) if (allows(peer, scope.sid)) await send(peer, 'sub', { sid: scope.sid, shard: scope.shard });
      if (remoteRole === 'mirror') await flushOutbox(peer, () => true);
      else if (Array.isArray(subs)) for (const sub of subs) await flushOutbox(peer, (sid, shard) => sid === sub.sid && (!sub.shard || shard === sub.shard));
      const resumed = new Set(await resumePending(peer));
      for (const { scope } of watches.values()) if (!resumed.has(pendingKey(peer, scope)) && initiates(peer, scope)) reconcileWith(peer, scope);
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
        if (!allows(peer, sid) || !wanted(sid, entry?.shard)) continue;
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
        if (!initiates(peer, scope) && allows(peer, scope.sid)) {
          await storage.remove(key); // the other side reconciles this pair
          continue;
        }
        if (!allows(peer, scope.sid)) continue;
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
        let open = 0;
        for (const k of responding.keys()) if (k.startsWith(`${peer}:`)) open++;
        if (open >= maxSessionsPerPeer) {
          bus.notify('sync.busy', { peer, sid });
          return send(peer, 'negerr', { session, reason: 'busy' });
        }
        // registered before the first await, so concurrent sessions count
        const ready = loadItems({ sid, shard, from, to }).then((items) => {
          const ne = new Negentropy(items, frameSizeLimit);
          ne.wantUint8ArrayOutput = true;
          return ne;
        });
        entry = { ready, sid };
        responding.set(key, entry);
      }
      clearTimeout(entry.timer);
      entry.timer = later(() => responding.delete(key), sessionTtlMs);
      try {
        const [out] = await (await entry.ready).reconcile(msg);
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
      let wanted = [];
      for (let i = 0; i < ids.length; i += 32) wanted.push(crypto.toHex(ids.subarray(i, i + 32)));
      // a stale device does not hand out old records the asking peer lacks (see header)
      if (role !== 'mirror' && stale === 'retire') {
        const { push, retire } = await sortStale(sid, wanted, (shard) => isStale(sid, shard));
        wanted = push;
        missing.push(...retire);
        await retireStale(peer, { sid }, retire, await lastSync(sid));
      }
      for (const id of wanted) if (!(await sendOrDropList(peer, sid, id, sent))) missing.push(id);
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
      // A stale scope keeps old records the peer lacks to itself (see header).
      if (state.stale !== null) {
        const { push, retire } = await sortStale(state.scope.sid, state.have);
        state.have = push;
        state.retired = retire.length;
        await retireStale(state.peer, state.scope, retire, state.stale);
      }
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
    bus.on('net.in.*.negerr', ({ session, reason }) => {
      const state = initiating.get(session);
      if (state) finish(state, new Error(`declined: ${reason}`)); // stays pending, retried later
    });
    bus.on('net.in.*.nack', ({ sid, id, reason }, ctx) => {
      if (typeof sid === 'string' && typeof id === 'string') bus.notify('qu.record.refused', { sid, id, reason, peer: ctx.topic.split('.')[2] });
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

    /**
     * Joined/known spaces whose last complete reconcile is older than the
     * horizon - e.g. to tell the user at start-up before anything syncs.
     * @returns {Promise<Array<{sid: string, last: number}>>}
     */
    async function staleSpaces() {
      const out = [];
      for (const key of await storage.keys('sync/last/')) {
        const [, , sid, shard] = key.split('/');
        if (shard || !(await isStale(sid))) continue;
        out.push({ sid, last: await lastSync(sid) });
      }
      return out;
    }

    const api = { watch, resync, reconcileWith, status, syncState, lastSync, staleSpaces };
    Object.assign(qu, { watch, resync, syncStatus: status, syncState, lastSync, staleSpaces });
    return api;
  };
}
