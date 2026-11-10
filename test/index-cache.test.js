/**
 * The sync-index cache (sync.js INDEX CACHE) and the storage write hooks it
 * relies on (mount.js afterWrite): a change is visible to the very next
 * reconcile, a write that completes during a read keeps that read out of the
 * cache, concurrent reads share one load, and a reconnect storm costs one
 * index load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQu, records, sync, Space, connectInProcess, memoryDriver } from '../src/index.js';
import { createMountRouter } from '../src/mount.js';
import { until, settle } from './helpers.js';

async function peer(options = {}) {
  const qu = await createQu();
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ...options }));
  return qu;
}
function loads(qu) {
  const seen = { read: 0, cached: 0 };
  qu.bus.on('sync.index', ({ cached }) => (cached ? seen.cached++ : seen.read++));
  return seen;
}

test('afterWrite: hooks see completed writes under their prefix (set, remove, batch), never fail a write', async () => {
  const errors = [];
  const bus = { error: (e) => errors.push(e.message) };
  const storage = createMountRouter({ root: memoryDriver(), bus });
  const seen = [];
  const off = storage.afterWrite('sx/', (keys) => seen.push(keys));
  storage.afterWrite('sx/', () => {
    throw new Error('hook broke');
  });
  await storage.set('sx/a/1', 1);
  await storage.set('rec/a/1', 1);
  await storage.batch([
    { op: 'set', key: 'sx/b/1', value: 1 },
    { op: 'set', key: 'idx/b/1', value: 1 },
    { op: 'remove', key: 'sx/a/1' },
  ]);
  await storage.remove('sx/b/1');
  assert.deepEqual(seen, [['sx/a/1'], ['sx/b/1', 'sx/a/1'], ['sx/b/1']]);
  assert.equal(errors.length, 3, 'a throwing hook is reported, the write still happened');
  assert.equal(await storage.get('sx/b/1'), null);
  off();
  await storage.set('sx/c/1', 1);
  assert.equal(seen.length, 3);
});

test('a reconnect storm costs one index load on the mirror; a change is seen by the next reconcile', async () => {
  const mirror = await peer({ role: 'mirror' });
  const counted = loads(mirror);
  const writer = await peer({ ackFrom: 'mirror' });
  const space = await Space.create();
  await mirror.watch({ space: mirror.join(await Space.open(space.invite)) });
  const w = writer.join(await Space.open(space.invite));
  for (let i = 0; i < 50; i++) await writer.write(w, 'chat', i);
  const seed = connectInProcess(writer, mirror);
  await seed.ready;
  await until(async () => (await writer.syncStatus()).outbox === 0);
  await seed.disconnect();

  // five devices holding everything (they download it once)
  const devices = [];
  for (let d = 0; d < 5; d++) {
    const qu = await peer({ ackFrom: 'mirror' });
    const s = qu.join(await Space.open(space.invite));
    await qu.watch({ space: s });
    const l = connectInProcess(qu, mirror);
    await l.ready;
    await until(async () => (await qu.query({ space: s, path: 'chat' })).length === 50);
    await l.disconnect();
    devices.push({ qu, s });
  }

  counted.read = 0;
  const links = devices.map(({ qu }) => connectInProcess(qu, mirror));
  await Promise.all(links.map((l) => l.ready));
  for (const { qu } of devices) await until(async () => (await qu.syncStatus()).pending === 0);
  assert.equal(counted.read, 0, 'the index was still cached from the downloads');
  await Promise.all(links.map((l) => l.disconnect()));

  // a new record reaches the mirror -> the cache must not hide it
  await writer.write(w, 'chat', 'new');
  const again = connectInProcess(writer, mirror);
  await again.ready;
  await until(async () => (await writer.syncStatus()).outbox === 0);
  await again.disconnect();
  counted.read = 0;
  const links2 = devices.map(({ qu }) => connectInProcess(qu, mirror));
  await Promise.all(links2.map((l) => l.ready));
  for (const { qu, s } of devices) await until(async () => (await qu.query({ space: s, path: 'chat' })).length === 51, 5000, 'new record arrived');
  assert.equal(counted.read, 1, 'one load after the change, shared by every device');
  await Promise.all(links2.map((l) => l.disconnect()));
  await Promise.all([mirror.close(), writer.close(), ...devices.map(({ qu }) => qu.close())]);
});

test('a write completing while the index is read keeps that read out of the cache', async () => {
  const a = await peer({});
  const b = await peer({});
  const space = await Space.create();
  const sa = a.join(await Space.open(space.invite));
  const sb = b.join(await Space.open(space.invite));
  for (let i = 0; i < 5; i++) await a.write(sa, 'chat', i);
  const counted = loads(a);

  // stall a's first index read; write a record while it is stalled
  const range = a.storage.range;
  let stalled = false;
  a.storage.range = async (prefix, options) => {
    const rows = await range(prefix, options);
    if (prefix.startsWith('sx/') && !stalled) {
      stalled = true;
      await a.write(sa, 'chat', 'during the read');
    }
    return rows;
  };
  await b.watch({ space: sb });
  const link = connectInProcess(a, b);
  await link.ready;
  await until(async () => (await b.query({ space: sb, path: 'chat' })).length === 6, 5000, 'b has everything');
  a.storage.range = range;
  assert.ok(stalled);

  // the stale read must not have been cached: the next reconcile reads again and still agrees
  counted.read = 0;
  counted.cached = 0;
  const [result] = await b.resync({ space: sb });
  assert.equal(result.error, undefined);
  assert.equal((await b.query({ space: sb, path: 'chat' })).length, 6);
  assert.ok(counted.read >= 1, 'read fresh, not served from a stale cache');
  await link.disconnect();
  await Promise.all([a.close(), b.close()]);
});

test('indexCacheItems: 0 disables the cache; results are identical', async () => {
  for (const indexCacheItems of [0, 250_000]) {
    const a = await peer({ indexCacheItems });
    const b = await peer({ indexCacheItems });
    const counted = loads(a);
    const space = await Space.create();
    const sa = a.join(await Space.open(space.invite));
    const sb = b.join(await Space.open(space.invite));
    for (let i = 0; i < 10; i++) await a.write(sa, 'chat', i);
    await b.write(sb, 'chat', 'b');
    await a.watch({ space: sa });
    await b.watch({ space: sb });
    const link = connectInProcess(a, b);
    await link.ready;
    for (let r = 0; r < 3; r++) await b.resync({ space: sb });
    await until(async () => (await a.query({ space: sa, path: 'chat' })).length === 11, 5000, 'a has b\'s record');
    assert.equal((await b.query({ space: sb, path: 'chat' })).length, 11);
    assert.equal(counted.cached > 0, indexCacheItems > 0);
    await link.disconnect();
    await Promise.all([a.close(), b.close()]);
  }
});
