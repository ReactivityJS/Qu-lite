import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, records, sync, Space, memoryDriver, connectInProcess } from '../src/index.js';
import { until } from './helpers.js';

/** A memory driver that records every batch and can be told to fail the next ones. */
function flakyDriver() {
  const inner = memoryDriver();
  const driver = {
    ...inner,
    batches: [],
    failing: 0,
    async batch(ops) {
      if (driver.failing > 0) {
        driver.failing--;
        throw new Error('disk full');
      }
      driver.batches.push(ops.map(({ op, key }) => `${op} ${key.split('/')[0]}`));
      return inner.batch(ops);
    },
  };
  return driver;
}

async function peer(root) {
  const qu = await createQu({ root });
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0 }));
  return qu;
}

async function shared(...peers) {
  const secret = (await Space.create()).invite;
  return Promise.all(peers.map(async (qu) => qu.join(await Space.open(secret))));
}

const allKeys = (qu) => qu.storage.keys('');

test('a local write is one batch: envelope, sync index, pointer indexes and outbox together', async () => {
  const root = flakyDriver();
  const a = await peer(root);
  const [space] = await shared(a);
  root.batches.length = 0;
  await a.write(space, 'chat', 'hi');
  assert.equal(root.batches.length, 1);
  assert.deepEqual(root.batches[0].sort(), ['remove defer', 'set idx', 'set loc', 'set rec', 'set sx', 'set sync'].sort());

  await a.write(space, 'profile', 'v1', { key: 'name' });
  root.batches.length = 0;
  await a.write(space, 'profile', 'v2', { key: 'name' }); // replaces the head and demotes v1 - still one batch
  assert.equal(root.batches.length, 1);
  assert.ok(root.batches[0].includes('set head') && root.batches[0].includes('remove idx'));
});

test('a failed commit leaves nothing behind - no envelope, no index, no outbox, no event - and the write can be retried', async () => {
  const root = flakyDriver();
  const a = await peer(root);
  const [space] = await shared(a);
  const before = await allKeys(a);
  const seen = [];
  a.bus.on(`qu.record.${space.id}`, (r) => seen.push(r.value));
  const failed = [];
  a.bus.on('qu.record.failed', (e) => failed.push(e.reason));

  root.failing = 1;
  await assert.rejects(a.write(space, 'chat', 'lost?'), /failed: disk full/);
  assert.deepEqual(await allKeys(a), before);
  assert.deepEqual(failed, ['disk full']);
  assert.deepEqual(seen, []);
  assert.deepEqual(await a.syncStatus(), { outbox: 0, pending: 0 });

  await a.write(space, 'chat', 'retried');
  assert.deepEqual(seen, ['retried']);
  assert.deepEqual((await a.query({ space, path: 'chat' })).map((r) => r.value), ['retried']);
});

test('a record whose commit failed on receipt is fetched again by the next resync', async () => {
  const rootB = flakyDriver();
  const a = await peer();
  const b = await peer(rootB);
  const [sa, sb] = await shared(a, b);
  const link = connectInProcess(a, b);
  await link.ready;

  rootB.failing = 1;
  const outcome = new Promise((resolve) => b.bus.on('qu.record.processed', (e) => e.from && resolve(e.status)));
  await a.write(sa, 'chat', 'one');
  assert.equal(await outcome, 'failed');
  assert.deepEqual(await b.storage.keys(`rec/${sb.id}/`), []);

  const [summary] = await b.resync({ space: sb });
  assert.equal(summary.received, 1);
  await until(async () => (await b.query({ space: sb, path: 'chat' })).length === 1);
  assert.equal((await b.query({ space: sb, path: 'chat' }))[0].value, 'one');
  await link.disconnect();
});

test('concurrently arriving versions of one key: the newest wins, whatever the order', async () => {
  const a = await peer();
  const [sa] = await shared(a);
  const versions = [];
  a.bus.on('qu.write.stored', ({ id }) => versions.push(id));
  for (let i = 0; i < 8; i++) await a.write(sa, 'state', i, { key: 'k' });
  const envelopes = await Promise.all(versions.map((id) => a.storage.get(`rec/${sa.id}/${id}`)));

  for (let round = 0; round < 5; round++) {
    const b = await peer();
    const sb = b.join(await Space.open(sa.invite));
    const shuffled = [...envelopes].sort(() => Math.random() - 0.5);
    await Promise.all(shuffled.map((bytes) => b.envelopes.ingest(bytes, { from: 'x' })));
    assert.equal(await b.get(sb, 'state', 'k'), 7);
    assert.equal((await b.storage.keys(`idx/${sb.id}/`)).length, 1); // exactly one current version indexed
  }
});

test('scrub re-indexes a keyed record that lost its index without losing its head', async () => {
  const a = await peer();
  const [space] = await shared(a);
  const { id } = await a.write(space, 'profile', 'Ada', { key: 'name' });
  const loc = await a.storage.get(`loc/${space.id}/${id}`);
  await a.storage.remove(loc.idx);
  const report = await a.scrub(space);
  assert.deepEqual(report.reindexed, [id]);
  assert.equal(await a.get(space, 'profile', 'name'), 'Ada');
  assert.equal(await a.storage.has(loc.idx), true);
});
