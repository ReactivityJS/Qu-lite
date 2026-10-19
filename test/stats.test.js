import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQu, records, sync, mirror, stats, relayTransport, Space, connectInProcess } from '../src/index.js';
import { startMirror } from '../bin/mirror.mjs';
import { until } from './helpers.js';

const fast = { sampleMs: 50, windowMs: 500, storageCacheMs: 0 };

async function client() {
  const qu = await createQu();
  qu.use(stats(fast));
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ackFrom: 'mirror' }));
  return qu;
}

test('traffic per connection and in total, throughput that rises and falls, counters that survive a disconnect', async () => {
  const m = await createQu();
  m.use(stats(fast));
  m.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
  m.use(mirror());
  await m.mirror.ready;
  const alice = await client();
  const space = alice.join(await Space.create(alice.identity));
  await alice.watch({ space });
  const link = connectInProcess(alice, m);
  await link.ready;

  for (let i = 0; i < 20; i++) await alice.write(space, 'chat', 'x'.repeat(2000));
  await until(async () => (await alice.syncStatus()).outbox === 0, 5000, 'acked');

  const snap = alice.stats.snapshot();
  assert.equal(snap.connections.open, 1);
  assert.equal(snap.peers.length, 1);
  const [peer] = snap.peers;
  assert.equal(peer.via, 'inproc');
  assert.equal(peer.bytesOut, link.stats.aToB, 'exactly the bytes on the wire');
  assert.equal(peer.bytesIn, link.stats.bToA);
  assert.ok(snap.traffic.bytesOut > 40_000 && snap.traffic.framesOut > 20);
  assert.ok(snap.traffic.outBps > 0, 'throughput while sending');
  assert.equal(snap.records.local.stored, 20);
  assert.equal(m.stats.snapshot().records.remote.stored, 20, 'the mirror counts what it received');
  await until(() => alice.stats.snapshot().traffic.outBps === 0, 3000, 'throughput falls back to 0 when idle');

  await link.disconnect();
  const after = alice.stats.snapshot();
  assert.equal(after.connections.open, 0);
  assert.equal(after.connections.total, 1);
  assert.ok(after.traffic.bytesOut >= snap.traffic.bytesOut, 'closed links keep counting in the totals');

  const storage = await alice.stats.storage();
  assert.equal(storage.spaces, 1);
  assert.equal(storage.records, 20);
  assert.equal(storage.outbox, 0);
  const mirrored = await m.stats.storage();
  assert.equal(mirrored.records, 20);
  assert.equal(mirrored.bytes, (await m.mirror.usage(space.id)).bytes);

  const text = await m.stats.prometheus();
  assert.match(text, /^qu_lite_records 20$/m);
  assert.match(text, /^qu_lite_records_processed_total\{origin="remote",status="stored"\} 20$/m);
  assert.match(text, /# TYPE qu_lite_received_bytes_total counter/);
});

test('relay: /stats and /metrics only with the token; figures name no spaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qu-lite-stats-'));
  const relay = await startMirror({ port: 0, host: '127.0.0.1', db: join(dir, 'relay.sqlite'), log: () => {}, statsToken: 's3cret' });
  const base = `http://127.0.0.1:${relay.port}`;
  const alice = await client();
  alice.use(relayTransport({ url: base, minDelayMs: 50, WebSocketImpl: WebSocket }));
  try {
    const space = alice.join(await Space.create(alice.identity));
    await until(() => alice.transports.relay.status()[0]?.connected, 5000, 'connected');
    await alice.write(space, 'chat', 'hallo');
    await until(async () => (await alice.syncStatus()).outbox === 0, 5000, 'acked');

    assert.equal((await fetch(`${base}/stats`)).status, 401);
    assert.equal((await fetch(`${base}/stats`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const res = await fetch(`${base}/stats`, { headers: { authorization: 'Bearer s3cret' } });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.connections.open, 1);
    assert.equal(report.peers[0].via, 'ws-server');
    assert.ok(report.traffic.bytesIn > 0);
    assert.equal(report.storage.spaces, 1);
    assert.equal(report.storage.records, 1);
    assert.ok(report.storage.driverBytes > 0, 'SQLite file size');
    assert.equal(JSON.stringify(report).includes(space.id), false, 'no space ids in the report');

    const metrics = await fetch(`${base}/metrics?token=s3cret`);
    assert.match(metrics.headers.get('content-type'), /text\/plain/);
    assert.match(await metrics.text(), /^qu_lite_connections 1$/m);
  } finally {
    alice.transports.relay.disconnect();
    await relay.close();
  }
  const plain = await startMirror({ port: 0, host: '127.0.0.1', db: ':memory:', log: () => {} });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${plain.port}/stats?token=x`)).status, 404, 'off without a token');
  } finally {
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
