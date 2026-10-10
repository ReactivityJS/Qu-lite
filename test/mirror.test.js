import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from '../src/crypto.js';
import { createQu, createClock, records, sync, mirror, Space, connectInProcess, verifyGrants, emptyGrantState } from '../src/index.js';

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

test('grants: epoch 0 certifies sid and owner; a stranger\'s keys do not match', async () => {
  const space = await Space.create();
  const other = await Space.create();
  const { changed, state } = await verifyGrants(space.id, await space.grants(), emptyGrantState());
  assert.deepEqual(changed, ['epoch:0']);
  assert.deepEqual(state.owner, space.owner);
  assert.deepEqual((await verifyGrants(space.id, await other.grants(), emptyGrantState())).changed, []);
});

test('star: peers only talk to a key-less mirror; live, offline and acks all go through it', async () => {
  const m = await mirrorPeer();
  const a = await peer({ ackFrom: 'mirror' });
  const b = await peer();
  const secret = (await Space.create()).invite;
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

test('a mirror follows an admin-signed epoch rotation', async () => {
  const { fullClient, until: wait } = await import('./helpers.js');
  const m = await mirrorPeer();
  const a = await fullClient();
  await connectInProcess(a, m).ready;
  const space = await a.createGroup();
  await wait(async () => (await m.mirror.spaces()).includes(space.id));
  await (await a.members(space)).rotate();
  await a.write(space, 'chat', 'epoch 1');
  await wait(async () => (await m.mirror.writeKeys(space.id)).has(1));
  await wait(async () => (await m.mirror.count(space.id)) >= 3); // owner entry, _keys, chat
});

test('the mirror restores its spaces after a restart (same storage)', async () => {
  const { memoryDriver } = await import('../src/index.js');
  const disk = memoryDriver();
  const identity = await crypto.generateIdentity();
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
  const sc = c.join(await Space.open(sa.invite));
  await connectInProcess(c, m).ready;
  await c.resync({ space: sc });
  assert.deepEqual(await values(c, sc, 'chat'), ['x']);
});

test('the mirror is a hub: a record it pulls by resync reaches other subscribers live', async () => {
  const m = await mirrorPeer();
  const a = await peer();
  const b = await peer();
  const secret = (await Space.create()).invite;
  const sa = a.join(await Space.open(secret));
  const sb = b.join(await Space.open(secret));
  await b.watch({ space: sb });
  await connectInProcess(b, m).ready;
  await a.write(sa, 'chat', 'written offline'); // a was never connected: only its outbox / a reconcile can deliver it
  connectInProcess(a, m);
  await until(async () => (await values(b, sb, 'chat')).length === 1);
});
