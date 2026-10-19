/**
 * HTTP SERVER TRANSPORT (Node) - one port for everything a relay offers:
 *
 *   WebSocket upgrade (any path, e.g. /ws)   -> peers (ws.js attachSocket)
 *   GET/POST /sse/<session>                  -> peers via HTTPS + SSE (sse-server.js)
 *   GET /healthz                             -> 200 "ok" (reverse proxy / container health)
 *   GET /info                                -> {name, version, transports, uptime} (no space data)
 *   GET /stats, /metrics                     -> operating figures as JSON / Prometheus text
 *                                               (stats.js), only with `statsToken` - sent as
 *                                               `Authorization: Bearer <token>` or `?token=`;
 *                                               behind a proxy every request comes from
 *                                               localhost, so an address check would mean nothing
 *   anything else                            -> static files (`static`): the client start
 *                                               page, the demo, the browser bundle (web/)
 *
 * Both transports end in the same `createLink`. Made to sit behind a reverse
 * proxy doing TLS (wss:// and https:// on one origin, also under a path
 * prefix the proxy strips): WebSocket clients are pinged every `pingMs`, so
 * idle connections survive proxy read timeouts (nginx: 60 s) and dead ones
 * are noticed and closed; SSE streams carry their own keep-alive.
 *
 *   qu.use(httpServerTransport({ port: 8787, static: './web' }))   // ws + sse
 *
 * Import from `@qu/lite/ws-server` or `@qu/lite/node` - needs the `ws`
 * package, never in browsers.
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { attachSocket } from './ws.js';
import { createSseHandler } from './sse-server.js';

const VERSION = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
/** Sent with every static file: no MIME sniffing, invite links (#fragment) never leak via Referer anyway. */
const HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };

function staticHandler(dir) {
  const root = resolve(dir);
  return async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(root, path));
      // inside root - with a separator, or `/app/web-secret` would pass as "starting with /app/web"
      if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  };
}

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{port?: number, host?: string, server?: import('node:http').Server, static?: string, ws?: boolean, sse?: boolean|object, pingMs?: number}} [options]
 *   `pingMs`: WebSocket heartbeat (0 = off); a client that did not answer the previous ping is closed.
 *   `statsToken`: enables /stats and /metrics (needs the stats plugin) for requests carrying this token.
 *   `maxFrameBytes`: largest WebSocket message accepted (bigger: connection closed, 1009) - the `ws`
 *   default of 100 MiB would let any client make the relay buffer that much before rate limits apply.
 * @returns {Promise<{port: number, close: () => Promise<void>, wss: WebSocketServer|null}>}
 */
export async function listenHttp(qu, { port = 0, host, server, static: dir, ws = true, sse = true, pingMs = 25_000, statsToken, maxFrameBytes = 8 * 1024 * 1024 } = {}) {
  const ownServer = !server;
  const sseHandler = sse ? createSseHandler(qu, typeof sse === 'object' ? sse : {}) : null;
  const files = dir ? staticHandler(dir) : null;
  const started = Date.now();
  const transports = [...(ws ? ['ws'] : []), ...(sse ? ['sse'] : [])];
  const onRequest = (req, res) => {
    if (sseHandler?.(req, res)) return;
    const path = new URL(req.url, 'http://x').pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/healthz') return res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
    if (req.method === 'GET' && path === '/info') {
      const info = { name: 'qu-lite', version: VERSION, transports, uptime: Math.round((Date.now() - started) / 1000) };
      return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(info));
    }
    if (req.method === 'GET' && (path === '/stats' || path === '/metrics')) return serveStats(req, res, path);
    if (files) return files(req, res);
    res.writeHead(ws ? 426 : 404, { 'content-type': 'text/plain' }).end(ws ? 'websocket or sse only' : 'not found');
  };
  // constant-time token check (hashes have equal length)
  const digest = (text) => createHash('sha256').update(String(text)).digest();
  const authorized = (req) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : (new URL(req.url, 'http://x').searchParams.get('token') ?? '');
    return timingSafeEqual(digest(given), digest(statsToken));
  };
  async function serveStats(req, res, path) {
    const headers = { 'cache-control': 'no-store' };
    if (!statsToken || !qu.stats) return res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found');
    if (!authorized(req)) return res.writeHead(401, { ...headers, 'content-type': 'text/plain', 'www-authenticate': 'Bearer' }).end('token required');
    try {
      if (path === '/metrics') return res.writeHead(200, { ...headers, 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(await qu.stats.prometheus());
      return res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(await qu.stats.report()));
    } catch (error) {
      return res.writeHead(500, { ...headers, 'content-type': 'text/plain' }).end(error.message);
    }
  }
  server = server ?? createServer();
  server.on('request', onRequest);
  const wss = ws ? new WebSocketServer({ server, perMessageDeflate: false, maxPayload: maxFrameBytes }) : null;
  const refuseUpgrade = (req, socket) => socket.destroy();
  if (!ws) server.on('upgrade', refuseUpgrade);
  wss?.on('connection', (socket) => {
    socket.alive = true;
    socket.on('pong', () => (socket.alive = true));
    attachSocket(qu, socket, { via: 'ws-server' });
  });
  // heartbeat: keeps idle connections open through proxies, closes the ones that went silent
  const heartbeat =
    wss && pingMs > 0
      ? setInterval(() => {
          for (const socket of wss.clients) {
            if (!socket.alive) {
              socket.terminate();
              continue;
            }
            socket.alive = false;
            socket.ping();
          }
        }, pingMs)
      : null;
  heartbeat?.unref?.();
  if (ownServer) await new Promise((ok, fail) => server.once('error', fail).listen(port, host, ok));
  return {
    wss,
    port: server.address().port,
    close: () =>
      new Promise((done) => {
        sseHandler?.close();
        clearInterval(heartbeat);
        server.off('request', onRequest);
        server.off('upgrade', refuseUpgrade);
        const finish = () => {
          if (!ownServer) return done();
          server.close(() => done());
          server.closeAllConnections?.(); // keep-alive sockets of SSE posts would hold close() open
        };
        if (!wss) return finish();
        for (const client of wss.clients) client.terminate();
        wss.close(finish);
      }),
  };
}

/** WebSocket only (kept for callers that want exactly that). */
export const listenWs = (qu, options = {}) => listenHttp(qu, { sse: false, ...options });

/**
 * Plugin form; `ready` resolves with `{port}` once listening. Registered as
 * 'http-server' (WebSocket + SSE) and 'ws-server' (same, for compatibility).
 */
export function httpServerTransport(options = {}) {
  return (qu) => {
    const ready = listenHttp(qu, options);
    const api = { ready, close: async () => (await ready).close() };
    qu.transports = { ...qu.transports, 'http-server': api, 'ws-server': api };
    return api;
  };
}

export const wsServerTransport = httpServerTransport;
