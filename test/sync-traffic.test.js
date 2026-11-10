/**
 * Sync traffic: what a reconcile sends beyond the records themselves.
 * Guarantees: one session per (peer, scope), bounded concurrency instead of
 * `busy` declines, the digest pre-check (and its fallback to the plain
 * reconcile), no double upload of outbox records, batched acks, no acks to
 * mirrors. Results must stay identical to the plain reconcile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQu, records, sync, Space, connectInProcess, memoryDriver } from '../src/index.js';
import { until, settle } from './helpers.js';

async function peer(options = {}, qu = null) {
  qu ??= await createQu(options.root ? { root: options.root, identity: options.identity } : {});
  qu.use(records());
  const { root, identity, ...syncOptions } = options;
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ...syncOptions }));
  return qu;
}

/** Frames leaving `qu`, counted per type. */
function frames(qu) {
  const count = {};
  qu.bus.on('net.out.*.*', (_p, ctx) => {
    const type = ctx.topic.split('.')[3];
    count[type] = (count[type] ?? 0) + 1;
  });
  return count;
}

async function spaces(n, ...peers) {
  const out = peers.map(() => []);
  for (let i = 0; i < n; i++) {
    const secret = (await Space.create()).invite;
    for (let p = 0; p < peers.length; p++) out[p].push(peers[p].join(await Space.open(secret)));
  }
  return out;
}

const recCount = async (qu) => (await qu.storage.keys('rec/')).length;

test('upload: each outbox record crosses the link once, acks come batched', async () => {
  const mirror = await peer({ role: 'mirror' });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(3, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 60; i++) await client.write(s, 'chat', i);
  for (const s of cs) await client.watch({ space: s });
  const out = frames(client);
  const back = frames(mirror);
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  await settle(50);
  assert.equal(out.rec, 180, 'every record exactly once');
  assert.ok(back.ack <= 30, `acks batched (${back.ack} frames for 180 records)`);
  await Promise.all([client.close(), mirror.close()]);
});

test('download: watch() racing the reconnect fetches every record once; a mirror gets no acks', async () => {
  const mirror = await peer({ role: 'mirror' });
  const writer = await peer({ ackFrom: 'mirror' });
  const [ms, ws] = await spaces(10, mirror, writer);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of ws) for (let i = 0; i < 20; i++) await writer.write(s, 'chat', i);
  const seed = connectInProcess(writer, mirror);
  await seed.ready;
  await until(async () => (await writer.syncStatus()).outbox === 0);

  const fresh = await peer({ ackFrom: 'mirror' });
  const freshSpaces = [];
  for (const s of ws) freshSpaces.push(fresh.join(await Space.open(s.invite)));
  const out = frames(fresh);
  const sent = frames(mirror);
  const declined = [];
  fresh.bus.on('sync.error', (e) => declined.push(e.error));
  const link = connectInProcess(fresh, mirror);
  // no await link.ready: the watches race the handshake and the mirror's hello on purpose
  await Promise.all(freshSpaces.map((space) => fresh.watch({ space })));
  await until(async () => (await recCount(fresh)) >= 200, 10_000);
  await settle(50);
  assert.equal(sent.rec, 200, `records sent once (${sent.rec})`);
  assert.equal(out.ack ?? 0, 0, 'no acks to a mirror');
  assert.deepEqual(declined, [], '10 spaces > responder limit: queued, never declined');
  assert.equal((await fresh.syncStatus()).pending, 0);
  await link.disconnect();
  await Promise.all([fresh.close(), writer.close(), mirror.close(), seed.disconnect()]);
});

test('digest: an unchanged reconnect runs no Negentropy session; a changed scope still reconciles', async () => {
  const mirror = await peer({ role: 'mirror' });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(5, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) await client.write(s, 'chat', 'hi');
  for (const s of cs) await client.watch({ space: s });
  let link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  await link.disconnect();

  const out = frames(client);
  const done = [];
  client.bus.on('sync.done', (e) => done.push(e));
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.length === 5);
  assert.equal(out.digest, 1, 'one digest frame for all five scopes');
  assert.equal(out.neg ?? 0, 0, 'no reconcile session');
  assert.ok((await client.lastSync(cs[0].id)) !== null, 'a matching digest counts as a complete reconcile with the mirror');
  await link.disconnect();

  // the mirror got a record the client lacks -> that scope (only) reconciles and fetches it
  const other = await peer({});
  const os = other.join(await Space.open(cs[2].invite));
  await other.write(os, 'chat', 'from elsewhere');
  const l2 = connectInProcess(other, mirror);
  await l2.ready;
  await until(async () => (await other.syncStatus()).outbox === 0);
  done.length = 0;
  for (const k of Object.keys(out)) delete out[k];
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.length === 5);
  assert.equal(out.neg, 1, 'exactly the changed scope reconciles');
  assert.deepEqual(
    (await client.query({ space: cs[2], path: 'chat' })).map((r) => r.value),
    ['hi', 'from elsewhere']
  );
  await Promise.all([link.disconnect(), l2.disconnect(), client.close(), mirror.close(), other.close()]);
});

test('digest is optional: with a peer that does not offer it, the plain reconcile gives the same result', async () => {
  const mirror = await peer({ role: 'mirror', digest: false });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(2, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) await client.write(s, 'chat', 'x');
  for (const s of cs) await client.watch({ space: s });
  const out = frames(client);
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  assert.equal(out.digest ?? 0, 0);
  assert.equal(out.neg, 2);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});

test('a busy decline is retried within seconds, not after retryMs', async () => {
  // responder accepts one session, initiator does not limit itself: the second scope is declined once
  const mirror = await peer({ role: 'mirror', maxSessionsPerPeer: 1, digest: false });
  const client = await peer({ ackFrom: 'mirror', maxConcurrentPerPeer: 8, retryMs: 600_000 });
  const [ms, cs] = await spaces(6, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 40; i++) await client.write(s, 'chat', i);
  for (const s of cs) await client.watch({ space: s });
  const errors = [];
  const done = new Set();
  client.bus.on('sync.error', (e) => errors.push(e.error));
  client.bus.on('sync.done', (e) => done.add(e.sid));
  const started = Date.now();
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.size === 6, 15_000, 'all six scopes reconciled');
  assert.ok(errors.includes('declined: busy'), 'the responder declined some sessions');
  assert.ok(Date.now() - started < 15_000, 'retried long before retryMs (10 min)');
  assert.equal((await client.syncStatus()).pending, 0);
  for (const s of ms) assert.equal((await mirror.query({ space: s, path: 'chat' })).length, 40);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});

test('reload while offline: outbox and pending survive, everything converges with digests on', async () => {
  const disk = memoryDriver();
  const mirror = await peer({ role: 'mirror' });
  let client = await peer({ ackFrom: 'mirror', root: disk });
  const identity = client.identity;
  const [ms, cs] = await spaces(3, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 5; i++) await client.write(s, 'chat', i);
  await client.close({ keepStore: true });

  client = await peer({ ackFrom: 'mirror', root: disk, identity });
  const again = [];
  for (const s of cs) again.push(client.join(await Space.open(s.invite)));
  for (const s of again) await client.watch({ space: s });
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  for (const s of ms) assert.equal((await mirror.query({ space: s, path: 'chat' })).length, 5);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});
