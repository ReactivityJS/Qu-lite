/**
 * Robustness of the base: kernel lifecycle, strict frames, handshake rules,
 * backpressure, server capacity/readiness/graceful shutdown, lazy registry,
 * the client/relay presets and the devtools API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createLink, encodeFrame, decodeFrame, peekFrameType, Bus, createPeer, devtools, PROTOCOL_VERSION, createClient, Space } from '../src/index.js';
import { createRelay } from '../src/node.js';
import { attachSocket } from '../src/net/ws.js';
import { until, settle } from './helpers.js';

/** A link whose sent frames are captured, plus a fake remote "hi". */
function harness(qu, options = {}) {
  const sent = [];
  let closed = 0;
  const link = createLink(qu, { send: (b) => sent.push(decodeFrame(b)), close: () => closed++, via: 'test', ...options });
  return { link, sent, closed: () => closed };
}
const hi = (peer = '0123456789abcdef', v) => encodeFrame('hi', v === undefined ? { peer } : { peer, v });

test('kernel lifecycle: close() runs disposers in reverse, clears owned timers, closes plugin APIs once', async () => {
  const qu = await createQu();
  const order = [];
  let ticks = 0;
  qu.timers.interval(() => ticks++, 5);
  qu.onClose(() => order.push('first'));
  qu.use(() => ({ close: () => order.push('plugin') }), 'p');
  qu.onClose(() => order.push('last'));
  assert.ok(qu.has('p'));
  await settle(20);
  const events = [];
  qu.bus.on('qu.closing', () => events.push('closing'));
  qu.bus.on('qu.closed', () => events.push('closed'));
  await Promise.all([qu.close(), qu.close()]);
  assert.deepEqual(order, ['last', 'plugin', 'first']);
  assert.deepEqual(events, ['closing', 'closed']);
  const after = ticks;
  await settle(30);
  assert.equal(ticks, after, 'interval cleared');
  assert.ok(qu.closed);
  assert.throws(() => qu.use(() => {}), /closed/);
});

test('a failing disposer is reported on bus.error and does not stop the others', async () => {
  const qu = await createQu();
  const errors = [];
  qu.bus.on('bus.error', ({ error }) => errors.push(error.message));
  let ran = false;
  qu.onClose(() => (ran = true));
  qu.onClose(() => {
    throw new Error('boom');
  });
  await qu.close();
  assert.ok(ran);
  assert.deepEqual(errors, ['boom']);
});

test('bus: cached dispatch stays correct across on/off, and bus.error() reports background failures', async () => {
  const bus = new Bus({ cacheSize: 2 });
  const seen = [];
  const off = bus.on('a.*', () => seen.push('star'));
  await bus.emit('a.x');
  bus.on('a.x', () => seen.push('exact'), { order: -1 });
  await bus.emit('a.x');
  off();
  await bus.emit('a.x');
  for (const t of ['b.1', 'b.2', 'b.3']) await bus.emit(t); // overflows the cache bound
  await bus.emit('a.x');
  assert.deepEqual(seen, ['star', 'exact', 'star', 'exact', 'exact']);
  const errors = [];
  bus.on('bus.error', ({ topic, error }) => errors.push(`${topic}:${error.message}`));
  bus.error(new Error('late'), 'compaction.flush');
  await settle();
  assert.deepEqual(errors, ['compaction.flush:late']);
});

test('frames: strict decoding rejects truncation, trailing bytes and unknown blob refs', () => {
  const good = encodeFrame('rec', { bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(peekFrameType(good), 'rec');
  assert.deepEqual(decodeFrame(good).payload.bytes, new Uint8Array([1, 2, 3]));
  assert.throws(() => decodeFrame(good.subarray(0, good.length - 1)), /truncated/);
  const extra = new Uint8Array(good.length + 2);
  extra.set(good);
  assert.throws(() => decodeFrame(extra), /truncated/);
  assert.throws(() => decodeFrame(encodeFrame('x', { $b: 3 })), /unknown blob/);
  assert.throws(() => peekFrameType(new Uint8Array([200, 1, 2, 3, 4])), /truncated/);
});

test('link: hi carries the protocol version; a newer version is refused', async () => {
  const qu = await createQu();
  const errors = [];
  qu.bus.on('net.error', (e) => errors.push(e.reason));
  const h = harness(qu);
  assert.deepEqual(h.sent[0], { type: 'hi', payload: { peer: qu.peerId, v: PROTOCOL_VERSION } });
  h.link.receive(hi('0123456789abcdef', PROTOCOL_VERSION + 1));
  await settle();
  assert.equal(h.closed(), 1);
  assert.deepEqual(errors, ['protocol']);
  assert.equal(h.link.peer, null);

  const old = harness(qu);
  old.link.receive(hi('0123456789abcdef')); // no v: version 1
  assert.equal(old.link.peer, '0123456789abcdef');
  assert.equal(qu.net.links.get('0123456789abcdef').version, 1);
  await qu.close();
});

test('link: frame types are checked before they become bus topics; the guard runs before parsing', async () => {
  const qu = await createQu();
  const errors = [];
  const inbound = [];
  const guarded = [];
  qu.bus.on('net.error', (e) => errors.push(e.reason));
  qu.bus.on('net.in.**', (_p, ctx) => inbound.push(ctx.topic));
  qu.net = undefined;
  const h = harness(qu);
  qu.net.guard = (peer, type, size) => (guarded.push(type), type !== 'flood');
  h.link.receive(hi());
  h.link.receive(encodeFrame('evil.topic', {}));
  h.link.receive(encodeFrame('Ack', {}));
  h.link.receive(encodeFrame('flood', {}));
  const broken = encodeFrame('ack', { x: 1 });
  h.link.receive(broken.subarray(0, broken.length - 2)); // guard sees it, decoding then fails
  h.link.receive(encodeFrame('ack', { ok: true }));
  await settle();
  assert.deepEqual(inbound, ['net.in.0123456789abcdef.ack']);
  assert.deepEqual(errors, ['bad type', 'bad type', 'bad frame']);
  assert.deepEqual(guarded, ['evil.topic', 'Ack', 'flood', 'ack', 'ack']);
  await qu.close();
});

test('link: a remote that never says hi is closed (timeout, or too many early frames)', async () => {
  const qu = await createQu();
  qu.net = undefined;
  const reasons = [];
  qu.bus.on('net.error', (e) => reasons.push(e.reason));
  const { netOf } = await import('../src/net/link.js');
  netOf(qu).helloTimeoutMs = 30;
  const silent = harness(qu);
  await settle(60);
  assert.equal(silent.closed(), 1);

  netOf(qu).helloTimeoutMs = 0;
  const chatty = harness(qu);
  for (let i = 0; i < 9; i++) chatty.link.receive(encodeFrame('sub', {}));
  assert.equal(chatty.closed(), 1);
  assert.deepEqual(reasons, ['no hello', 'no hello']);
  await qu.close();
});

test('qu.close() drops every open link (peer down on both sides)', async () => {
  const { connectInProcess } = await import('../src/index.js');
  const a = await createQu();
  const b = await createQu();
  const c = connectInProcess(a, b);
  await c.ready;
  let down = 0;
  b.bus.on('net.peer.down', () => down++);
  await a.close();
  await settle();
  assert.equal(a.net.links.size, 0);
  await c.disconnect();
  await b.close();
});

test('websocket backpressure: a socket that does not drain is closed as a slow consumer', async () => {
  const qu = await createQu();
  const listeners = {};
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    sent: 0,
    closedWith: null,
    send() {
      this.sent++;
      this.bufferedAmount += 1000;
    },
    close(code) {
      this.closedWith = code ?? 1000;
    },
    addEventListener: (t, fn) => (listeners[t] = fn),
  };
  const slow = [];
  qu.bus.on('net.slow', (e) => slow.push(e));
  attachSocket(qu, socket, { maxBufferedBytes: 2500 });
  listeners.message({ data: hi().buffer.slice(0) });
  for (let i = 0; i < 10; i++) await qu.bus.emit('net.out.0123456789abcdef.ping', { i });
  assert.equal(socket.closedWith, 1013);
  assert.equal(slow.length, 1);
  assert.ok(socket.sent <= 4, `stopped sending (${socket.sent})`);
  await qu.close();
});

test('createPeer: lazy registry loads only what is named; a failing build closes what it opened', async () => {
  const qu = await createPeer({ plugins: ['records', ['devtools', { global: false, log: () => {} }]] });
  assert.ok(qu.has('records') && qu.has('devtools') && !qu.has('sync'));
  assert.equal(typeof qu.dev.help, 'function');
  await qu.close();

  let closed = false;
  const store = { ...(await import('../src/drivers/memory.js')).memoryDriver(), close: () => (closed = true) };
  await assert.rejects(
    createPeer({
      store,
      plugins: [
        'records',
        () => {
          throw new Error('broken plugin');
        },
      ],
    }),
    /broken plugin/
  );
  assert.ok(closed, 'store closed after the failed build');
});

test('createRelay + createClient: one base, readiness, capacity limit and graceful shutdown', async () => {
  const lines = [];
  const relay = await createRelay({ port: 0, host: '127.0.0.1', log: (l) => lines.push(l), logFormat: 'json', maxConnections: 1 });
  const base = `http://127.0.0.1:${relay.port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const info = await (await fetch(`${base}/info`)).json();
  assert.equal(info.protocol, PROTOCOL_VERSION);
  assert.equal(JSON.parse(lines[0]).event, 'relay.start');

  const client = await createClient({ url: base, devtools: false, relay: { minDelayMs: 50, WebSocketImpl: WebSocket } });
  const refused = [];
  relay.qu.bus.on('net.refused', (e) => refused.push(e.reason));
  try {
    assert.ok(client.has('members') && client.has('status'));
    await until(() => client.transports.relay.status()[0]?.connected, 5000, 'client connected');
    const space = client.join(await Space.create(client.identity));
    await client.write(space, 'chat', 'hallo');
    await until(async () => (await client.syncStatus()).outbox === 0, 5000, 'acked by the relay');

    // a second peer is over the limit
    const second = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`);
    const code = await new Promise((resolve) => second.addEventListener('close', (e) => resolve(e.code)));
    assert.equal(code, 1013);
    assert.deepEqual(refused, ['capacity']);

    const downs = [];
    client.bus.on('net.peer.down', () => downs.push(Date.now()));
    await relay.close();
    await until(() => downs.length > 0, 3000, 'client saw the shutdown');
    assert.ok(lines.some((l) => JSON.parse(l).event === 'net.peer.up'));
  } finally {
    await client.close();
    await relay.close();
  }
});

test('devtools: info, links, ls (identity masked), trace and cleanup of the global', async () => {
  const logs = [];
  const qu = await createPeer({ plugins: ['records', ['devtools', { global: 'quTest', log: (...a) => logs.push(a.join(' ')), table: () => {} }]] });
  assert.equal(globalThis.quTest, qu);
  const info = qu.dev.info();
  assert.equal(info.peerId, qu.peerId);
  assert.ok(info.plugins.includes('records'));
  const rows = await qu.dev.ls('qu/');
  assert.deepEqual(
    rows.find((r) => r.key === 'qu/identity'),
    { key: 'qu/identity', bytes: '(masked)' }
  );
  assert.match(await qu.dev.get('qu/identity'), /masked/);
  const dump = await qu.dev.dump('qu/');
  assert.equal(dump['qu/identity'], '(masked)');
  const stop = qu.dev.trace('demo.**');
  await qu.bus.emit('demo.ping', { bytes: new Uint8Array(32) });
  stop();
  await qu.bus.emit('demo.pong', {});
  assert.equal(logs.filter((l) => l.includes('demo.')).length, 1);
  assert.ok(logs.some((l) => l.includes('demo.ping')));
  await qu.close();
  assert.equal(globalThis.quTest, undefined);
});
