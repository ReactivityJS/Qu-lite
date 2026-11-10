import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.js';
import { fullClient, mirrorNode, connectInProcess, until, settle } from './helpers.js';

// short, but with headroom for a loaded CI machine (offline after 2.5 x interval)
const fast = { interval: 300, typingThrottleMs: 0, typingTtlMs: 300, receiptThrottleMs: 20 };

async function client(options = {}) {
  const qu = await fullClient();
  qu.use(status({ ...fast, ...options }));
  return qu;
}

async function setup(names, options = {}) {
  const m = await mirrorNode();
  const peers = {};
  for (const n of names) {
    peers[n] = await client(options[n]);
    peers[n].link = connectInProcess(peers[n], m);
    await peers[n].link.ready;
  }
  const [first, ...rest] = names;
  const spaces = { [first]: await peers[first].createGroup() };
  for (const n of rest) spaces[n] = await peers[n].acceptInvite(await (await peers[first].members(spaces[first])).invite());
  for (const n of names) await until(async () => (await peers[n].members(spaces[n])).list().length === names.length);
  const st = {};
  for (const n of names) st[n] = await peers[n].status(spaces[n]);
  const alias = Object.fromEntries(await Promise.all(names.map(async (n) => [n, (await peers[n].members(spaces[n])).me])));
  return { m, peers, spaces, st, alias };
}

test('presence: online while heartbeats arrive, offline on a clean leave or when they stop', async () => {
  const { m, peers, st, alias } = await setup(['alice', 'bob', 'carol']);
  await until(() => st.bob.isOnline(alias.alice) && st.alice.isOnline(alias.bob), 3000, 'mutual presence');
  await peers.alice.leave();
  await until(() => !st.bob.isOnline(alias.alice), 1000, 'clean leave is immediate');

  await until(() => st.bob.isOnline(alias.carol), 3000);
  await peers.carol.link.disconnect(); // crash: no goodbye
  await until(() => !st.bob.isOnline(alias.carol), 4000, 'timeout after 2.5 intervals');
  connectInProcess(peers.carol, m);
  await until(() => st.bob.isOnline(alias.carol), 4000, 'back online');
});

test('typing indicator appears and expires; presence: false stays invisible', async () => {
  const { st, alias } = await setup(['alice', 'bob', 'shy'], { shy: { presence: false } });
  await st.bob.sendTyping('chat');
  await until(() => st.alice.typing('chat').includes(alias.bob), 2000);
  await until(() => !st.alice.typing('chat').includes(alias.bob), 2000, 'typing expires');
  await st.shy.sendTyping('chat');
  await settle(300);
  assert.equal(st.alice.isOnline(alias.shy), false);
  assert.deepEqual(st.alice.typing('chat'), []);
});

test('sent, delivered and read - with one cursor record per member, not per message', async () => {
  const { m, peers, spaces, st, alias } = await setup(['alice', 'bob', 'carol'], { carol: { readReceipts: false } });
  await peers.carol.link.disconnect();

  const msg1 = await peers.alice.write(spaces.alice, 'chat', 'eins');
  const msg2 = await peers.alice.write(spaces.alice, 'chat', 'zwei');
  await until(async () => (await st.alice.of(msg2)).sent, 3000, 'sent');
  await until(async () => (await st.alice.of(msg2)).delivered.includes(alias.bob), 3000, 'delivered to bob');
  let state = await st.alice.of(msg2);
  assert.deepEqual([state.read, state.members], [[], 2]);

  await st.bob.markRead('chat');
  await until(async () => (await st.alice.of(msg2)).read.includes(alias.bob), 3000, 'read by bob');
  assert.ok((await st.alice.of(msg1)).read.includes(alias.bob));

  // carol was offline: delivered after her resync, never "read" (receipts off)
  connectInProcess(peers.carol, m);
  await until(async () => (await st.alice.of(msg2)).delivered.includes(alias.carol), 5000, 'delivered to carol');
  await st.carol.markRead('chat');
  await settle(200);
  state = await st.alice.of(msg2);
  assert.equal(state.read.includes(alias.carol), false);

  // one cursor per member and conversation (+ superseded versions until compaction)
  const cursors = await peers.alice.query({ space: spaces.alice, path: '_receipts/chat' });
  assert.deepEqual(cursors.map((r) => r.key).sort(), [alias.bob, alias.carol].sort());
});

test('nobody can write somebody else\'s receipt', async () => {
  const { peers, spaces, alias } = await setup(['alice', 'bob']);
  await assert.rejects(peers.bob.write(spaces.bob, '_receipts/chat', { delivered: 'z', read: 'z' }, { key: alias.alice }), /own alias/);
});

test('a newcomer whose first heartbeat arrives before its member entry still becomes visible both ways', async () => {
  const m = await mirrorNode();
  const alice = await client({ interval: 60_000 }); // no help from periodic heartbeats
  const bob = await client({ interval: 60_000 });
  await connectInProcess(alice, m).ready;
  await connectInProcess(bob, m).ready;
  const space = await alice.createGroup();
  const stAlice = await alice.status(space);
  const joined = await bob.acceptInvite(await (await alice.members(space)).invite());
  const stBob = await bob.status(joined);
  const aliceAlias = (await alice.members(space)).me;
  const bobAlias = (await bob.members(joined)).me;
  await until(() => stAlice.isOnline(bobAlias) && stBob.isOnline(aliceAlias), 3000, 'mutual presence without waiting an interval');
});

test('hidden app: the heartbeat slows down, the others keep it online by the announced interval', async () => {
  // visible every 300 ms, hidden every 1500 ms
  const { peers, st, alias } = await setup(['alice', 'bob'], { alice: { hiddenInterval: 1500 } });
  await until(() => st.bob.isOnline(alias.alice), 3000, 'online');
  const beats = [];
  peers.alice.bus.on('net.out.*.sig', () => beats.push(Date.now()));
  peers.alice.status.setHidden(true);
  assert.equal(peers.alice.status.isHidden(), true);
  await settle(100);
  const atHide = beats.length;
  assert.ok(atHide >= 1, 'announces the slower interval at once');
  beats.length = 0;
  await settle(1400);
  assert.ok(beats.length <= 1, `slower while hidden (${beats.length} beats in 1.4 s, visible would be ~4)`);
  assert.ok(st.bob.isOnline(alias.alice), 'still online for bob: he honours the announced interval');
  assert.equal(st.bob.online().get(alias.alice).every, 1500);

  peers.alice.status.setHidden(false);
  await settle(100);
  assert.equal(st.bob.online().get(alias.alice).every, 300, 'visible again: back to the fast interval');
});

test('hidden app with hiddenInterval 0: offline while hidden, online again when visible', async () => {
  const { peers, st, alias } = await setup(['alice', 'bob'], { alice: { hiddenInterval: 0 } });
  await until(() => st.bob.isOnline(alias.alice), 3000, 'online');
  peers.alice.status.setHidden(true);
  await until(() => !st.bob.isOnline(alias.alice), 1000, 'offline at once');
  const beats = [];
  peers.alice.bus.on('net.out.*.sig', () => beats.push(1));
  await settle(800);
  assert.equal(beats.length, 0, 'no heartbeats while hidden');
  peers.alice.status.setHidden(false);
  await until(() => st.bob.isOnline(alias.alice), 1000, 'back');
});
