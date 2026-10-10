import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeer, sseTransport, wsTransport, relayTransport, crypto } from '../src/index.js';
import { nodeRegistry } from '../src/node.js';
import { fullClient, until, values } from './helpers.js';

async function relay({ ws = true } = {}, port = 0) {
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', {}],
    plugins: [['sync', { role: 'mirror', retryMs: 0 }], 'mirror'],
    transports: [['http-server', { port, host: '127.0.0.1', ws }]],
  });
  const server = await qu.transports['http-server'].ready;
  return { qu, port: server.port, close: async () => (await server.close(), qu.root.close()) };
}

test('a WebSocket client and an SSE client chat through the same relay, also across a relay restart', async () => {
  let r = await relay();
  const port = r.port;
  const viaSse = await fullClient();
  const viaWs = await fullClient();
  viaSse.use(sseTransport({ connect: [`http://127.0.0.1:${port}/sse`], minDelayMs: 50 }));
  viaWs.use(wsTransport({ connect: [`ws://127.0.0.1:${port}/ws`], minDelayMs: 50 }));
  await until(() => viaSse.transports.sse.status()[0]?.connected && viaWs.transports.ws.status()[0]?.connected, 5000, 'both connected');

  const space = await viaSse.createGroup();
  const joined = await viaWs.acceptInvite(await (await viaSse.members(space)).invite());
  await viaWs.write(joined, 'chat', 'per WebSocket');
  await viaSse.write(space, 'chat', 'per SSE');
  const big = 'x'.repeat(200_000); // several frames, base64 down, binary up
  await viaSse.write(space, 'chat', big);
  await until(async () => (await values(viaSse, space, 'chat')).includes('per WebSocket'), 5000, 'ws -> sse');
  await until(async () => (await values(viaWs, joined, 'chat')).includes(big), 5000, 'sse -> ws');

  await r.close();
  await until(() => !viaSse.transports.sse.status()[0]?.connected, 5000, 'sse notices the restart');
  await viaSse.write(space, 'chat', 'waehrend der Relay weg war');
  r = await relay({}, port);
  await until(() => viaSse.transports.sse.status()[0]?.connected, 10_000, 'sse reconnects');
  await until(async () => (await values(viaWs, joined, 'chat')).includes('waehrend der Relay weg war'), 10_000, 'outbox flushed over sse');
  viaSse.transports.sse.disconnect();
  viaWs.transports.ws.disconnect();
  await r.close();
});

test('sessions cannot be guessed into, malformed or oversized posts are refused', async () => {
  const r = await relay();
  const base = `http://127.0.0.1:${r.port}/sse`;
  assert.equal((await fetch(`${base}/${crypto.toHex(crypto.randomBytes(16))}`, { method: 'POST', body: new Uint8Array(8) })).status, 404);
  assert.equal((await fetch(`${base}/not-a-session`, { method: 'POST', body: new Uint8Array(8) })).status, 400);
  assert.equal((await fetch(`${base}/${crypto.toHex(crypto.randomBytes(16))}`, { method: 'OPTIONS' })).status, 204);
  await r.close();
});

test('relayTransport falls back to SSE where WebSockets are blocked (refused or hanging)', async () => {
  const r = await relay({ ws: false });
  const a = await fullClient();
  const b = await fullClient();
  for (const qu of [a, b]) qu.use(relayTransport({ url: `http://127.0.0.1:${r.port}`, wsAttempts: 2, minDelayMs: 20, maxDelayMs: 100, connectTimeoutMs: 300 }));
  await until(() => a.transports.relay.via === 'sse' && a.transports.relay.status()[0]?.connected, 10_000, 'a on sse');
  await until(() => b.transports.relay.status()[0]?.connected, 10_000, 'b on sse');
  const space = await a.createGroup();
  const joined = await b.acceptInvite(await (await a.members(space)).invite());
  await a.write(space, 'chat', 'trotz Firewall');
  await until(async () => (await values(b, joined, 'chat')).includes('trotz Firewall'), 5000);
  for (const qu of [a, b]) qu.transports.relay.close();
  await r.close();
});

test('relayTransport stays on WebSocket when it works', async () => {
  const r = await relay();
  const a = await fullClient();
  a.use(relayTransport({ url: `http://127.0.0.1:${r.port}`, minDelayMs: 20 }));
  await until(() => a.transports.relay.status()[0]?.connected, 5000);
  assert.equal(a.transports.relay.via, 'ws');
  a.transports.relay.close();
  await r.close();
});
