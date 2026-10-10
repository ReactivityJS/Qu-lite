/**
 * WEBSOCKET SERVER TRANSPORT (Node) - accepts peers and hands each socket to
 * `attachSocket` (ws.js), i.e. to the same `createLink` every client uses.
 * Optionally serves a static directory on the same port (the browser demo):
 * HTTP GET -> files, WebSocket upgrade (any path, e.g. `/ws`) -> peers.
 *
 *   qu.use(wsServerTransport({ port: 8787, static: './demo' }))
 *
 * Import from `@qu/lite/ws-server` - needs the `ws` package, never in browsers.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { attachSocket } from './ws.js';

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
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} qu
 * @param {{port?: number, host?: string, server?: import('node:http').Server, static?: string}} [options]
 * @returns {Promise<{port: number, close: () => Promise<void>, wss: WebSocketServer}>}
 */
export async function listenWs(qu, { port = 0, host, server, static: dir } = {}) {
  const ownServer = !server;
  server = server ?? createServer(dir ? staticHandler(dir) : (req, res) => res.writeHead(426).end('websocket only'));
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('connection', (socket) => attachSocket(qu, socket, { via: 'ws-server' }));
  if (ownServer) await new Promise((ok, fail) => server.once('error', fail).listen(port, host, ok));
  return {
    wss,
    port: server.address().port,
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => (ownServer ? server.close(() => done()) : done()));
      }),
  };
}

/**
 * Plugin form; `ready` resolves with `{port}` once listening.
 * @param {{port?: number, host?: string, server?: import('node:http').Server, static?: string}} [options]
 */
export function wsServerTransport(options = {}) {
  return (qu) => {
    const ready = listenWs(qu, options);
    const api = { ready, close: async () => (await ready).close() };
    qu.transports = { ...qu.transports, 'ws-server': api };
    return api;
  };
}
