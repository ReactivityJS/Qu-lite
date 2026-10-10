import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { createQu, createClock, records, sync, mirror, Space, connectInProcess, verifyGrants } from '../src/index.js';

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time');
    await settle(10);
  }
}

async function peer(options = {}) {
  const qu = await createQu();
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, ...options }));
  return qu;
}
async function mirrorPeer(options) {
  const qu = await createQu();
  qu.use(sync({ role: 'mirror', timeoutMs: 5000 }));
  qu.use(mirror(options));
  await qu.mirror.ready;
  return qu;
}
const values = async (qu, space, path) => (await qu.query({ space, path })).map((r) => r.value);

test('grants: epoch 0 must hash to the sid, later epochs must be signed by the previous one', async () => {
  const alice = await QuCrypto.generateKeypair();
  const space = await Space.create();
  const other = await Space.create();
  await space.rotate([alice.xPublicKey], alice);
  const grants = await space.grants();
  assert.deepEqual(grants.map((g) => g.epoch), [0, 1]);

  assert.deepEqual([...(await verifyGrants(space.id, grants, new Map())).keys()], [0, 1]);
  // Someone else's epoch-0 key does not match this sid.
  assert.equal((await verifyGrants(space.id, await other.grants(), new Map())).size, 0);
  // An epoch-1 key signed by the wrong key is refused.
  const forged = [grants[0], { ...grants[1], writePub: (await other.grants())[0].writePub }];
  assert.deepEqual([...(await verifyGrants(space.id, forged, new Map())).keys()], [0]);
});

test('star: peers only talk to a key-less mirror; live, offline and acks all go through it', async () => {
  const m = await mirrorPeer();
  const a = await peer({ ackFrom: 'mirror' });
  const b = await peer();
  const secret = (await Space.create()).secret;
  const sa = a.join(await Space.open(secret));
  const sb = b.join(await Space.open(secret));
  await b.watch({ space: sb, path: 'chat' });

  connectInProcess(a, m);
  const linkB = connectInProcess(b, m);
  await until(async () => (await m.mirror.spaces()).includes(sa.id));

  await a.write(sa, 'chat', 'live via mirror');
  await until(async () => (await values(b, sb, 'chat')).length === 1);
  await until(async () => (await a.syncStatus()).outbox === 0);

  await linkB.disconnect();
  await a.write(sa, 'chat', 'while b is offline');
  await a.write(sa, 'media', 'b does not watch this');
  await until(async () => (await m.mirror.count(sa.id)) === 3);
  connectInProcess(b, m);
  await until(async () => (await values(b, sb, 'chat')).length === 2);
  await settle(50);
  assert.equal((await values(b, sb, 'media')).length, 0);

  // The mirror holds envelopes only: no plaintext path, value or author anywhere in its store.
  for (const key of await m.storage.keys('')) {
    assert.equal(/chat|media|offline|live/.test(key), false, key);
    const value = await m.storage.get(key);
    if (value instanceof Uint8Array) assert.equal(Buffer.from(value).includes('while b is offline'), false);
  }
});

test('a mirror follows an epoch rotation and refuses records of an unknown epoch', async () => {
  const m = await mirrorPeer();
  const a = await peer();
  const alice = a.identity;
  const sa = a.join(await Space.create());
  connectInProcess(a, m);
  await until(async () => (await m.mirror.spaces()).includes(sa.id));

  await sa.rotate([alice.xPublicKey], alice);
  const unknown = [];
  m.bus.on('qu.record.processed', (e) => e.status === 'unknown-space' && unknown.push(e.id));
  await a.write(sa, 'chat', 'epoch 1 before the grant');
  await until(() => unknown.length === 1);

  await a.announce(sa);
  await until(async () => (await m.mirror.writeKeys(sa.id)).has(1));
  await a.resync({ space: sa });
  await until(async () => (await m.mirror.count(sa.id)) === 1);
});

test('the mirror restores its spaces after a restart (same storage)', async () => {
  const { memoryDriver } = await import('../src/index.js');
  const disk = memoryDriver();
  const identity = await QuCrypto.generateKeypair();
  let m = await createQu({ root: disk, identity });
  m.use(sync({ role: 'mirror' }));
  m.use(mirror());
  const a = await peer();
  const sa = a.join(await Space.create());
  const link = connectInProcess(a, m);
  await a.write(sa, 'chat', 'x');
  await until(async () => (await m.mirror.count(sa.id)) === 1);
  await link.disconnect();

  m = await createQu({ root: disk, identity });
  m.use(sync({ role: 'mirror' }));
  m.use(mirror());
  assert.deepEqual(await m.mirror.ready, [sa.id]);

  const c = await peer();
  const sc = c.join(await Space.open(sa.secret));
  await connectInProcess(c, m).ready;
  await c.resync({ space: sc });
  assert.deepEqual(await values(c, sc, 'chat'), ['x']);
});
