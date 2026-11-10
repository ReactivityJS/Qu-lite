/**
 * LINK - the transport-independent half of every connection. A transport
 * plugin (WebSocket, later WebRTC DataChannel or HTTPS+SSE, in-process for
 * tests) only moves bytes; everything Qu-specific lives here once:
 *
 *   - the `hi {peer}` handshake (the network id - never the identity). A
 *     second link claiming a network id that is already connected REPLACES
 *     the old one (peer down, then up): a client reconnecting before the
 *     dead socket was noticed works at once, and an impostor reusing someone
 *     else's id never shares that peer's subscriptions or traffic,
 *   - framing (frame.js: binary, no base64),
 *   - `net.out.<remote>.<type>` -> send, received frames -> `net.in.<remote>.<type>`,
 *   - `net.peer.up` / `net.peer.down`, byte and frame counters per link -
 *     plain additions, always on; open links are listed in `qu.net.links`
 *     (remote -> {via, since, stats}) and `net.peer.down` carries the final
 *     counters, so an optional plugin (stats.js) can report traffic without
 *     a hook on the hot path,
 *   - the inbound guard `qu.net.guard(peer, type, size)` (limits.js): false
 *     drops a frame, 'close' closes the link,
 *   - SCOPED links (`scope`: a set of sids, own `localId`): one connection
 *     per space, so a relay can't tell which spaces belong to one device.
 *     The remote is then named `xor(remote, localId)` on the bus, so several
 *     links to the same relay don't collide; `qu.net.allows(peer, sid)` tells
 *     sync/envelopes what may travel over which link.
 *
 *   - HARDENING against untrusted remotes: a frame type must look like one
 *     (`[a-z][a-z0-9_-]*`, at most 32 chars - it becomes a bus topic segment),
 *     the inbound guard sees type and size BEFORE the JSON is parsed, a
 *     remote that does not say `hi` within `helloTimeoutMs` or sends more
 *     than a few frames before it is closed, and `hi` carries the protocol
 *     version (`v`): a remote speaking a newer major version is refused
 *     (`net.error {reason: 'protocol'}`) instead of being misunderstood,
 *   - on `qu.close()` every open link is dropped.
 *   - SENDER-SIDE RATE LIMIT: a peer with inbound rate limits (`limits`
 *     plugin: `net.inbound`) announces them in `hi` (`limits: {frames:
 *     {rate, burst}, bytes: {rate, burst}}`). The other side then sends at
 *     most 80 % of that rate (and half the burst): frames queue in order on
 *     the link instead of being dropped - and instead of the remote closing
 *     the link after too many drops, which made a big outbox re-upload
 *     itself on every reconnect. Without an announcement nothing changes.
 *   - INBOUND BACKPRESSURE: at most `maxInflight` (64) frames of one link
 *     are processed at a time; the rest wait in arrival order, still raw
 *     (decoded when their turn comes). Above 4 MiB waiting, the link asks
 *     its transport to stop reading (`pause()`: WebSocket on Node pauses
 *     the TCP socket, the SSE server holds back its POST answer) and
 *     resumes below 1 MiB - the sender's buffer fills and its pacing makes
 *     it wait. So one busy peer can neither start unbounded work nor make
 *     this side buffer without bound. Rate limits still apply on arrival,
 *     before anything is queued. Frames that arrived before a link closed
 *     are still processed. Events: `net.paused` / `net.resumed`.
 *   - PACING: a transport that can tell how much it still has to send
 *     (`buffered()`, e.g. a WebSocket's bufferedAmount) lets bulk senders wait
 *     with `whenWritable(qu, peer)` instead of filling memory - and instead
 *     of running into the transport's slow-consumer limit (`maxBuffered`),
 *     which closes the link. Waiting starts above a quarter of that limit
 *     (at most 4 MiB) and ends below a sixteenth.
 *
 * Contract for a transport: call `createLink(qu, {send, close, via})` when a
 * byte channel opens, feed every incoming message to `link.receive(bytes)`
 * and call `link.closed()` when the channel goes away.
 */
import { encodeFrame, decodeFrame, peekFrameType, frameUnits } from './frame.js';

/** Wire protocol version sent in `hi`. Bump on incompatible changes; a peer without `v` speaks 1. */
export const PROTOCOL_VERSION = 1;
/** Frame types are bus topic segments: no dots, no wildcards. */
const FRAME_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
/**
 * TRAFFIC BY TYPE: every link adds frames and bytes per frame type to
 * `netOf(qu).traffic` (Map type -> {framesIn, bytesIn, framesOut, bytesOut}),
 * summed over all links since `netOf(qu).trafficSince` - links that closed
 * included. Bytes are frame bytes (what the transport is given), without
 * WebSocket/TLS/TCP framing. Types this code does not send are counted as
 * `other`, so a remote inventing types cannot grow the map.
 */
/** Frame types counted by name in `traffic` (the rest as 'other'); meanings: devtools.js FRAME_TYPES. */
export const KNOWN_FRAME_TYPES = new Set(['hi', 'hello', 'grant', 'sub', 'unsub', 'rec', 'recs', 'ack', 'nack', 'neg', 'negr', 'negend', 'negerr', 'want', 'wantmiss', 'digest', 'digestr', 'pull', 'pullend', 'sig', 'grantsum', 'grantneed']);
const countType = (net, type, dir, bytes) => {
  const key = KNOWN_FRAME_TYPES.has(type) ? type : 'other';
  let row = net.traffic.get(key);
  if (!row) net.traffic.set(key, (row = { framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0 }));
  if (dir === 'in') {
    row.framesIn++;
    row.bytesIn += bytes;
  } else {
    row.framesOut++;
    row.bytesOut += bytes;
  }
};

/** Inbound frames processed at once per link (the rest queue in order). */
export const MAX_INFLIGHT = 64;
const INBOUND_HIGH = 4 * 1024 * 1024;
const INBOUND_LOW = 1024 * 1024;
/** Frames a remote may send before its `hi` (they are ignored) before the link is closed. */
const MAX_EARLY_FRAMES = 8;

/**
 * The per-Qu network registry (created on first use): which link may carry
 * which space, plus the optional inbound guard.
 * @returns {{scopes: Map<string, Set<string>>, isolated: Set<string>, links: Map<string, {via: string, since: number, stats: {sent: number, received: number, framesOut: number, framesIn: number}}>, allows: (peer: string, sid: string) => boolean, guard?: Function, exclusive?: boolean}}
 */
export function netOf(qu) {
  if (!qu.net) {
    const scopes = new Map();
    const isolated = new Set();
    const links = new Map();
    qu.net = {
      scopes,
      isolated,
      links,
      /** @type {Set<string>} protocol features plugins offer in the sync `hello` (besides sync's own) */
      features: new Set(),
      /** @type {Map<string, {framesIn: number, bytesIn: number, framesOut: number, bytesOut: number}>} per frame type, all links */
      traffic: new Map(),
      trafficSince: Date.now(),
      /** ms a remote has to say `hi` before the link is closed (0 = no limit). */
      helloTimeoutMs: 15_000,
      /** A scoped link carries only its sids; a shared link no isolated sid. */
      allows: (peer, sid) => (scopes.has(peer) ? scopes.get(peer).has(sid) : !isolated.has(sid)),
    };
    qu.onClose?.(() => {
      for (const link of [...links.values()]) link.drop();
    });
  }
  return qu.net;
}

const xorHex = (a, b) => Array.from({ length: a.length }, (_, i) => (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16)).join('');

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{send: (bytes: Uint8Array) => void, close?: () => void, via?: string, onUp?: (peer: string) => void, onDown?: () => void, localId?: string, scope?: Iterable<string>,
 *   buffered?: (() => number)|null, maxBuffered?: number, pause?: (() => void)|null, resume?: (() => void)|null, maxInflight?: number}} transport
 * @returns {{receive: (bytes: Uint8Array) => void, closed: () => void, close: () => void, stats: {sent: number, received: number, framesOut: number, framesIn: number}, readonly peer: string|null}}
 */
export function createLink(qu, { send, close = () => {}, via = 'link', onUp, onDown, localId, scope, buffered = null, maxBuffered = 0, pause = null, resume = null, maxInflight = netOf(qu).maxInflight ?? MAX_INFLIGHT }) {
  const net = netOf(qu);
  const stats = { sent: 0, received: 0, framesOut: 0, framesIn: 0 };
  let remote = null;
  let off = null;
  let open = true;

  let early = 0;
  // inbound: frames waiting for a processing slot, still raw
  const inbox = [];
  let inboxBytes = 0;
  let inflight = 0;
  let paused = false;
  const pump = () => {
    while (inflight < maxInflight && inbox.length) {
      const { bytes, peer } = inbox.shift();
      inboxBytes -= bytes.length;
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        qu.bus.notify('net.error', { via, reason: 'bad frame', peer });
        continue;
      }
      inflight++;
      qu.bus.emit(`net.in.${peer}.${frame.type}`, frame.payload).finally(() => {
        inflight--;
        pump();
      });
    }
    if (paused && inboxBytes <= INBOUND_LOW) {
      paused = false;
      resume?.();
      qu.bus.notify('net.resumed', { peer: remote, via });
    }
  };
  const transmit = (frame) => {
    stats.sent += frame.length;
    stats.framesOut++;
    countType(net, frame.kind, 'out', frame.length);
    send(frame);
  };
  // outbound budget from the remote's announced inbound limits (null: send at once)
  let bucket = null;
  const queue = [];
  let queuedBytes = 0;
  let drainTimer = null;
  const drain = () => {
    drainTimer = null;
    if (!open) return;
    const now = Date.now();
    const elapsed = (now - bucket.at) / 1000;
    bucket.at = now;
    bucket.frames = Math.min(bucket.burstFrames, bucket.frames + elapsed * bucket.rateFrames);
    bucket.bytes = Math.min(bucket.burstBytes, bucket.bytes + elapsed * bucket.rateBytes);
    while (queue.length) {
      const frame = queue[0];
      const cost = Math.min(frame.length, bucket.burstBytes); // a frame above the burst goes once the bucket is full
      const units = Math.min(frame.units, bucket.burstFrames); // a `recs` frame costs one per record
      if (bucket.frames < units || bucket.bytes < cost) {
        const wait = Math.max((units - bucket.frames) / bucket.rateFrames, (cost - bucket.bytes) / bucket.rateBytes, 0);
        drainTimer = setTimeout(drain, Math.max(5, Math.ceil(wait * 1000)));
        return;
      }
      bucket.frames -= units;
      bucket.bytes -= cost;
      queue.shift();
      queuedBytes -= frame.length;
      transmit(frame);
    }
  };
  const sendFrame = (type, payload) => {
    if (!open) return;
    const frame = encodeFrame(type, payload);
    frame.kind = type;
    if (!bucket) return transmit(frame);
    frame.units = type === 'recs' ? frameUnits(frame) : 1;
    queue.push(frame);
    queuedBytes += frame.length;
    if (!drainTimer) drain();
  };
  /** @returns {object|null} a send budget below the remote's announced limits, or null if none/invalid */
  const budgetFor = (limits) => {
    const ok = (b) => b && Number.isFinite(b.rate) && Number.isFinite(b.burst) && b.rate > 0 && b.burst > 0;
    if (!limits || !ok(limits.frames) || !ok(limits.bytes)) return null;
    const rateFrames = Math.max(1, limits.frames.rate * 0.8);
    const rateBytes = Math.max(1024, limits.bytes.rate * 0.8);
    const burstFrames = Math.max(1, limits.frames.burst / 2);
    const burstBytes = Math.max(1024, limits.bytes.burst / 2);
    return { rateFrames, rateBytes, burstFrames, burstBytes, frames: burstFrames, bytes: burstBytes, at: Date.now() };
  };
  const refuse = (reason) => {
    qu.bus.notify('net.error', { via, reason, peer: remote });
    close();
  };
  sendFrame('hi', { peer: localId ?? qu.peerId, v: PROTOCOL_VERSION, ...(net.inbound ? { limits: net.inbound } : {}) });
  // a remote that never says hi would hold the socket (and a relay slot) forever
  let helloTimer = net.helloTimeoutMs > 0 ? setTimeout(() => !remote && open && refuse('no hello'), net.helloTimeoutMs) : null;
  helloTimer?.unref?.();

  const link = {
    stats,
    get peer() {
      return remote;
    },
    receive(bytes) {
      if (!open) return;
      stats.received += bytes.length;
      stats.framesIn++;
      let type;
      try {
        type = peekFrameType(bytes);
      } catch {
        countType(net, 'other', 'in', bytes.length);
        return qu.bus.notify('net.error', { via, reason: 'bad frame', peer: remote });
      }
      countType(net, type, 'in', bytes.length);
      if (!remote && type !== 'hi') {
        if (++early > MAX_EARLY_FRAMES) refuse('no hello');
        return;
      }
      if (remote && type !== 'hi') {
        // the guard (rate limits) decides on type and size - before any parsing work
        const verdict = net.guard ? net.guard(remote, type, bytes.length, type === 'recs' ? frameUnits(bytes) : 1) : true;
        if (verdict === 'close') return close();
        if (verdict === false) return;
      }
      if (!FRAME_TYPE.test(type)) return qu.bus.notify('net.error', { via, reason: 'bad type', peer: remote });
      if (type !== 'hi' && remote) {
        inbox.push({ bytes, peer: remote });
        inboxBytes += bytes.length;
        if (!paused && inboxBytes > INBOUND_HIGH && pause) {
          paused = true;
          pause();
          qu.bus.notify('net.paused', { peer: remote, via, queued: inbox.length, bytes: inboxBytes });
        }
        return pump();
      }
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        return qu.bus.notify('net.error', { via, reason: 'bad frame', peer: remote });
      }
      if (frame.type === 'hi') {
        if (remote) return;
        const peer = String(frame.payload?.peer ?? '');
        if (!/^[0-9a-f]{16}$/.test(peer)) return close();
        const version = frame.payload?.v ?? 1;
        if (!Number.isInteger(version) || version < 1 || version > PROTOCOL_VERSION) return refuse('protocol');
        clearTimeout(helloTimer);
        helloTimer = null;
        remote = localId ? xorHex(peer, localId) : peer;
        net.links.get(remote)?.drop(); // newest wins - never two links under one name
        if (scope) net.scopes.set(remote, new Set(scope));
        bucket = budgetFor(frame.payload?.limits);
        net.links.set(remote, {
          via,
          since: Date.now(),
          stats,
          version,
          /** bytes not yet on the wire: queued for the budget + the transport's own buffer */
          buffered: () => queuedBytes + (buffered?.() ?? 0),
          maxBuffered,
          /** frames waiting for the send budget, and how many may wait (half a second of budget) */
          backlog: () => queue.length,
          backlogLimit: bucket ? Math.max(8, Math.floor(bucket.rateFrames / 2)) : Infinity,
          budget: bucket ? { frames: bucket.rateFrames, bytes: bucket.rateBytes, burst: bucket.burstFrames } : null,
          /** inbound processing: frames running, waiting (count, bytes), reading paused */
          inbound: () => ({ inflight, queued: inbox.length, bytes: inboxBytes, paused }),
          drop: () => (link.closed(), close()),
        });
        off = qu.bus.on(`net.out.${remote}.*`, (payload, ctx) => sendFrame(ctx.topic.split('.')[3], payload));
        onUp?.(remote);
        qu.bus.notify('net.peer.up', { peer: remote, via });
        return;
      }
    },
    closed() {
      if (!open) return;
      open = false;
      clearTimeout(helloTimer);
      clearTimeout(drainTimer);
      queue.length = 0;
      queuedBytes = 0;
      if (paused) {
        paused = false;
        resume?.(); // frames already queued are still processed (they arrived before the close)
      }
      off?.();
      if (remote) {
        if (scope) net.scopes.delete(remote);
        if (net.links.get(remote)?.stats === stats) net.links.delete(remote);
        qu.bus.notify('net.peer.down', { peer: remote, via, stats: { ...stats } });
      }
      remote = null;
      onDown?.();
    },
    close() {
      close();
    },
  };
  return link;
}

const PACE_CEILING = 4 * 1024 * 1024;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves when `peer`'s link has room for more bulk data: at once if its
 * send buffer is below the high-water mark (or the transport cannot tell)
 * and at most half a second of frames waits for the send budget, otherwise
 * once both drained (buffer below the low-water mark, backlog halved).
 * @param {object} qu @param {string} peer
 * @param {{pollMs?: number, maxWaitMs?: number}} [options]
 * @returns {Promise<boolean>} false if the link went away (or stayed full for `maxWaitMs`) - stop sending then
 */
export async function whenWritable(qu, peer, { pollMs = 10, maxWaitMs = 120_000 } = {}) {
  const link = qu.net?.links.get(peer);
  if (!link) return false;
  const high = Math.min(PACE_CEILING, link.maxBuffered > 0 ? link.maxBuffered / 4 : PACE_CEILING);
  const low = high / 4;
  const buffered = () => (typeof link.buffered === 'function' ? link.buffered() : 0);
  const backlog = () => (typeof link.backlog === 'function' ? link.backlog() : 0);
  const limit = link.backlogLimit ?? Infinity;
  if (buffered() <= high && backlog() <= limit) return true;
  const end = Date.now() + maxWaitMs;
  while (qu.net.links.get(peer) === link && (buffered() > low || backlog() > limit / 2)) {
    if (Date.now() > end) return false;
    await pause(pollMs);
  }
  return qu.net.links.get(peer) === link;
}
