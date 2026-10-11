/**
 * WEBSOCKET TRANSPORT (client) - a byte channel for `createLink` (link.js).
 * Works with any WHATWG-style socket: the browser's WebSocket, Node >= 22's
 * global WebSocket, or a `ws` server-side socket (ws-server.js).
 *
 *   qu.use(wsTransport({ connect: ['wss://relay.example/ws'] }))
 *
 * Each URL is kept alive: reconnect with exponential backoff + jitter, and
 * immediately on the browser's `online` event. `qu.transports.ws` exposes
 * connect()/disconnect()/status for UIs.
 */
import { createLink } from './link.js';

const OPEN = 1;

/**
 * Wires one already-created socket into a link.
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {WebSocket} socket
 * @param {{via?: string, onUp?: (peer: string) => void, onDown?: () => void, localId?: string, scope?: Iterable<string>}} [options]
 *   `localId`/`scope`: a scoped link (link.js) - one connection per space.
 */
export function attachSocket(qu, socket, { via = 'ws', onUp, onDown, localId, scope } = {}) {
  socket.binaryType = 'arraybuffer';
  let link = null;
  const start = () => {
    link = createLink(qu, { send: (bytes) => socket.readyState === OPEN && socket.send(bytes), close: () => socket.close(), via, onUp, onDown, localId, scope });
  };
  if (socket.readyState === OPEN) start();
  else socket.addEventListener('open', start);
  socket.addEventListener('message', (event) => {
    const data = event.data;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes && link) link.receive(bytes);
  });
  // Exactly one "down" per socket. Some implementations (Node's built-in
  // WebSocket) report a refused upgrade with 'error' only, never 'close'.
  let down = false;
  const fail = () => {
    if (down) return;
    down = true;
    if (link) link.closed();
    else onDown?.();
  };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', () => {
    if (!link) fail();
  });
  return {
    get stats() {
      return link?.stats ?? { sent: 0, received: 0 };
    },
    close: () => socket.close(),
    /** Treats the socket as failed now (e.g. it hangs while connecting). */
    fail: () => {
      try {
        socket.close();
      } catch {}
      fail();
    },
  };
}

/**
 * One self-healing client connection.
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {string} url
 * @param {{WebSocketImpl?: typeof WebSocket, minDelayMs?: number, maxDelayMs?: number, connectTimeoutMs?: number, localId?: string, scope?: Iterable<string>, onConnecting?: (attempt: number) => void}} [options]
 * @returns {{close: () => void, readonly connected: boolean, readonly peer: string|null, readonly url: string}}
 */
export function connectWs(qu, url, { WebSocketImpl = globalThis.WebSocket, minDelayMs = 500, maxDelayMs = 30_000, connectTimeoutMs = 10_000, localId, scope, onConnecting } = {}) {
  let closed = false;
  let attempt = 0;
  let socket = null;
  let peer = null;
  let timer = null;

  const open = () => {
    clearTimeout(timer);
    if (closed || (socket && socket.readyState === OPEN)) return;
    qu.bus.notify('net.connecting', { url, attempt });
    onConnecting?.(attempt);
    const current = (socket = new WebSocketImpl(url));
    // A blocked WebSocket often neither opens nor fails (a proxy just holds it): give up after a while.
    const guard = setTimeout(() => current.readyState !== OPEN && attached.fail(), connectTimeoutMs);
    guard.unref?.();
    const attached = attachSocket(qu, socket, {
      localId,
      scope,
      onUp: (remote) => {
        clearTimeout(guard);
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
    url,
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

/**
 * The plugin: keeps a set of relay URLs connected.
 * @param {{connect?: string[], minDelayMs?: number, maxDelayMs?: number, WebSocketImpl?: typeof WebSocket}} [options]
 */
export function wsTransport({ connect = [], ...options } = {}) {
  return (qu) => {
    const conns = new Map();
    const api = {
      /** @param {string} url */
      connect(url) {
        if (!conns.has(url)) conns.set(url, connectWs(qu, url, options));
        return conns.get(url);
      },
      /** @param {string} [url] - default: all */
      disconnect(url) {
        for (const [u, c] of conns) {
          if (url && u !== url) continue;
          c.close();
          conns.delete(u);
        }
      },
      status: () => [...conns.values()].map((c) => ({ url: c.url, connected: c.connected, peer: c.peer })),
    };
    for (const url of connect) api.connect(url);
    qu.transports = { ...qu.transports, ws: api };
    return api;
  };
}
