/**
 * The relay's one port: API (WebSocket, SSE), health/info, the web files -
 * and the same behind a reverse proxy that strips a path prefix (as nginx or
 * Caddy do in front of it for TLS).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPeer, createQu, Space, records, sync, relayTransport } from '../src/index.js';
import { nodeRegistry, listenHttp } from '../src/node.js';
import { buildWeb } from '../web/build.mjs';
import { until } from './helpers.js';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));

async function relay(options = {}) {
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', {}],
    plugins: [['sync', { role: 'mirror', retryMs: 0 }], 'mirror'],
    transports: [['http-server', { port: 0, host: '127.0.0.1', ...options }]],
  });
  const server = await qu.transports['http-server'].ready;
  return { qu, port: server.port, close: async () => (await server.close(), qu.root.close()) };
}

/** A minimal reverse proxy: `/qu/...` -> relay `/...`, for plain requests and WebSocket upgrades. */
async function prefixProxy(target, prefix = '/qu') {
  const strip = (url) => (url.startsWith(prefix) ? url.slice(prefix.length) || '/' : null);
  const server = createServer((req, res) => {
    const path = strip(req.url);
    if (path === null) return res.writeHead(404).end();
    const upstream = request({ host: '127.0.0.1', port: target, path, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const path = strip(req.url);
    if (path === null) return socket.destroy();
    const upstream = connect(target, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      upstream.write(`GET ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: server.address().port, close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))) };
}

test('one port: start page, demo, browser bundle, /healthz and /info next to the API', async () => {
  await buildWeb();
  const r = await relay({ static: webDir });
  const base = `http://127.0.0.1:${r.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
    assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
    const info = await (await fetch(`${base}/info`)).json();
    assert.equal(info.name, 'qu-lite');
    assert.deepEqual(info.transports, ['ws', 'sse']);
    assert.equal(typeof info.version, 'string');
    assert.equal(Object.keys(info).some((k) => /space|peer|sid/i.test(k)), false, 'no space data');

    const index = await fetch(`${base}/`);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await index.text(), /Qu Lite Relay/);
    assert.match(await (await fetch(`${base}/demo.html`)).text(), /dist\/demo\.js/);
    const bundle = await fetch(`${base}/dist/qu-lite.js`);
    assert.match(bundle.headers.get('content-type'), /text\/javascript/);
    assert.match(await bundle.text(), /createPeer|relayTransport/);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404, 'no path traversal');
  } finally {
    await r.close();
  }
  // without static files the API answers, everything else does not
  const bare = await relay();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bare.port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${bare.port}/`)).status, 426);
  } finally {
    await bare.close();
  }
});

test('WebSocket heartbeat: idle clients are pinged, a client that stops answering is closed', async () => {
  const qu = await createQu();
  const server = await listenHttp(qu, { port: 0, host: '127.0.0.1', pingMs: 50 });
  try {
    const alive = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    let pings = 0;
    alive.on('ping', () => pings++);
    await until(() => pings >= 3, 2000, 'pings arrive');
    assert.equal(alive.readyState, WebSocket.OPEN, 'an answering client stays');

    const silent = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { autoPong: false });
    const closed = new Promise((resolve) => silent.on('close', resolve));
    await closed; // terminated after a missed pong
    assert.equal(alive.readyState, WebSocket.OPEN);
    alive.close();
  } finally {
    await server.close();
  }
});

for (const prefer of ['ws', 'sse']) {
  test(`behind a reverse proxy with a path prefix (/qu): clients connect via ${prefer} and the relay stores their records`, async () => {
    const r = await relay();
    const proxy = await prefixProxy(r.port);
    const qu = await createQu();
    qu.use(records());
    qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ackFrom: 'mirror' }));
    qu.use(relayTransport({ url: `http://127.0.0.1:${proxy.port}/qu/`, prefer, minDelayMs: 50, WebSocketImpl: WebSocket }));
    try {
      await until(() => qu.transports.relay.status()[0]?.connected, 5000, 'connected through the proxy');
      assert.equal(qu.transports.relay.via, prefer);
      const space = qu.join(await Space.create(qu.identity));
      await qu.write(space, 'chat', `via ${prefer}`);
      await until(async () => (await qu.syncStatus()).outbox === 0, 5000, 'acked by the relay');
      assert.equal(await r.qu.mirror.count(space.id), 1);
    } finally {
      qu.transports.relay.disconnect();
      await proxy.close();
      await r.close();
    }
  });
}
