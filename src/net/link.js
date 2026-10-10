/**
 * LINK - the transport-independent half of every connection. A transport
 * plugin (WebSocket, later WebRTC DataChannel or HTTPS+SSE, in-process for
 * tests) only moves bytes; everything Qu-specific lives here once:
 *
 *   - the `hi {peer}` handshake (the network id - never the identity),
 *   - framing (frame.js: binary, no base64),
 *   - `net.out.<remote>.<type>` -> send, received frames -> `net.in.<remote>.<type>`,
 *   - `net.peer.up` / `net.peer.down`, byte counters.
 *
 * Contract for a transport: call `createLink(qu, {send, close, via})` when a
 * byte channel opens, feed every incoming message to `link.receive(bytes)`
 * and call `link.closed()` when the channel goes away.
 */
import { encodeFrame, decodeFrame } from './frame.js';

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{send: (bytes: Uint8Array) => void, close?: () => void, via?: string, onUp?: (peer: string) => void, onDown?: () => void}} transport
 * @returns {{receive: (bytes: Uint8Array) => void, closed: () => void, close: () => void, stats: {sent: number, received: number}, readonly peer: string|null}}
 */
export function createLink(qu, { send, close = () => {}, via = 'link', onUp, onDown }) {
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
  sendFrame('hi', { peer: qu.peerId });

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
        remote = peer;
        off = qu.bus.on(`net.out.${remote}.*`, (payload, ctx) => sendFrame(ctx.topic.split('.')[3], payload));
        onUp?.(remote);
        qu.bus.notify('net.peer.up', { peer: remote, via });
        return;
      }
      if (remote) qu.bus.emit(`net.in.${remote}.${frame.type}`, frame.payload);
    },
    closed() {
      if (!open) return;
      open = false;
      off?.();
      if (remote) qu.bus.notify('net.peer.down', { peer: remote, via });
      remote = null;
      onDown?.();
    },
    close() {
      close();
    },
  };
}
