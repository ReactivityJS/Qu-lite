/**
 * HTTP SERVER TRANSPORT (Node) - one port for everything a relay offers:
 *
 *   WebSocket upgrade (any path, e.g. /ws)   -> peers (ws.js attachSocket)
 *   GET/POST /sse/<session>                  -> peers via HTTPS + SSE (sse-server.js)
 *   anything else                            -> static files (`static`), e.g. the demo
 *
 * Both transports end in the same `createLink`. Behind TLS (a reverse
 * proxy) this is wss:// and https:// on one origin.
 *
 *   qu.use(httpServerTransport({ port: 8787, static: './demo' }))   // ws + sse
 *
 * Import from `@qu/lite/ws-server` or `@qu/lite/node` - needs the `ws`
 * package, never in browsers.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { attachSocket } from './ws.js';
import { createSseHandler } from './sse-server.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

function staticHandler(dir) {
  const root = resolve(dir);
  return async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(root, path));
      if (!file.startsWith(root)) throw new Error('outside root');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  };
}

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} qu
 * @param {{port?: number, host?: string, server?: import('node:http').Server, static?: string, ws?: boolean, sse?: boolean|object}} [options]
 * @returns {Promise<{port: number, close: () => Promise<void>, wss: WebSocketServer|null}>}
 */
export async function listenHttp(qu, { port = 0, host, server, static: dir, ws = true, sse = true } = {}) {
  const ownServer = !server;
  const sseHandler = sse ? createSseHandler(qu, typeof sse === 'object' ? sse : {}) : null;
  const files = dir ? staticHandler(dir) : null;
  const onRequest = (req, res) => {
    if (sseHandler?.(req, res)) return;
    if (files) return files(req, res);
    res.writeHead(ws ? 426 : 404, { 'content-type': 'text/plain' }).end(ws ? 'websocket or sse only' : 'not found');
  };
  server = server ?? createServer();
  server.on('request', onRequest);
  const wss = ws ? new WebSocketServer({ server, perMessageDeflate: false }) : null;
  const refuseUpgrade = (req, socket) => socket.destroy();
  if (!ws) server.on('upgrade', refuseUpgrade);
  wss?.on('connection', (socket) => attachSocket(qu, socket, { via: 'ws-server' }));
  if (ownServer) await new Promise((ok, fail) => server.once('error', fail).listen(port, host, ok));
  return {
    wss,
    port: server.address().port,
    close: () =>
      new Promise((done) => {
        sseHandler?.close();
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
