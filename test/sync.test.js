import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createClock, records, sync, Space, connectInProcess, memoryDriver } from '../src/index.js';

const DAY = 24 * 60 * 60 * 1000;
// Minute-aligned, so day boundaries fall exactly on sync-index minute buckets.
const START = 1_759_999_980_000;

/** Peers share one simulated wall clock so "3 days offline" takes no real time. */
function world() {
  const time = { now: START };
  return {
    time,
    /** `root`/`identity` let a test "reload" a peer: a new instance over the same storage. */
    async peer({ root, identity, ...syncOptions } = {}) {
      const qu = await createQu({ clock: createClock({ now: () => time.now }), root, identity });
      qu.use(records());
      qu.use(sync({ releaseMs: 0, timeoutMs: 5000, ...syncOptions }));
      return qu;
    },
  };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check()` is truthy (or fails after `ms`). */
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time');
    await settle(10);
  }
}
const recIds = async (qu, space) => (await qu.storage.keys(`rec/${space.id}/`)).map((k) => k.split('/').pop());
const values = async (qu, space, path, q = {}) => (await qu.query({ space, path, ...q })).map((r) => r.value);

async function shared(...peers) {
  const secret = (await Space.create()).secret;
  return Promise.all(peers.map(async (qu) => qu.join(await Space.open(secret))));
}

test('3 days offline on both sides: one resync brings both peers to the same state', async () => {
  const { time, peer } = world();
  const a = await peer();
  const b = await peer();
  const [sa, sb] = await shared(a, b);

  let link = connectInProcess(a, b);
  await a.write(sa, 'chat', 'before');
  await settle();
  await link.disconnect();

  for (let i = 0; i < 30; i++) {
    time.now += (3 * DAY) / 30;
    await a.write(sa, 'chat', `a${i}`);
    if (i % 6 === 0) await b.write(sb, 'chat', `b${i}`);
  }

  link = connectInProcess(a, b);
  const [summary] = await a.resync({ space: sa });
  assert.equal(summary.sent, 30);
  assert.equal(summary.received, 5);
  assert.deepEqual(summary.missing, []);
  await settle();

  assert.deepEqual((await recIds(a, sa)).sort(), (await recIds(b, sb)).sort());
  assert.equal((await values(b, sb, 'chat')).length, 36);
  const day2 = { from: START + DAY, to: START + 2 * DAY };
  assert.deepEqual(await values(b, sb, 'chat', day2), await values(a, sa, 'chat', day2));
  await link.disconnect();
});

test('query({ensure: true}) on a fresh peer fetches exactly the requested window', async () => {
  const { time, peer } = world();
  const a = await peer();
  const c = await peer();
  const [sa, sc] = await shared(a, c);

  for (let i = 0; i < 10; i++) {
    await a.write(sa, 'chat', `d${i}`);
    time.now += DAY;
  }
  connectInProcess(a, c);
  const window = { from: START + 3 * DAY, to: START + 6 * DAY };
  assert.deepEqual(await values(c, sc, 'chat', { ...window, ensure: true }), ['d3', 'd4', 'd5']);
  assert.equal((await recIds(c, sc)).length, 3);
});

test('volume: reconciling 10,000 records after one offline change costs a few KB, not a replay', async () => {
  const { time, peer } = world();
  const a = await peer();
  const b = await peer();
  const [sa, sb] = await shared(a, b);

  const N = 10_000;
  let fullSize = 0;
  const seed = connectInProcess(a, b);
  for (let i = 0; i < N; i++) {
    if (i % 50 === 0) time.now += 60_000;
    const { id } = await a.write(sa, 'log', i);
    fullSize += (await a.storage.get(`rec/${sa.id}/${id}`)).length;
  }
  await settle(200);
  assert.equal((await recIds(b, sb)).length, N);
  await seed.disconnect();

  await a.write(sa, 'log', 'offline change');
  const link = connectInProcess(a, b);
  const [summary] = await a.resync({ space: sa });
  await settle();
  const bytes = link.stats.aToB + link.stats.bToA;

  assert.equal(summary.sent, 1);
  assert.equal((await recIds(b, sb)).length, N + 1);
  assert.ok(bytes < 8 * 1024, `reconcile used ${bytes} bytes`);
  assert.ok(bytes < fullSize / 500, `reconcile ${bytes} B vs full replay ${fullSize} B`);
  console.log(`# volume: reconcile ${bytes} B for ${N} records (full replay would be ${fullSize} B)`);
});

test('partial sync: only the watched path shard is fetched and routed live', async () => {
  const { peer } = world();
  const a = await peer();
  const b = await peer();
  const [sa, sb] = await shared(a, b);

  for (let i = 0; i < 5; i++) {
    await a.write(sa, 'chat/general', `c${i}`);
    await a.write(sa, 'media', `m${i}`);
  }
  connectInProcess(a, b);
  const unwatch = await b.watch({ space: sb, path: 'chat/general' });
  await settle();
  assert.equal((await values(b, sb, 'chat/general')).length, 5);
  assert.equal((await values(b, sb, 'media')).length, 0);

  await a.write(sa, 'media', 'live media');
  await a.write(sa, 'chat/general', 'live chat');
  await settle();
  assert.deepEqual((await values(b, sb, 'chat/general')).slice(-1), ['live chat']);
  assert.equal((await values(b, sb, 'media')).length, 0);

  unwatch();
  await settle();
  await a.write(sa, 'chat/general', 'after unwatch');
  await settle();
  assert.equal((await values(b, sb, 'chat/general')).includes('after unwatch'), false);
});

test('repair: scrub drops a corrupted record, resync restores it; lost indexes are rebuilt', async () => {
  const { peer } = world();
  const a = await peer();
  const b = await peer();
  const [sa, sb] = await shared(a, b);
  connectInProcess(a, b);
  for (let i = 0; i < 5; i++) await a.write(sa, 'chat', `x${i}`);
  await a.write(sa, 'profile', 'Anna', { key: 'name' });
  await settle();

  const [victim] = await recIds(a, sa);
  const bytes = (await a.storage.get(`rec/${sa.id}/${victim}`)).slice();
  bytes[bytes.length - 1] ^= 0xff;
  await a.storage.set(`rec/${sa.id}/${victim}`, bytes);

  const report = await a.scrub(sa);
  assert.deepEqual(report.dropped, [victim]);
  await a.resync({ space: sa });
  await settle();
  assert.deepEqual((await recIds(a, sa)).sort(), (await recIds(b, sb)).sort());
  assert.equal((await values(a, sa, 'chat')).length, 5);
  assert.equal(await a.get(sa, 'profile', 'name'), 'Anna');

  // A lost index entry (e.g. a half-written transaction) is rebuilt locally, no network needed.
  const idxKeys = await a.storage.keys(`idx/${sa.id}/`);
  await a.storage.remove(idxKeys[0]);
  const again = await a.scrub(sa);
  assert.equal(again.reindexed.length, 1);
  assert.equal((await values(a, sa, 'chat')).length + (await values(a, sa, 'profile')).length, 6);
});

/** Small seeded PRNG so a failing run is reproducible. */
function prng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

for (const seed of [1, 2, 3]) {
  test(`convergence (seed ${seed}): 3 peers + mirror, random writes, partitions and reconnects`, async () => {
    const { time, peer } = world();
    const random = prng(seed);
    const nodes = { A: await peer(), B: await peer(), C: await peer(), M: await peer() };
    const names = Object.keys(nodes);
    const spaces = Object.fromEntries(names.map((n, i) => [n, null]));
    const joined = await shared(...Object.values(nodes));
    names.forEach((n, i) => (spaces[n] = joined[i]));
    for (const n of names) await nodes[n].watch({ space: spaces[n] });

    const pairs = [['A', 'M'], ['B', 'M'], ['C', 'M'], ['A', 'B']];
    const links = new Map();
    const toggle = async ([x, y]) => {
      const key = `${x}-${y}`;
      if (links.has(key)) {
        await links.get(key).disconnect();
        links.delete(key);
      } else links.set(key, connectInProcess(nodes[x], nodes[y]));
    };

    for (let step = 0; step < 150; step++) {
      const r = random();
      const who = names[Math.floor(random() * 3)]; // the mirror never writes
      if (r < 0.55) await nodes[who].write(spaces[who], 'log', `${who}${step}`);
      else if (r < 0.75) await nodes[who].write(spaces[who], 'doc', `${who}${step}`, { key: `k${Math.floor(random() * 3)}` });
      else await toggle(pairs[Math.floor(random() * pairs.length)]);
      time.now += Math.floor(random() * 3 * 60_000);
      if (step % 10 === 0) await settle(5);
    }

    for (const pair of pairs.slice(0, 3)) if (!links.has(pair.join('-'))) await toggle(pair);
    await settle(50);
    for (let round = 0; round < 2; round++) {
      for (const n of ['A', 'B', 'C']) await nodes[n].resync({ space: spaces[n], peer: nodes.M.peerId });
      await settle(50);
    }

    const reference = (await recIds(nodes.M, spaces.M)).sort();
    assert.ok(reference.length > 0);
    for (const n of names) {
      assert.deepEqual((await recIds(nodes[n], spaces[n])).sort(), reference, `${n} diverged`);
      for (const k of ['k0', 'k1', 'k2']) assert.equal(await nodes[n].get(spaces[n], 'doc', k), await nodes.M.get(spaces.M, 'doc', k));
    }
  });
}

test('reload: unacknowledged local writes survive and are pushed to the mirror on reconnect', async () => {
  const { peer } = world();
  const disk = memoryDriver(); // stands in for IndexedDB: survives the "reload"
  const identity = await (await createQu()).identity;
  const mirror = await peer({ role: 'mirror' });
  const secret = (await Space.create()).secret;
  const sm = mirror.join(await Space.open(secret));
  await mirror.watch({ space: sm });

  let a = await peer({ root: disk, identity, ackFrom: 'mirror' });
  let sa = a.join(await Space.open(secret));
  for (let i = 0; i < 3; i++) await a.write(sa, 'chat', `offline ${i}`);
  assert.deepEqual(await a.syncStatus(), { outbox: 3, pending: 0 });

  // Reload: all in-memory state is gone, only the disk remains. The app has not even mounted anything yet.
  a = await peer({ root: disk, identity, ackFrom: 'mirror' });
  sa = a.join(await Space.open(secret));
  const acked = [];
  a.bus.on('qu.record.acked', (e) => acked.push(e.role));
  connectInProcess(a, mirror);

  await until(async () => (await a.syncStatus()).outbox === 0);
  assert.equal((await values(mirror, sm, 'chat')).length, 3);
  assert.deepEqual([...new Set(acked)], ['mirror']);
});

test('with ackFrom "mirror", a plain peer storing a record does not clear the outbox', async () => {
  const { peer } = world();
  const a = await peer({ ackFrom: 'mirror' });
  const b = await peer();
  const [sa, sb] = await shared(a, b);
  await b.watch({ space: sb });
  connectInProcess(a, b);
  await a.write(sa, 'chat', 'hi');
  await until(async () => (await values(b, sb, 'chat')).length === 1);
  await settle();
  assert.equal((await a.syncStatus()).outbox, 1);
});

test('a resync cut off by a dropped connection resumes by itself after reload + reconnect', async () => {
  const { peer } = world();
  const disk = memoryDriver();
  const identity = await (await createQu()).identity;
  const a = await peer();
  const secret = (await Space.create()).secret;
  const sa = a.join(await Space.open(secret));
  for (let i = 0; i < 200; i++) await a.write(sa, 'log', i);

  let b = await peer({ root: disk, identity });
  let sb = b.join(await Space.open(secret));
  let link = connectInProcess(a, b);
  const running = b.resync({ space: sb });
  await link.disconnect(); // network drop mid-session
  const [cut] = await running;
  assert.equal(cut.error, 'peer disconnected');
  assert.equal((await b.syncStatus()).pending, 1);

  // Reload, no watch() yet - the pending reconcile alone must finish the job.
  b = await peer({ root: disk, identity });
  sb = b.join(await Space.open(secret));
  link = connectInProcess(a, b);
  await until(async () => (await recIds(b, sb)).length === 200);
  await until(async () => (await b.syncStatus()).pending === 0);
  assert.deepEqual((await values(b, sb, 'log')).sort((x, y) => x - y), Array.from({ length: 200 }, (_, i) => i));
});
