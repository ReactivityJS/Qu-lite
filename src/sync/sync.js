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
 * their (sid, shard). A mirror takes everything (it stores whole spaces and
 * never subscribes at clients); any other peer gets only what it subscribed
 * to - one that never sent `sub` gets nothing live, so connecting to a relay
 * reveals nothing about the spaces it serves.
 *
 *   hello         {role, subs, only?}             'peer' | 'mirror', current subscriptions;
 *                                                 `only`: the list is exhaustive (even if empty)
 *   ack           {sid, ids, w?}                  receiver stored these records; `w: 8` = 8-byte id
 *                                                 prefixes (feature 'ack8'), matched against the outbox
 *   nack          {sid, id, reason}               receiver refused it (e.g. a mirror's quota)
 *   negerr        {session, reason}               responder declined a session (busy)
 *   digest        {id, items: [{sid, shard?, n, fp}]}   "is your set of this scope the same as mine?"
 *   digestr       {id, same: [index]}             the items whose set is identical
 *   pull          {session, tag, sid, shard?, from?, to?}   "I have nothing of this scope: send all of it"
 *   rec           {bytes, pull: tag}              ... the records, tagged with the pull's small number
 *                                                 (implies `sync: true`; a few bytes per record)
 *   pullend       {session, sent, n, fp}          done: records sent, size + fingerprint of the set
 *   recs          {items: [bytes], sync?, pull?}  several records in one frame (feature 'recs'): each
 *                                                 item is handled exactly like a `rec` frame
 *
 * TRAFFIC - what keeps a reconcile cheap beyond Negentropy itself:
 *
 *   - DIGEST FIRST: when both sides announce `features: ['digest']` in
 *     `hello`, a whole-space (or shard) reconcile first compares one 16-byte
 *     fingerprint of the scope's (ts, id) set (Negentropy's own fingerprint:
 *     sum of ids + count, SHA-256) - batched for all scopes that start
 *     together into one frame. Identical sets finish right there (complete,
 *     nothing to send); only differing scopes run Negentropy. No answer, an
 *     older peer, a time window: the normal reconcile runs, unchanged.
 *   - EMPTY SIDE PULLS: a scope this device holds nothing of (a new
 *     device, a just-joined group) is not reconciled - Negentropy would send
 *     every id twice (32 bytes each: the responder lists them, the initiator
 *     wants them back). A `pull` asks for the scope's records directly; the
 *     responder streams them (paced) and closes with the count and the
 *     fingerprint of its set. Once that many tagged records are processed,
 *     the device compares fingerprints: equal = complete. Anything else - a
 *     different set (a record refused, a new one arrived meanwhile), no
 *     answer, a decline, a peer without the `pull` feature - falls back to
 *     the normal reconcile of the same scope, which fetches only what is
 *     still missing. The pull never decides correctness; the fingerprint or
 *     the reconcile does.
 *   - BATCHED RECORDS: to a peer that offers `recs`, bulk record sends (pull,
 *     want, push, outbox) go up to 64 records / 64 KiB per frame instead of
 *     one frame each - about 30 bytes less per record and one decode and
 *     dispatch per batch. Any other sync frame to that peer first flushes the
 *     open batch, so the order of records and control frames stays as it was.
 *     Rate limits still count records, not frames (frame.js frameUnits).
 *   - PACED SENDING: bulk record sends (pull, want, push, outbox) wait while
 *     the link's send buffer is full (`whenWritable`), so a large space never
 *     trips the transport's slow-consumer limit.
 *   - INDEX CACHE: the sealed (ts, id) vector of a whole space or shard is
 *     cached (with its fingerprint) and shared by every session, digest
 *     check and pull until the space's sync index changes - a reconnect
 *     storm costs one index load per space, not one per client and session.
 *     Invalidation is by a per-space generation that the storage router
 *     bumps AFTER every completed write under `sx/<sid>/` (mount.js
 *     `afterWrite`), whoever wrote it. A load only enters the cache if no
 *     write completed while it ran; concurrent requests for the same scope
 *     share one read (no thundering herd). Bounded by `indexCacheItems` (LRU);
 *     time windows are never cached. Sessions keep the vector they started
 *     with (a sealed vector is never mutated).
 *   - ONE SESSION PER (peer, scope): a reconcile already running for the same
 *     peer and scope is joined, never started twice (an app's watch() racing
 *     the reconnect's hello used to fetch everything twice).
 *   - BOUNDED CONCURRENCY: at most `maxConcurrentPerPeer` sessions per peer
 *     run at once, the rest queue - instead of being declined (`negerr busy`)
 *     by the responder's `maxSessionsPerPeer` and waiting for `retryMs`. A
 *     declined session is retried after ~1 s (backing off), not 30 s.
 *   - NO DOUBLE UPLOAD: outbox records pushed on connect are not pushed again
 *     by a reconcile on the same link (the receiver's set was loaded before
 *     they arrived). They stay in the outbox until acked, so nothing relies
 *     on that push having worked.
 *   - SHORT ACKS: to a peer offering `ack8`, an ack carries the first 8 bytes
 *     of each id instead of 32 - the receiver only needs to find the entry in
 *     its own outbox, where 64 bits never collide in practice (and a relay
 *     could already ack any id it knows). Acks for records that are not in
 *     the receiver's outbox carry no information for it and are dropped.
 *   - BATCHED ACKS, NONE TO MIRRORS: acks are collected for `ackDelayMs` (one
 *     frame instead of one per record); a mirror never writes, has no outbox
 *     to clear, and gets no acks.
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
 *                                  of that (whole-space or shard) scope with
 *                                  a mirror (only a mirror's state proves
 *                                  this device knows the deletions)
 *
 * A scope whose last complete reconcile is older than the horizon (minus a
 * day of margin) is STALE. Its reconcile still pushes the outbox (own
 * unsent writes) and every record younger than the horizon - a peer lacking
 * those really lost them, since a deletion would have left a gone marker -
 * but a record OLDER than the horizon that the peer lacks is ambiguous and
 * is retired locally (envelopes.js `retire`) instead of pushed: `sync.stale`
 * reports it, `qu.record.deleted {stale: true}` tells the app. Only a MIRROR
 * can cause that: towards any other peer (a group member over WebRTC, which
 * could simply claim to lack things) a stale device withholds those old
 * records - in its reconcile and when asked for them (`want`) - but keeps them.
 * `stale: 'push'` restores the old behaviour (e.g. to repair a mirror that
 * lost its data); a mirror never retires.
 */
import * as crypto from '../crypto.js';
import { Negentropy, NegentropyStorageVector } from './negentropy.js';
import { whenWritable } from '../net/link.js';
import { peekEnvelope } from '../envelope.js';
import { gcCutoff } from '../gc.js';

/**
 * Ingest outcomes after which a record counts as delivered (acked, and a
 * resync waiting for it is satisfied). 'gone': dropped by a drop list,
 * 'control': a drop list itself.
 */
const SETTLED = new Set(['stored', 'duplicate', 'superseded', 'deferred', 'blind', 'gone', 'control']);

const MINUTE = 60_000;
/** Ids per want/ack frame (128 KiB): frames stay far below transport limits (ws-server maxFrameBytes, SSE posts). */
const IDS_PER_FRAME = 4096;
/** Sync-index keys read per storage call; the event loop runs between pages. */
const INDEX_PAGE = 5000;
const yieldToLoop = () => new Promise((resolve) => (globalThis.setImmediate ?? setTimeout)(resolve));
const idChunks = (list) => Array.from({ length: Math.ceil(list.length / IDS_PER_FRAME) }, (_, i) => list.slice(i * IDS_PER_FRAME, (i + 1) * IDS_PER_FRAME));
const packIds = (list) => {
  const ids = new Uint8Array(list.length * 32);
  list.forEach((id, i) => ids.set(crypto.fromHex(id), i * 32));
  return ids;
};
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
 * @param {{releaseMs?: number, timeoutMs?: number, sessionTtlMs?: number, retryMs?: number, frameSizeLimit?: number, role?: 'peer'|'mirror', ackFrom?: 'any'|'mirror', maxSessionsPerPeer?: number, stale?: 'retire'|'push',
 *   maxConcurrentPerPeer?: number, ackDelayMs?: number, digest?: boolean, pull?: boolean, batch?: boolean, indexCacheItems?: number}} [options]
 *   `releaseMs`: how long an unwatched scope stays subscribed (warm release).
 *   `timeoutMs`: how long a reconcile waits for wanted records to arrive.
 *   `retryMs`: how often pending reconciles are retried while connected.
 *   `frameSizeLimit`: max Negentropy message (bytes; 0 = unlimited) - bigger
 *   differences take more rounds instead of one huge frame.
 *   `role`: announced to peers; `ackFrom: 'mirror'` keeps outbox entries
 *   until a MIRROR has stored them (a plain peer's ack is not enough).
 *   `stale`: what a stale scope does with old records the peer lacks
 *   (see STALE DEVICES above) - 'retire' (default) or 'push'.
 *   `maxConcurrentPerPeer`: own reconciles running at once per peer (the rest
 *   queue; keep it below the other side's `maxSessionsPerPeer`).
 *   `ackDelayMs`: how long acks are collected before they are sent.
 *   `digest`: offer and use the digest pre-check (see TRAFFIC above).
 *   `pull`: offer and use the direct download for scopes this device holds
 *   nothing of (see TRAFFIC above).
 *   `batch`: offer and use batched `recs` frames (see TRAFFIC above).
 *   `indexCacheItems`: items of cached sync-index vectors kept at most
 *   (~300 bytes each: mirror default 250 000 ~ 71 MiB, peer 50 000 ~ 14 MiB;
 *   0 disables the cache).
 */
export function sync({
  releaseMs = 30_000,
  timeoutMs = 10_000,
  sessionTtlMs = 60_000,
  retryMs = 30_000,
  frameSizeLimit = 256 * 1024,
  role = 'peer',
  ackFrom = 'any',
  maxSessionsPerPeer = 8,
  maxConcurrentPerPeer = 4,
  ackDelayMs = 20,
  digest = true,
  pull = true,
  batch = true,
  indexCacheItems = role === 'mirror' ? 250_000 : 50_000,
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
    /** @type {Map<string, Set<string>>} peer -> announced protocol features. */
    const features = new Map();
    /** @type {Map<string, Promise>} pending key -> the running reconcile (one per peer and scope). */
    const inflight = new Map();
    /** @type {Map<string, {running: number, queue: Array<() => void>}>} peer -> own concurrent sessions. */
    const slots = new Map();
    /** @type {Map<string, number>} pending key -> consecutive `busy` declines (retry backoff). */
    const busyRetries = new Map();
    /** @type {Map<string, Set<string>>} peer -> `sid/id` of outbox records already pushed on this link. */
    const flushedTo = new Map();
    /** @type {Map<string, {items: object[], resolvers: Function[]}>} peer -> digest items waiting to be sent. */
    const digestBatches = new Map();
    /** @type {Map<string, {peer: string, resolvers: Function[], timer: *}>} digest id -> waiting checks. */
    const digestsOut = new Map();
    /** @type {Map<string, object>} pull session -> its progress (initiator side) */
    const pulling = new Map();
    /** @type {Map<number, object>} pull tag (small integer, in every rec frame) -> its progress */
    const pullTags = new Map();
    let pullSeq = 0;
    /** @type {Map<string, {promise: Promise<void>, resolve: () => void}>} peer -> its hello has arrived (or the link went) */
    const hellos = new Map();
    const helloOf = (peer) => {
      let entry = hellos.get(peer);
      if (!entry) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        hellos.set(peer, (entry = { promise, resolve }));
      }
      return entry;
    };
    /** Waits (at most `ms`) until `peer`'s hello told its role and features. */
    const knowPeer = (peer, ms) =>
      features.has(peer) || !peers.has(peer)
        ? Promise.resolve()
        : Promise.race([helloOf(peer).promise, new Promise((r) => setTimeout(r, ms).unref?.())]);

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

    // --- sync-index cache (see INDEX CACHE) -------------------------------------
    /** @type {Map<string, number>} sid -> generation, bumped after every completed sx/<sid>/ write */
    const generations = new Map();
    /** @type {Map<string, {gen: number, vector: object, items: number, fp?: Promise<Uint8Array>}>} `${sid}/${shard}` -> cached vector, LRU order */
    const vectors = new Map();
    let cachedItems = 0;
    /** @type {Map<string, {gen: number, promise: Promise<object>}>} reads in flight per scope */
    const reading = new Map();
    const genOf = (sid) => generations.get(sid) ?? 0;
    const dropCached = (key) => {
      const entry = vectors.get(key);
      if (!entry) return;
      vectors.delete(key);
      cachedItems -= entry.items;
    };
    const offWrites = storage.afterWrite?.('sx/', (keys) => {
      const touched = new Set();
      for (const key of keys) touched.add(key.slice(3, key.indexOf('/', 3) === -1 ? undefined : key.indexOf('/', 3)));
      for (const sid of touched) {
        generations.set(sid, genOf(sid) + 1);
        for (const key of [...vectors.keys()]) if (key.startsWith(`${sid}/`)) dropCached(key);
      }
    });
    if (offWrites) qu.onClose?.(offWrites);
    // without write hooks (a foreign storage object) there is no safe invalidation: no cache
    const caching = indexCacheItems > 0 && Boolean(offWrites);

    /**
     * The sealed (ts, id) vector of a scope - from the cache when the space
     * did not change since it was loaded. Never mutate the result.
     */
    async function loadItems(scope) {
      const windowed = scope.from != null || scope.to != null;
      if (!caching || windowed) return readItems(scope);
      const key = `${scope.sid}/${scope.shard ?? ''}`;
      const gen = genOf(scope.sid);
      const hit = vectors.get(key);
      if (hit && hit.gen === gen) {
        vectors.delete(key); // most recently used last
        vectors.set(key, hit);
        bus.notify('sync.index', { sid: scope.sid, shard: scope.shard ?? null, items: hit.items, ms: 0, cached: true });
        return hit.vector;
      }
      // single flight: concurrent requests for the same scope and generation share one read
      const running = reading.get(key);
      if (running && running.gen === gen) return running.promise;
      const promise = readItems(scope);
      reading.set(key, { gen, promise });
      let vector;
      try {
        vector = await promise;
      } finally {
        if (reading.get(key)?.promise === promise) reading.delete(key);
      }
      // only if no write completed meanwhile (it could be missing from what was read)
      if (genOf(scope.sid) === gen && vector.size() <= indexCacheItems) {
        dropCached(key);
        vectors.set(key, { gen, vector, items: vector.size() });
        cachedItems += vector.size();
        for (const old of vectors.keys()) {
          if (cachedItems <= indexCacheItems) break;
          dropCached(old);
        }
      }
      return vector;
    }

    /** Size and fingerprint of a whole-space/shard scope, cached with its vector. */
    async function fingerprintOf(scope) {
      const vector = await loadItems(scope);
      const entry = vectors.get(`${scope.sid}/${scope.shard ?? ''}`);
      const fp = entry?.vector === vector ? (entry.fp ??= vector.fingerprint(0, vector.size())) : vector.fingerprint(0, vector.size());
      return { n: vector.size(), fp: await fp };
    }

    /** All (ts, id) items of a scope, read from the public sync index. */
    async function readItems({ sid, shard, from, to }) {
      const t0 = performance.now();
      const lo = from !== null && from !== undefined ? floorMinute(from) : null;
      const hi = to !== null && to !== undefined ? floorMinute(to - 1) + MINUTE : null;
      const prefix = shard ? `sx/${sid}/${shard}/` : `sx/${sid}/`;
      const vector = new NegentropyStorageVector();
      const add = (key) => {
        const last = key.slice(key.lastIndexOf('/') + 1);
        const ts = Number(last.slice(0, 13));
        if ((lo !== null && ts < lo) || (hi !== null && ts >= hi)) return;
        vector.insert(ts, last.slice(14));
      };
      // in pages, yielding between them: a large space never blocks the event loop in one piece
      let gte = shard && lo !== null ? prefix + pad(lo) : undefined;
      const lt = shard && hi !== null ? prefix + pad(hi) : undefined;
      for (;;) {
        const page = await storage.range(prefix, { gte, lt, limit: INDEX_PAGE });
        for (const { key } of page) add(key);
        if (page.length < INDEX_PAGE) break;
        gte = `${page[page.length - 1].key}\u0000`;
        await yieldToLoop();
      }
      vector.seal();
      bus.notify('sync.index', { sid, shard: shard ?? null, items: vector.size(), ms: performance.now() - t0, cached: false });
      return vector;
    }

    const emitOut = (peer, type, payload) => bus.emit(`net.out.${peer}.${type}`, payload);

    // --- batched records (see BATCHED RECORDS) ----------------------------------
    const BATCH_ITEMS = 64;
    const BATCH_BYTES = 64 * 1024;
    /** @type {Map<string, Map<string, {extra: object, items: Uint8Array[], bytes: number, timer: *}>>} peer -> kind (sync, live, pull tag) -> open batch */
    const recBatches = new Map();
    async function flushRecs(peer, kind) {
      const open = recBatches.get(peer);
      const b = open?.get(kind);
      if (!b) return;
      open.delete(kind);
      if (!open.size) recBatches.delete(peer);
      clearTimeout(b.timer);
      if (b.items.length === 1) await emitOut(peer, 'rec', { bytes: b.items[0], ...b.extra });
      else await emitOut(peer, 'recs', { items: b.items, ...b.extra });
    }
    const flushAll = async (peer) => {
      for (const kind of [...(recBatches.get(peer)?.keys() ?? [])]) await flushRecs(peer, kind);
    };
    /** Sends one record - batched where the peer takes `recs`. `extra`: {sync: true}, {pull: tag} or {}. */
    async function sendRec(peer, bytes, extra) {
      if (!batch || !features.get(peer)?.has('recs')) return emitOut(peer, 'rec', { bytes, ...extra });
      const kind = extra.pull != null ? `p${extra.pull}` : extra.sync ? 's' : 'l';
      // no await between finding the batch and adding to it: concurrent senders never mix kinds
      let open = recBatches.get(peer);
      if (!open) recBatches.set(peer, (open = new Map()));
      let b = open.get(kind);
      if (!b) {
        open.set(kind, (b = { extra, items: [], bytes: 0, timer: null }));
        b.timer = setTimeout(() => flushRecs(peer, kind), 0); // a paused sender still delivers what it has
      }
      b.items.push(bytes);
      b.bytes += bytes.length;
      // a batch never exceeds the remote's burst (its rate limit counts every record)
      const budget = qu.net?.links.get(peer)?.budget;
      const max = budget ? Math.max(1, Math.min(BATCH_ITEMS, Math.floor(budget.burst))) : BATCH_ITEMS;
      if (b.items.length >= max || b.bytes >= BATCH_BYTES) await flushRecs(peer, kind);
    }
    /** Every other sync frame flushes the open batches first: order stays as without batching. */
    const send = async (peer, type, payload) => {
      if (recBatches.has(peer)) await flushAll(peer);
      return emitOut(peer, type, payload);
    };
    /** peer -> recs frames being processed: acks wait for the batch to finish (one ack frame, not one per record) */
    const batchesIn = new Map();
    bus.on('net.in.*.recs', async ({ items, sync: viaSync, pull: tag }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (!Array.isArray(items) || items.length > 1024) return;
      batchesIn.set(peer, (batchesIn.get(peer) ?? 0) + 1);
      try {
        for (const bytes of items) {
          if (!(bytes instanceof Uint8Array)) continue;
          await bus.emit(`net.in.${peer}.rec`, Number.isInteger(tag) ? { bytes, pull: tag } : viaSync ? { bytes, sync: true } : { bytes });
        }
      } finally {
        const left = batchesIn.get(peer) - 1;
        if (left > 0) batchesIn.set(peer, left);
        else {
          batchesIn.delete(peer);
          if (ackQueue.has(peer)) flushAcks(peer);
        }
      }
    });

    /** @returns {Promise<boolean>} whether the record is held here (sent, or not sendable because the link went away) */
    async function sendRecord(peer, sid, id, viaSync = true) {
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes && (await whenWritable(qu, peer))) await sendRec(peer, bytes, viaSync ? { sync: true } : {});
      return Boolean(bytes);
    }

    /**
     * For reconcile: the record, or - if a drop list dropped it - that drop
     * list (once per `sent` set), which the peer verifies and applies itself.
     * @param {object} [extra] - more fields for the `rec` frame (a pull session)
     * @returns {Promise<false|'sent'|'skip'>} false if neither is held; 'skip': held but not sent
     *   (drop list already sent, other shard, link gone)
     */
    async function sendOrDropList(peer, sid, id, sent, shardOk = () => true, extra = null) {
      const found = qu.envelopes ? await qu.envelopes.bytesFor(sid, id) : null;
      if (!found) return false;
      const key = found.id;
      if (sent.has(key) || !shardOk(peekEnvelope(found.bytes).shard)) return 'skip';
      if (!(await whenWritable(qu, peer))) return 'skip';
      sent.add(key);
      await sendRec(peer, found.bytes, extra ?? { sync: true });
      return 'sent';
    }

    function finish(state, error) {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.timer);
      state.release?.();
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
      if (!error) busyRetries.delete(state.pending);
      // a complete reconcile of a whole space or shard (not a time window) WITH A MIRROR proves this
      // device current - a plain peer may be just as stale and know none of the deletions
      const windowed = state.scope.from != null || state.scope.to != null;
      const proves = complete && !windowed && role !== 'mirror' && roles.get(state.peer) === 'mirror';
      const current = proves ? storage.set(`sync/last/${scopeKey(state.scope)}`, state.startedAt) : undefined;
      Promise.all([complete ? storage.remove(state.pending) : undefined, current]).then(() => {
        bus.notify(error ? 'sync.error' : 'sync.done', summary);
        state.resolve(summary);
      });
    }

    // --- bounded concurrency per peer ------------------------------------------
    /** Waits for a free session slot with `peer`. @returns {Promise<() => void>} release */
    function acquire(peer) {
      let slot = slots.get(peer);
      if (!slot) slots.set(peer, (slot = { running: 0, queue: [] }));
      const release = () => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          slot.running--;
          slot.queue.shift()?.();
        };
      };
      if (slot.running < maxConcurrentPerPeer) {
        slot.running++;
        return Promise.resolve(release());
      }
      return new Promise((resolve) =>
        slot.queue.push(() => {
          slot.running++;
          resolve(release());
        })
      );
    }

    // --- digest pre-check -------------------------------------------------------
    const DIGEST_ITEMS = 256;
    const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    /** @returns {Promise<boolean>} true if `peer` holds exactly the same set for this scope */
    function digestCheck(peer, scope, n, fp) {
      return new Promise((resolve) => {
        let batch = digestBatches.get(peer);
        if (!batch) {
          digestBatches.set(peer, (batch = { items: [], resolvers: [] }));
          setTimeout(() => sendDigests(peer), 5); // scopes that start together share one frame (not unref'd: it must fire)
        }
        batch.items.push({ sid: scope.sid, ...(scope.shard ? { shard: scope.shard } : {}), n, fp });
        batch.resolvers.push(resolve);
      });
    }
    async function sendDigests(peer) {
      const batch = digestBatches.get(peer);
      digestBatches.delete(peer);
      if (!batch) return;
      for (let i = 0; i < batch.items.length; i += DIGEST_ITEMS) {
        const resolvers = batch.resolvers.slice(i, i + DIGEST_ITEMS);
        if (!peers.has(peer)) {
          for (const r of resolvers) r(false);
          continue;
        }
        const id = randomId();
        const timer = later(() => answerDigest(id, []), timeoutMs);
        digestsOut.set(id, { peer, resolvers, timer });
        await send(peer, 'digest', { id, items: batch.items.slice(i, i + DIGEST_ITEMS) });
      }
    }
    function answerDigest(id, same) {
      const waiting = digestsOut.get(id);
      if (!waiting) return;
      digestsOut.delete(id);
      clearTimeout(waiting.timer);
      const hits = new Set(Array.isArray(same) ? same : []);
      waiting.resolvers.forEach((resolve, i) => resolve(hits.has(i)));
    }
    bus.on('net.in.*.digestr', ({ id, same }, ctx) => {
      if (digestsOut.get(id)?.peer === ctx.topic.split('.')[2]) answerDigest(id, same);
    });
    bus.on('net.in.*.digest', async ({ id, items }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (!digest || typeof id !== 'string' || !Array.isArray(items) || items.length > DIGEST_ITEMS) return;
      const same = [];
      for (let i = 0; i < items.length; i++) {
        const { sid, shard, n, fp } = items[i] ?? {};
        if (typeof sid !== 'string' || (shard != null && typeof shard !== 'string') || !(fp instanceof Uint8Array) || fp.length !== 16) continue;
        if (!allows(peer, sid)) continue;
        const mine = await fingerprintOf({ sid, shard: shard ?? null, from: null, to: null });
        if (mine.n === n && sameBytes(mine.fp, fp)) same.push(i);
      }
      await send(peer, 'digestr', { id, same });
    });

    /**
     * Reconciles one scope with one peer, in both directions. A reconcile of
     * the same scope with the same peer that is already running is joined.
     * @returns {Promise<{peer: string, sid: string, shard: string|null, sent: number, received: number, missing: string[], error?: string}>}
     */
    function reconcileWith(peer, scope) {
      const pending = pendingKey(peer, scope);
      const running = inflight.get(pending);
      if (running) return running;
      const promise = runReconcile(peer, scope, pending).finally(() => {
        if (inflight.get(pending) === promise) inflight.delete(pending);
      });
      inflight.set(pending, promise);
      return promise;
    }

    async function runReconcile(peer, scope, pending) {
      await storage.set(pending, scope);
      active.add(pending);
      const startedAt = qu.clock.now();
      const windowed = scope.from != null || scope.to != null;
      // a watch() right after connecting may come before the peer's hello: its features decide the path
      await knowPeer(peer, Math.min(timeoutMs, 5000));
      const offered = features.get(peer);
      const local = await loadItems(scope);

      let skip = false; // the sets are known to be identical - no Negentropy session
      let pulled = null;
      let release = null;
      if (pull && local.size() === 0 && offered?.has('pull') && peers.has(peer)) {
        // nothing here yet: download directly, no id lists (see TRAFFIC)
        release = await acquire(peer);
        pulled = await pullScope(peer, scope);
        skip = pulled.complete;
      } else if (digest && !windowed && offered?.has('digest') && peers.has(peer)) {
        const mine = await fingerprintOf(scope);
        skip = await digestCheck(peer, scope, mine.n, mine.fp);
      }

      if (skip) release ??= () => {};
      else release ??= await acquire(peer);
      const stale = !skip && (await isStale(scope.sid, scope.shard)) ? await lastSync(scope.sid, scope.shard) : null;
      const ne = skip ? null : new Negentropy(await loadItems(scope), frameSizeLimit);
      if (ne) ne.wantUint8ArrayOutput = true;
      const msg = ne ? await ne.initiate() : null;
      const session = randomId();
      return new Promise((resolve) => {
        const state = { session, peer, scope, pending, ne, have: [], need: [], waiting: new Set(), received: pulled?.received ?? 0, missing: [], retired: 0, startedAt, stale, resolve, closed: false, release };
        state.timer = later(() => finish(state, new Error('timeout')), timeoutMs);
        initiating.set(session, state);
        // The link may have dropped while the item set was being loaded.
        if (!peers.has(peer)) return finish(state, new Error('peer disconnected'));
        if (!pulled) bus.notify('sync.start', { peer, sid: scope.sid, shard: scope.shard, ...(skip ? { digest: true } : {}) });
        if (skip) return finish(state);
        send(peer, 'neg', { session, ...scope, msg });
      });
    }

    // --- pull: direct download into an empty scope ----------------------------
    /**
     * Asks `peer` for every record of `scope`, then checks the result by
     * fingerprint. Never fails loudly: `complete: false` sends the caller to
     * the normal reconcile.
     * @returns {Promise<{complete: boolean, received: number}>}
     */
    function pullScope(peer, scope) {
      return new Promise((resolve) => {
        const session = randomId();
        const tag = (pullSeq = (pullSeq % 1_000_000) + 1);
        const p = { session, tag, peer, scope, received: 0, expect: null, remote: null, timer: null, done: false };
        p.end = (complete, reason) => {
          if (p.done) return;
          p.done = true;
          clearTimeout(p.timer);
          pulling.delete(session);
          if (pullTags.get(tag) === p) pullTags.delete(tag);
          bus.notify('sync.pull', { peer, sid: scope.sid, shard: scope.shard, received: p.received, complete, ...(reason ? { reason } : {}) });
          resolve({ complete, received: p.received });
        };
        // a progress timeout: a large space may take long, a silent peer may not
        p.arm = () => {
          clearTimeout(p.timer);
          p.timer = later(() => p.end(false, 'timeout'), timeoutMs);
        };
        pulling.set(session, p);
        pullTags.set(tag, p);
        p.arm();
        bus.notify('sync.start', { peer, sid: scope.sid, shard: scope.shard, pull: true });
        send(peer, 'pull', {
          session,
          tag,
          sid: scope.sid,
          ...(scope.shard ? { shard: scope.shard } : {}),
          ...(scope.from != null ? { from: scope.from } : {}),
          ...(scope.to != null ? { to: scope.to } : {}),
        });
      });
    }

    /** Once every announced record is processed: same set as the peer's? */
    async function checkPull(p) {
      if (p.done || p.checking || p.expect === null || p.received < p.expect) return;
      p.checking = true;
      try {
        const mine = await fingerprintOf(p.scope);
        const same = mine.n === p.remote.n && sameBytes(mine.fp, p.remote.fp);
        p.end(same, same ? undefined : 'different set');
      } catch (error) {
        p.end(false, error.message);
      }
    }

    // after the envelope layer: when this runs, the record is processed (stored, refused, deferred ...)
    bus.on(
      'net.in.*.rec',
      ({ pull: tag }, ctx) => {
        if (!Number.isInteger(tag)) return;
        const p = pullTags.get(tag);
        if (!p || p.peer !== ctx.topic.split('.')[2]) return;
        p.received++;
        p.arm();
        return checkPull(p);
      },
      { order: 1000 }
    );
    bus.on('net.in.*.pullend', ({ session, sent, n, fp }, ctx) => {
      const p = pulling.get(session);
      if (!p || p.peer !== ctx.topic.split('.')[2]) return;
      if (!Number.isInteger(sent) || sent < 0 || !Number.isInteger(n) || !(fp instanceof Uint8Array)) return p.end(false, 'bad pullend');
      p.expect = sent;
      p.remote = { n, fp };
      p.arm();
      return checkPull(p);
    });

    // responder: stream the scope, then announce what was sent
    bus.on('net.in.*.pull', async ({ session, tag, sid, shard, from, to }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (typeof session !== 'string' || typeof sid !== 'string' || !Number.isInteger(tag)) return;
      if (!pull || !allows(peer, sid) || (shard != null && typeof shard !== 'string')) return send(peer, 'negerr', { session, reason: 'refused' });
      const key = `${peer}:${session}`;
      if (responding.has(key)) return;
      let open = 0;
      for (const k of responding.keys()) if (k.startsWith(`${peer}:`)) open++;
      if (open >= maxSessionsPerPeer) {
        bus.notify('sync.busy', { peer, sid });
        return send(peer, 'negerr', { session, reason: 'busy' });
      }
      // counts as a session; no TTL - it ends when the stream is sent or the peer goes
      const entry = { sid, pull: true };
      responding.set(key, entry);
      try {
        const scope = { sid, shard: shard ?? null, from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null };
        // a stale device keeps old records to itself (see STALE DEVICES): the reconcile handles that
        if (await isStale(sid, scope.shard)) return await send(peer, 'negerr', { session, reason: 'stale' });
        const items = await loadItems(scope);
        const sentLists = new Set();
        let sent = 0;
        for (let i = 0; i < items.size(); i++) {
          if (responding.get(key) !== entry) return; // the peer went away
          if ((await sendOrDropList(peer, sid, crypto.toHex(items.getItem(i).id), sentLists, undefined, { pull: tag })) === 'sent') sent++;
        }
        if (responding.get(key) !== entry) return;
        await send(peer, 'pullend', { session, sent, n: items.size(), fp: await items.fingerprint(0, items.size()) });
      } catch (error) {
        bus.notify('sync.error', { peer, sid, error: error.message });
      } finally {
        if (responding.get(key) === entry) responding.delete(key);
      }
    });

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
    /** A mirror wants every space; any other peer only its (sid[, shard]) subscriptions - none: nothing. */
    function wants(peer, sid, shard) {
      if (!allows(peer, sid)) return false;
      if (roles.get(peer) === 'mirror') return true;
      const subs = remoteSubs.get(peer);
      return Boolean(subs && (subs.has(sid) || subs.has(`${sid}/${shard}`)));
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
      await send(peer, 'hello', { role, subs, ...(only ? { only } : {}), features: [...(digest ? ['digest'] : []), ...(pull ? ['pull'] : []), ...(batch ? ['recs'] : []), 'ack8', ...(qu.net?.features ?? [])] });
    });
    bus.on('net.peer.down', ({ peer }) => {
      peers.delete(peer);
      remoteSubs.delete(peer);
      roles.delete(peer);
      features.delete(peer);
      for (const b of recBatches.get(peer)?.values() ?? []) clearTimeout(b.timer); // its records stay in the outbox / come back by reconcile
      recBatches.delete(peer);
      batchesIn.delete(peer);
      hellos.get(peer)?.resolve();
      hellos.delete(peer);
      flushedTo.delete(peer);
      const queue = ackQueue.get(peer);
      if (queue) clearTimeout(queue.timer);
      ackQueue.delete(peer);
      const slot = slots.get(peer);
      slots.delete(peer);
      for (const next of slot?.queue.splice(0) ?? []) next(); // they see the peer gone and end as pending
      for (const [id, waiting] of digestsOut) if (waiting.peer === peer) answerDigest(id, []);
      for (const p of [...pulling.values()]) if (p.peer === peer) p.end(false, 'peer disconnected');
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
    bus.on('net.in.*.hello', async ({ role: remoteRole, subs, only, features: offered }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (!peers.has(peer)) return;
      roles.set(peer, remoteRole);
      features.set(peer, new Set(Array.isArray(offered) ? offered.filter((f) => typeof f === 'string') : []));
      helloOf(peer).resolve();
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
        else {
          if (!flushedTo.has(peer)) flushedTo.set(peer, new Set());
          flushedTo.get(peer).add(`${sid}/${id}`);
        }
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
      if (roles.get(from) === 'mirror') return; // a mirror never writes: no outbox to clear
      let queue = ackQueue.get(from);
      if (!queue) {
        ackQueue.set(from, (queue = { bySid: new Map(), count: 0, timer: null }));
        // short and must fire: not unref'd; while a recs batch from that peer runs, its end flushes instead
        const due = () => (batchesIn.has(from) ? (queue.timer = setTimeout(due, ackDelayMs)) : flushAcks(from));
        if (ackDelayMs > 0) queue.timer = setTimeout(due, ackDelayMs);
        else queueMicrotask(() => flushAcks(from));
      }
      if (!queue.bySid.has(sid)) queue.bySid.set(sid, []);
      queue.bySid.get(sid).push(id);
      if (++queue.count >= IDS_PER_FRAME) flushAcks(from);
    });

    async function flushAcks(peer) {
      const queue = ackQueue.get(peer);
      ackQueue.delete(peer);
      if (queue) clearTimeout(queue.timer);
      const bySid = queue?.bySid;
      if (!bySid || !peers.has(peer)) return;
      for (const [sid, list] of bySid) {
        const short = features.get(peer)?.has('ack8');
        for (const chunk of idChunks(list)) {
          if (!short) await send(peer, 'ack', { sid, ids: packIds(chunk) });
          else {
            const ids = new Uint8Array(chunk.length * 8);
            chunk.forEach((id, i) => ids.set(crypto.fromHex(id.slice(0, 16)), i * 8));
            await send(peer, 'ack', { sid, ids, w: 8 });
          }
        }
      }
    }

    bus.on('net.in.*.ack', async ({ sid, ids, w }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      if (typeof sid !== 'string' || !(ids instanceof Uint8Array)) return;
      const durable = ackFrom === 'any' || roles.get(peer) === 'mirror';
      if (w === 8) {
        // prefixes: the full id comes from the own outbox
        for (let i = 0; i + 8 <= ids.length; i += 8) {
          for (const key of await storage.keys(`sync/out/${sid}/${crypto.toHex(ids.subarray(i, i + 8))}`)) {
            const id = key.slice(key.lastIndexOf('/') + 1);
            if (durable) await storage.remove(key);
            await bus.notify('qu.record.acked', { sid, id, peer, role: roles.get(peer) ?? 'peer' });
          }
        }
        return;
      }
      for (let i = 0; i < ids.length; i += 32) {
        const id = crypto.toHex(ids.subarray(i, i + 32));
        if (durable && (await storage.has(`sync/out/${sid}/${id}`))) await storage.remove(`sync/out/${sid}/${id}`);
        await bus.notify('qu.record.acked', { sid, id, peer, role: roles.get(peer) ?? 'peer' });
      }
    });

    if (retryMs > 0) {
      qu.timers.interval(() => {
        for (const peer of peers) resumePending(peer);
      }, retryMs);
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
        if (roles.get(peer) === 'mirror') await retireStale(peer, { sid }, retire, await lastSync(sid));
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
      // A stale scope keeps old records the peer lacks to itself (see header); a mirror's view retires them.
      if (state.stale !== null) {
        const { push, retire } = await sortStale(state.scope.sid, state.have);
        state.have = push;
        if (roles.get(state.peer) === 'mirror') {
          state.retired = retire.length;
          await retireStale(state.peer, state.scope, retire, state.stale);
        }
      }
      // Push what the peer lacks - but only what it subscribed to: a mirror
      // reconciling a whole space must not fill a partially-syncing peer.
      // A dropped id the peer still lacks gets the drop list instead.
      const sent = new Set();
      const flushed = flushedTo.get(state.peer);
      for (const id of state.have) {
        if (flushed?.has(`${state.scope.sid}/${id}`)) continue; // already pushed from the outbox on this link
        await sendOrDropList(state.peer, state.scope.sid, id, sent, (shard) => wants(state.peer, state.scope.sid, shard));
      }
      const wanted = [...new Set(state.need)];
      if (wanted.length === 0) return finish(state);
      for (const id of wanted) {
        state.waiting.add(id);
        if (!awaiting.has(id)) awaiting.set(id, new Set());
        awaiting.get(id).add(state);
      }
      for (const chunk of idChunks(wanted)) await send(state.peer, 'want', { session, sid: state.scope.sid, ids: packIds(chunk) });
    });
    bus.on('net.in.*.negerr', ({ session, reason }) => {
      const p = pulling.get(session);
      if (p) return p.end(false, `declined: ${reason}`); // the caller falls back to the reconcile
      const state = initiating.get(session);
      if (!state) return;
      finish(state, new Error(`declined: ${reason}`)); // stays pending
      if (reason !== 'busy') return; // retried by retryMs / the next connect
      const tries = (busyRetries.get(state.pending) ?? 0) + 1;
      busyRetries.set(state.pending, tries);
      const delay = Math.min(retryMs > 0 ? retryMs : 30_000, 1000 * 2 ** (tries - 1)) * (0.75 + Math.random() / 2);
      qu.timers.timeout(() => {
        if (peers.has(state.peer) && !qu.closed) reconcileWith(state.peer, state.scope);
      }, delay);
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
