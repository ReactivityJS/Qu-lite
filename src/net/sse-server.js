/**
 * HTTPS + SSE SERVER - the fallback relay transport where WebSockets are
 * blocked (some proxies, corporate networks). Plain HTTP only:
 *
 *   GET  <path>/<session>   text/event-stream; every event is one link frame
 *                           (base64). Opening it creates the link.
 *   POST <path>/<session>   application/octet-stream; one or more frames
 *                           (u32 length || frame) for that link.
 *
 * The session id is 128 random bits chosen by the client and only valid
 * while its event stream is open, so nobody else can inject into it. Above
 * the byte channel it is the same `createLink` as every transport.
 *
 * `createSseHandler(qu)` returns `(req, res) => boolean` (true = handled),
 * mounted by http-server.js next to the WebSocket upgrade and static files.
 */
import { createLink } from './link.js';
import { unpackFrames, SESSION } from './sse-frames.js';

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{path?: string, keepAliveMs?: number, maxBodyBytes?: number, cors?: string}} [options]
 */
export function createSseHandler(qu, { path = '/sse', keepAliveMs = 15_000, maxBodyBytes = 1 << 20, cors = '*' } = {}) {
  /** @type {Map<string, {link: object, res: import('node:http').ServerResponse}>} */
  const sessions = new Map();
  const headers = { 'access-control-allow-origin': cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

  function open(session, req, res) {
    sessions.get(session)?.res.end(); // a reconnect with the same id replaces the old stream
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': qu-lite\n\n');
    const link = createLink(qu, { send: (bytes) => res.write(`data:${toBase64(bytes)}\n\n`), close: () => res.end(), via: 'sse' });
    const entry = { link, res };
    sessions.set(session, entry);
    const keepAlive = setInterval(() => res.write(':\n\n'), keepAliveMs);
    keepAlive.unref?.();
    const done = () => {
      clearInterval(keepAlive);
      if (sessions.get(session) === entry) sessions.delete(session);
      link.closed();
    };
    req.on('close', done);
    res.on('close', done);
  }

  function post(session, req, res) {
    const entry = sessions.get(session);
    if (!entry) return res.writeHead(404, headers).end('no such session');
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        res.writeHead(413, headers).end();
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        for (const frame of unpackFrames(new Uint8Array(Buffer.concat(chunks)))) entry.link.receive(frame);
        res.writeHead(204, headers).end();
      } catch {
        res.writeHead(400, headers).end('bad frames');
      }
    });
  }

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(`${path}/`)) return false;
    const session = url.pathname.slice(path.length + 1);
    if (req.method === 'OPTIONS') res.writeHead(204, headers).end();
    else if (!SESSION.test(session)) res.writeHead(400, headers).end('bad session');
    else if (req.method === 'GET') open(session, req, res);
    else if (req.method === 'POST') post(session, req, res);
    else res.writeHead(405, headers).end();
    return true;
  };
  handler.close = () => {
    for (const { res } of sessions.values()) res.end();
    sessions.clear();
  };
  return handler;
}
