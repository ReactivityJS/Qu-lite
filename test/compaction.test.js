import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createClock, sync, mirror, compaction, memoryDriver, GC_HORIZON_MS } from '../src/index.js';
import { fullClient, connectInProcess, until, values, settle } from './helpers.js';

const fast = { delayMs: 30, expireEveryMs: 0 };

async function client(options = {}) {
  const qu = await fullClient(options);
  qu.use(compaction(fast));
  return qu;
}

async function mirrorWith(options = {}) {
  const qu = await createQu(options);
  qu.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
  qu.use(mirror({ expireEveryMs: 0 }));
  await qu.mirror.ready;
  return qu;
}

/** A mirror and a group: the first name founds it, the others join by invite. */
async function setup(names, { clock } = {}) {
  const m = await mirrorWith({ clock });
  const peers = {};
  for (const n of names) {
    peers[n] = await client({ clock });
    peers[n].link = connectInProcess(peers[n], m);
    await peers[n].link.ready;
  }
  const [first, ...rest] = names;
  const spaces = { [first]: await peers[first].createGroup() };
  for (const n of rest) spaces[n] = await peers[n].acceptInvite(await (await peers[first].members(spaces[first])).invite());
  for (const n of names) await until(async () => (await peers[n].members(spaces[n])).list().length === names.length, 5000, 'members');
  return { m, peers, spaces, sid: spaces[first].id };
}

const holds = (qu, sid, id) => qu.storage.has(`rec/${sid}/${id}`);
const gone = (qu, sid, id) => qu.envelopes.isGone(sid, id);

test('deleting your own message removes it everywhere - mirror included - and resync stays quiet', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'bob']);
  const { alice, bob } = peers;
  const hello = await alice.write(spaces.alice, 'chat', 'hello');
  await alice.write(spaces.alice, 'chat', 'bye');
  await until(async () => (await values(bob, spaces.bob, 'chat')).length === 2, 5000, 'bob has both');

  const deleted = [];
  bob.bus.on('qu.record.deleted', (e) => deleted.push(e.id));
  await alice.del(spaces.alice, hello);
  assert.deepEqual(await values(alice, spaces.alice, 'chat'), ['bye']);
  await until(async () => (await values(bob, spaces.bob, 'chat')).length === 1, 5000, 'gone at bob');
  assert.deepEqual(deleted, [hello.id]);
  await until(async () => gone(m, sid, hello.id), 5000, 'gone at the mirror');
  assert.equal(await holds(m, sid, hello.id), false);
  assert.equal(await holds(bob, sid, hello.id), false);

  const [summary] = await bob.resync({ space: spaces.bob });
  assert.deepEqual([summary.sent, summary.received, summary.missing.length], [0, 0, 0]);
});

test('only your own records - unless owner/admin; a forged drop list is ignored by every peer', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'bob']);
  const { alice, bob } = peers;
  const mine = await alice.write(spaces.alice, 'chat', 'alice was here');
  await until(async () => holds(bob, sid, mine.id), 5000, 'bob has it');

  await assert.rejects(bob.del(spaces.bob, mine.id), /only delete your own/);
  // bypassing the API: a drop list naming alice as author, signed by bob
  const processed = new Promise((resolve) => alice.bus.on('qu.record.processed', (e) => e.status === 'control' && resolve()));
  const bobsAlias = (await bob.members(spaces.bob)).me;
  await bob.records.dropList(spaces.bob, [{ id: mine.id, path: 'chat', ts: mine.ts, author: (await alice.members(spaces.alice)).me }]);
  await processed;
  assert.equal(await holds(alice, sid, mine.id), true);
  assert.equal(await holds(m, sid, mine.id), true);
  assert.equal(await holds(bob, sid, mine.id), true);

  // the owner moderates
  const rude = await bob.write(spaces.bob, 'chat', 'rude');
  await until(async () => holds(alice, sid, rude.id), 5000, 'alice has it');
  assert.notEqual(rude.author, (await alice.members(spaces.alice)).me);
  assert.equal(rude.author, bobsAlias);
  await alice.del(spaces.alice, rude.id);
  await until(async () => !(await holds(bob, sid, rude.id)) && !(await holds(m, sid, rude.id)), 5000, 'moderated');
});

test('deleting a keyed entry leaves a tombstone: an older offline write cannot bring it back', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'bob']);
  const { alice, bob } = peers;
  await alice.write(spaces.alice, 'settings', 'dark', { key: 'theme' });
  await until(async () => (await bob.get(spaces.bob, 'settings', 'theme')) === 'dark', 5000, 'bob sees dark');

  await bob.link.disconnect();
  const light = await bob.write(spaces.bob, 'settings', 'light', { key: 'theme' });
  await settle(5);
  await alice.del(spaces.alice, 'settings', 'theme');
  assert.equal(await alice.get(spaces.alice, 'settings', 'theme'), null);

  bob.link = connectInProcess(bob, m);
  await bob.link.ready;
  await bob.resync({ space: spaces.bob });
  await until(async () => (await bob.get(spaces.bob, 'settings', 'theme')) === null, 5000, 'tombstone wins at bob');
  await until(async () => holds(alice, sid, light.id) || gone(alice, sid, light.id), 5000, 'light reached alice');
  assert.equal(await alice.get(spaces.alice, 'settings', 'theme'), null);
  // bob's own superseded version is compacted away by bob, everywhere
  await until(async () => (await gone(m, sid, light.id)) && (await gone(alice, sid, light.id)), 5000, 'light dropped');
});

test('auto-compaction: superseded own versions leave every peer, only the current one stays', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'bob']);
  const { alice, bob } = peers;
  const versions = [];
  for (let i = 0; i < 20; i++) versions.push((await alice.write(spaces.alice, 'settings', i, { key: 'counter' })).id);
  const old = versions.slice(0, -1);
  for (const qu of [alice, bob, m]) {
    await until(async () => (await Promise.all(old.map((id) => gone(qu, sid, id)))).every(Boolean), 5000, 'old versions dropped');
    assert.equal(await holds(qu, sid, versions.at(-1)), true);
  }
  assert.equal(await bob.get(spaces.bob, 'settings', 'counter'), 19);
  const [summary] = await bob.resync({ space: spaces.bob });
  assert.deepEqual([summary.sent, summary.received], [0, 0]);
});

test('a stale device learns the drop list instead of re-uploading; a new peer never downloads dropped versions', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'carol']);
  const { alice, carol } = peers;
  const v1 = await alice.write(spaces.alice, 'profile', 'v1', { key: 'bio' });
  await until(async () => holds(carol, sid, v1.id), 5000, 'carol has v1');
  await carol.link.disconnect();
  await alice.write(spaces.alice, 'profile', 'v2', { key: 'bio' });
  await until(async () => gone(m, sid, v1.id), 5000, 'v1 dropped at the mirror');

  carol.link = connectInProcess(carol, m);
  await carol.link.ready;
  await carol.resync({ space: spaces.carol });
  await until(async () => gone(carol, sid, v1.id), 5000, 'carol applied the drop list');
  assert.equal(await holds(carol, sid, v1.id), false);
  assert.equal(await holds(m, sid, v1.id), false);
  assert.equal(await carol.get(spaces.carol, 'profile', 'bio'), 'v2');

  const dave = await client();
  connectInProcess(dave, m);
  const sd = await dave.acceptInvite(await (await alice.members(spaces.alice)).invite());
  const [summary] = await dave.resync({ space: sd });
  assert.deepEqual(summary.missing, []);
  assert.equal(await holds(dave, sid, v1.id), false);
  assert.equal(await gone(dave, sid, v1.id), true);
  await until(async () => (await dave.get(sd, 'profile', 'bio')) === 'v2', 5000, 'dave reads v2');
});

test('a drop list with a false author claim does not suppress the real record', async () => {
  const { m, peers, spaces, sid } = await setup(['alice', 'bob', 'carol']);
  const { alice, bob, carol } = peers;
  await carol.link.disconnect();
  const real = await carol.write(spaces.carol, 'chat', 'from carol');
  // bob claims the (not yet published) id as his own and drops it
  await bob.records.dropList(spaces.bob, [{ id: real.id, path: 'chat', ts: real.ts, author: (await bob.members(spaces.bob)).me }]);
  await until(async () => gone(m, sid, real.id), 5000, 'marker at the mirror');

  carol.link = connectInProcess(carol, m);
  await carol.link.ready;
  await carol.resync({ space: spaces.carol });
  await until(async () => holds(m, sid, real.id), 5000, 'mirror stores the real record');
  assert.equal(await gone(m, sid, real.id), false);
  await until(async () => (await values(alice, spaces.alice, 'chat')).includes('from carol'), 5000, 'alice gets it');
});

test('drop lists expire after the horizon on every peer alike; reconcile stays quiet', async () => {
  const time = { now: Date.now() };
  const clock = () => createClock({ now: () => time.now });
  const m = await mirrorWith({ clock: clock() });
  const alice = await client({ clock: clock() });
  const bob = await client({ clock: clock() });
  for (const qu of [alice, bob]) await connectInProcess(qu, m).ready;
  const sa = await alice.createGroup();
  const sb = await bob.acceptInvite(await (await alice.members(sa)).invite());
  const msg = await alice.write(sa, 'chat', 'short-lived');
  await until(async () => holds(bob, sa.id, msg.id), 5000, 'bob has it');
  await alice.del(sa, msg);
  await until(async () => (await gone(bob, sa.id, msg.id)) && (await gone(m, sa.id, msg.id)), 5000, 'dropped');

  time.now += GC_HORIZON_MS + 2 * 24 * 60 * 60 * 1000;
  assert.equal((await alice.compact(sa)).expired, 1);
  assert.equal(await bob.compaction.expireAll(), 1);
  assert.equal(await m.mirror.expire(), 1);
  for (const qu of [alice, bob, m]) {
    assert.equal(await gone(qu, sa.id, msg.id), false);
    assert.deepEqual(await qu.storage.keys(`gcs/${sa.id}/`), []);
  }
  const [summary] = await bob.resync({ space: sb });
  assert.deepEqual([summary.sent, summary.received], [0, 0]);
});

test('forget() removes everything this peer stored for a space', async () => {
  const { peers, spaces, sid } = await setup(['alice']);
  const { alice } = peers;
  const msg = await alice.write(spaces.alice, 'chat', 'x');
  await alice.del(spaces.alice, msg);
  await alice.write(spaces.alice, 'settings', 1, { key: 'a' });
  assert.ok((await alice.forget(spaces.alice)) > 0);
  for (const prefix of ['rec', 'sx', 'idx', 'head', 'loc', 'defer', 'gone', 'gcs', 'sync/out']) assert.deepEqual(await alice.storage.keys(`${prefix}/${sid}/`), [], prefix);
});

test('a drop list whose commit fails deletes nothing', async () => {
  const inner = memoryDriver();
  const root = { ...inner, failing: 0, async batch(ops) {
    if (root.failing-- > 0) throw new Error('disk full');
    return inner.batch(ops);
  } };
  const alice = await client({ root });
  const space = await alice.createGroup();
  const msg = await alice.write(space, 'chat', 'keep me');
  root.failing = 1;
  await assert.rejects(alice.del(space, msg), /disk full/);
  assert.deepEqual(await values(alice, space, 'chat'), ['keep me']);
  assert.equal(await gone(alice, space.id, msg.id), false);
  await alice.del(space, msg);
  assert.deepEqual(await values(alice, space, 'chat'), []);
});
