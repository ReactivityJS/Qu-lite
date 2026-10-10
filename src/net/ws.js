/**
 * WEBSOCKET BRIDGE - the same contract as `inproc.js`, over a real socket:
 * `net.out.<peer>.<type>` goes out as a binary frame (frame.js), incoming
 * frames are emitted as `net.in.<peer>.<type>`, and `net.peer.up/down`
 * bracket the connection. The first frame each side sends is `hi {peer}`,
 * which is how the remote peer id becomes known.
 *
 * `attachSocket()` works with any WHATWG-style socket (browser WebSocket,
 * Node >= 22's global WebSocket, or a `ws` server-side socket).
 * `connectWs()` adds automatic reconnect with exponential backoff + jitter
 * (and an immediate retry on the browser's `online` event).
 * The server side lives in `ws-server.js` (it needs the `ws` package).
 */
import { encodeFrame, decodeFrame } from './frame.js';

const OPEN = 1;

/**
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} qu
 * @param {WebSocket} socket
 * @param {{via?: string, onUp?: (peer: string) => void, onDown?: () => void}} [options]
 * @returns {{close: () => void, stats: {sent: number, received: number}}}
 */
export function attachSocket(qu, socket, { via = 'ws', onUp, onDown } = {}) {
  const stats = { sent: 0, received: 0 };
  let remote = null;
  let off = null;
  socket.binaryType = 'arraybuffer';

  const sendFrame = (type, payload) => {
    if (socket.readyState !== OPEN) return;
    const frame = encodeFrame(type, payload);
    stats.sent += frame.length;
    socket.send(frame);
  };
  const hello = () => sendFrame('hi', { peer: qu.peerId });
  if (socket.readyState === OPEN) hello();
  else socket.addEventListener('open', hello);

  socket.addEventListener('message', (event) => {
    const data = event.data;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return;
    stats.received += bytes.length;
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return qu.bus.notify('net.error', { via, reason: 'bad frame' });
    }
    if (frame.type === 'hi') {
      if (remote) return;
      remote = String(frame.payload?.peer ?? '');
      if (!/^[0-9a-f]{16}$/.test(remote)) return socket.close();
      off = qu.bus.on(`net.out.${remote}.*`, (payload, ctx) => sendFrame(ctx.topic.split('.')[3], payload));
      onUp?.(remote);
      qu.bus.notify('net.peer.up', { peer: remote, via });
      return;
    }
    if (remote) qu.bus.emit(`net.in.${remote}.${frame.type}`, frame.payload);
  });

  socket.addEventListener('close', () => {
    if (remote) {
      off?.();
      qu.bus.notify('net.peer.down', { peer: remote, via });
      remote = null;
    }
    onDown?.();
  });
  socket.addEventListener('error', () => {});

  return { stats, close: () => socket.close() };
}

/**
 * Client connection that keeps itself alive.
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} qu
 * @param {string} url
 * @param {{WebSocketImpl?: typeof WebSocket, minDelayMs?: number, maxDelayMs?: number}} [options]
 * @returns {{close: () => void, readonly connected: boolean, readonly peer: string|null}}
 */
export function connectWs(qu, url, { WebSocketImpl = globalThis.WebSocket, minDelayMs = 500, maxDelayMs = 30_000 } = {}) {
  let closed = false;
  let attempt = 0;
  let socket = null;
  let peer = null;
  let timer = null;

  const open = () => {
    clearTimeout(timer);
    if (closed || (socket && socket.readyState <= OPEN)) return;
    qu.bus.notify('net.connecting', { url, attempt });
    socket = new WebSocketImpl(url);
    attachSocket(qu, socket, {
      onUp: (remote) => {
        attempt = 0;
        peer = remote;
      },
      onDown: () => {
        peer = null;
        if (closed) return;
        const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt++) * (0.5 + Math.random() / 2);
        timer = setTimeout(open, delay);
        timer.unref?.();
      },
    });
  };

  const onOnline = () => {
    attempt = 0;
    open();
  };
  globalThis.addEventListener?.('online', onOnline);
  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      globalThis.removeEventListener?.('online', onOnline);
      socket?.close();
    },
    get connected() {
      return peer !== null;
    },
    get peer() {
      return peer;
    },
  };
}
