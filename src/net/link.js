/**
 * LINK - the transport-independent half of every connection. A transport
 * plugin (WebSocket, later WebRTC DataChannel or HTTPS+SSE, in-process for
 * tests) only moves bytes; everything Qu-specific lives here once:
 *
 *   - the `hi {peer}` handshake (the network id - never the identity),
 *   - framing (frame.js: binary, no base64),
 *   - `net.out.<remote>.<type>` -> send, received frames -> `net.in.<remote>.<type>`,
 *   - `net.peer.up` / `net.peer.down`, byte counters,
 *   - the inbound guard `qu.net.guard(peer, type, size)` (limits.js): false
 *     drops a frame, 'close' closes the link,
 *   - SCOPED links (`scope`: a set of sids, own `localId`): one connection
 *     per space, so a relay can't tell which spaces belong to one device.
 *     The remote is then named `xor(remote, localId)` on the bus, so several
 *     links to the same relay don't collide; `qu.net.allows(peer, sid)` tells
 *     sync/envelopes what may travel over which link.
 *
 * Contract for a transport: call `createLink(qu, {send, close, via})` when a
 * byte channel opens, feed every incoming message to `link.receive(bytes)`
 * and call `link.closed()` when the channel goes away.
 */
import { encodeFrame, decodeFrame } from './frame.js';

/**
 * The per-Qu network registry (created on first use): which link may carry
 * which space, plus the optional inbound guard.
 * @returns {{scopes: Map<string, Set<string>>, isolated: Set<string>, allows: (peer: string, sid: string) => boolean, guard?: Function, exclusive?: boolean}}
 */
export function netOf(qu) {
  if (!qu.net) {
    const scopes = new Map();
    const isolated = new Set();
    qu.net = {
      scopes,
      isolated,
      /** A scoped link carries only its sids; a shared link no isolated sid. */
      allows: (peer, sid) => (scopes.has(peer) ? scopes.get(peer).has(sid) : !isolated.has(sid)),
    };
  }
  return qu.net;
}

const xorHex = (a, b) => Array.from({ length: a.length }, (_, i) => (parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16)).join('');

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{send: (bytes: Uint8Array) => void, close?: () => void, via?: string, onUp?: (peer: string) => void, onDown?: () => void, localId?: string, scope?: Iterable<string>}} transport
 * @returns {{receive: (bytes: Uint8Array) => void, closed: () => void, close: () => void, stats: {sent: number, received: number}, readonly peer: string|null}}
 */
export function createLink(qu, { send, close = () => {}, via = 'link', onUp, onDown, localId, scope }) {
  const net = netOf(qu);
  const stats = { sent: 0, received: 0 };
  let remote = null;
  let off = null;
  let open = true;

  const sendFrame = (type, payload) => {
    if (!open) return;
    const frame = encodeFrame(type, payload);
    stats.sent += frame.length;
    send(frame);
  };
  sendFrame('hi', { peer: localId ?? qu.peerId });

  return {
    stats,
    get peer() {
      return remote;
    },
    receive(bytes) {
      if (!open) return;
      stats.received += bytes.length;
      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch {
        return qu.bus.notify('net.error', { via, reason: 'bad frame' });
      }
      if (frame.type === 'hi') {
        if (remote) return;
        const peer = String(frame.payload?.peer ?? '');
        if (!/^[0-9a-f]{16}$/.test(peer)) return close();
        remote = localId ? xorHex(peer, localId) : peer;
        if (scope) net.scopes.set(remote, new Set(scope));
        off = qu.bus.on(`net.out.${remote}.*`, (payload, ctx) => sendFrame(ctx.topic.split('.')[3], payload));
        onUp?.(remote);
        qu.bus.notify('net.peer.up', { peer: remote, via });
        return;
      }
      if (!remote) return;
      const verdict = net.guard ? net.guard(remote, frame.type, bytes.length) : true;
      if (verdict === 'close') return close();
      if (verdict === false) return;
      qu.bus.emit(`net.in.${remote}.${frame.type}`, frame.payload);
    },
    closed() {
      if (!open) return;
      open = false;
      off?.();
      if (remote) {
        if (scope) net.scopes.delete(remote);
        qu.bus.notify('net.peer.down', { peer: remote, via });
      }
      remote = null;
      onDown?.();
    },
    close() {
      close();
    },
  };
}
