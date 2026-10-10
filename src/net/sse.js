/**
 * HTTPS + SSE CLIENT - the fallback relay transport (see sse-server.js).
 * Down: one long-lived `fetch` of `<base>/<session>` read as an event
 * stream (fetch streaming works in browsers and Node, no EventSource
 * needed). Up: frames are batched per tick and POSTed in order.
 *
 *   qu.use(sseTransport({ connect: ['https://relay.example/sse'] }))
 *
 * Reconnects with backoff + jitter like the WebSocket client, with a fresh
 * random session id each time.
 */
import { createLink } from './link.js';
import { packFrames } from './sse-frames.js';
import { toHex, randomBytes, fromBase64 } from '../crypto.js';

/**
 * One self-healing SSE connection.
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {string} base - e.g. 'https://relay.example/sse'
 * @param {{fetchImpl?: typeof fetch, minDelayMs?: number, maxDelayMs?: number}} [options]
 */
export function connectSse(qu, base, { fetchImpl = globalThis.fetch, minDelayMs = 500, maxDelayMs = 30_000 } = {}) {
  let closed = false;
  let attempt = 0;
  let peer = null;
  let timer = null;
  let abort = null;
  let running = false;

  const schedule = () => {
    if (closed) return;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt++) * (0.5 + Math.random() / 2);
    timer = setTimeout(open, delay);
    timer.unref?.();
  };

  async function open() {
    clearTimeout(timer);
    if (closed || running) return;
    running = true;
    const session = toHex(randomBytes(16));
    const url = `${base.replace(/\/$/, '')}/${session}`;
    const controller = new AbortController();
    abort = () => controller.abort();
    let link = null;
    let queue = [];
    let sending = Promise.resolve();
    const flush = () => {
      if (!queue.length) return;
      const batch = packFrames(queue);
      queue = [];
      sending = sending
        .then(() => fetchImpl(url, { method: 'POST', body: batch, headers: { 'content-type': 'application/octet-stream' } }))
        .then((res) => {
          if (!res.ok) throw new Error(`sse post ${res.status}`);
        })
        .catch(() => controller.abort());
    };
    try {
      qu.bus.notify('net.connecting', { url: base, attempt, via: 'sse' });
      const res = await fetchImpl(url, { headers: { accept: 'text/event-stream' }, cache: 'no-store', signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
      link = createLink(qu, {
        send: (bytes) => {
          if (!queue.length) queueMicrotask(flush);
          queue.push(bytes);
        },
        close: () => controller.abort(),
        via: 'sse',
        onUp: (remote) => {
          attempt = 0;
          peer = remote;
        },
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let data = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line === '') {
            if (data) link.receive(fromBase64(data));
            data = '';
          } else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
      }
    } catch {
      // network error, abort or server gone - handled below
    } finally {
      running = false;
      peer = null;
      link?.closed();
      schedule();
    }
  }

  const onOnline = () => {
    attempt = 0;
    open();
  };
  globalThis.addEventListener?.('online', onOnline);
  open();

  return {
    url: base,
    close() {
      closed = true;
      clearTimeout(timer);
      globalThis.removeEventListener?.('online', onOnline);
      abort?.();
    },
    get connected() {
      return peer !== null;
    },
    get peer() {
      return peer;
    },
  };
}

/** The plugin: keeps a set of SSE endpoints connected. Same shape as wsTransport. */
export function sseTransport({ connect = [], ...options } = {}) {
  return (qu) => {
    const conns = new Map();
    const api = {
      connect(url) {
        if (!conns.has(url)) conns.set(url, connectSse(qu, url, options));
        return conns.get(url);
      },
      disconnect(url) {
        for (const [u, c] of conns) {
          if (url && u !== url) continue;
          c.close();
          conns.delete(u);
        }
      },
      status: () => [...conns.values()].map((c) => ({ url: c.url, connected: c.connected, peer: c.peer, via: 'sse' })),
    };
    for (const url of connect) api.connect(url);
    qu.transports = { ...qu.transports, sse: api };
    return api;
  };
}
