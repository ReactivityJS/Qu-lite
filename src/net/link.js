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
import { encodeFrame, decodeFrame, peekFrameType } from './frame.js';

/** Wire protocol version sent in `hi`. Bump on incompatible changes; a peer without `v` speaks 1. */
export const PROTOCOL_VERSION = 1;
/** Frame types are bus topic segments: no dots, no wildcards. */
const FRAME_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
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
 * @param {{send: (bytes: Uint8Array) => void, close?: () => void, via?: string, onUp?: (peer: string) => void, onDown?: () => void, localId?: string, scope?: Iterable<string>}} transport
 * @returns {{receive: (bytes: Uint8Array) => void, closed: () => void, close: () => void, stats: {sent: number, received: number, framesOut: number, framesIn: number}, readonly peer: string|null}}
 */
export function createLink(qu, { send, close = () => {}, via = 'link', onUp, onDown, localId, scope, buffered = null, maxBuffered = 0 }) {
  const net = netOf(qu);
  const stats = { sent: 0, received: 0, framesOut: 0, framesIn: 0 };
  let remote = null;
  let off = null;
  let open = true;

  let early = 0;
  const sendFrame = (type, payload) => {
    if (!open) return;
    const frame = encodeFrame(type, payload);
    stats.sent += frame.length;
    stats.framesOut++;
    send(frame);
  };
  const refuse = (reason) => {
    qu.bus.notify('net.error', { via, reason, peer: remote });
    close();
  };
  sendFrame('hi', { peer: localId ?? qu.peerId, v: PROTOCOL_VERSION });
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
        return qu.bus.notify('net.error', { via, reason: 'bad frame', peer: remote });
      }
      if (!remote && type !== 'hi') {
        if (++early > MAX_EARLY_FRAMES) refuse('no hello');
        return;
      }
      if (remote && type !== 'hi') {
        // the guard (rate limits) decides on type and size - before any parsing work
        const verdict = net.guard ? net.guard(remote, type, bytes.length) : true;
        if (verdict === 'close') return close();
        if (verdict === false) return;
      }
      if (!FRAME_TYPE.test(type)) return qu.bus.notify('net.error', { via, reason: 'bad type', peer: remote });
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
        net.links.set(remote, { via, since: Date.now(), stats, version, buffered, maxBuffered, drop: () => (link.closed(), close()) });
        off = qu.bus.on(`net.out.${remote}.*`, (payload, ctx) => sendFrame(ctx.topic.split('.')[3], payload));
        onUp?.(remote);
        qu.bus.notify('net.peer.up', { peer: remote, via });
        return;
      }
      qu.bus.emit(`net.in.${remote}.${frame.type}`, frame.payload);
    },
    closed() {
      if (!open) return;
      open = false;
      clearTimeout(helloTimer);
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
 * send buffer is below the high-water mark (or the transport cannot tell),
 * otherwise once the buffer drained below the low-water mark.
 * @param {object} qu @param {string} peer
 * @param {{pollMs?: number, maxWaitMs?: number}} [options]
 * @returns {Promise<boolean>} false if the link went away (or stayed full for `maxWaitMs`) - stop sending then
 */
export async function whenWritable(qu, peer, { pollMs = 10, maxWaitMs = 120_000 } = {}) {
  const link = qu.net?.links.get(peer);
  if (!link) return false;
  if (typeof link.buffered !== 'function') return true;
  const high = Math.min(PACE_CEILING, link.maxBuffered > 0 ? link.maxBuffered / 4 : PACE_CEILING);
  if (link.buffered() <= high) return true;
  const low = high / 4;
  const end = Date.now() + maxWaitMs;
  while (qu.net.links.get(peer) === link && link.buffered() > low) {
    if (Date.now() > end) return false;
    await pause(pollMs);
  }
  return qu.net.links.get(peer) === link;
}
