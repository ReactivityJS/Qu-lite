import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crypto, grantMessage } from '../src/index.js';
import { fullClient, mirrorNode, connectInProcess, until, settle, values } from './helpers.js';

async function group(...names) {
  const m = await mirrorNode();
  const peers = {};
  for (const name of names) {
    peers[name] = await fullClient();
    peers[name].link = connectInProcess(peers[name], m);
    await peers[name].link.ready;
  }
  const [first, ...rest] = names;
  const spaces = { [first]: await peers[first].createGroup() };
  const admin = await peers[first].members(spaces[first]);
  for (const name of rest) spaces[name] = await peers[name].acceptInvite(await admin.invite());
  const ids = Object.fromEntries(await Promise.all(names.map(async (n) => [n, (await peers[n].members(spaces[n])).me])));
  for (const name of names) await until(async () => (await peers[name].members(spaces[name])).list().length === names.length, 5000, `${name} sees all members`);
  return { m, peers, spaces, ids };
}

test('founder + invite link: roles, aliases instead of identities, chat between members', async () => {
  const { peers, spaces, ids } = await group('alice', 'bob');
  const list = (await peers.bob.members(spaces.bob)).list();
  assert.deepEqual(list.map((e) => e.role).sort(), ['member', 'owner']);
  assert.equal(list.find((e) => e.alias === ids.alice).role, 'owner');
  assert.ok(list.every((e) => !e.identity)); // nobody revealed anything
  await peers.alice.write(spaces.alice, 'chat', 'hallo');
  await until(async () => (await values(peers.bob, spaces.bob, 'chat')).includes('hallo'));

  await (await peers.bob.members(spaces.bob)).reveal({ name: 'Bob' });
  await until(async () => (await peers.alice.members(spaces.alice)).list().some((e) => e.name === 'Bob' && e.verified));
});

test('removing a member: new epoch reaches the others only via sync (_keys), the removed one is locked out', async () => {
  const { m, peers, spaces, ids } = await group('alice', 'bob', 'carol');
  const admin = await peers.alice.members(spaces.alice);
  await peers.bob.link.disconnect(); // bob offline, unaware of what follows

  const epoch = await admin.remove(ids.bob);
  assert.equal(epoch, 1);
  await peers.alice.write(spaces.alice, 'chat', 'nach dem Entfernen');
  await until(async () => spaces.carol.epoch === 1, 5000, 'carol adopts epoch 1');
  await until(async () => (await values(peers.carol, spaces.carol, 'chat')).includes('nach dem Entfernen'));

  const keys = (await peers.carol.query({ space: spaces.carol, path: '_keys' }))[0].value;
  assert.equal(keys.boxes.length % 8, 0);
  assert.equal(Buffer.from(JSON.stringify(keys)).includes(ids.carol), false); // boxes do not name their recipients

  // bob writes offline in the old epoch, then reconnects: the others refuse it, he cannot read epoch 1
  await peers.bob.write(spaces.bob, 'chat', 'heimlich');
  connectInProcess(peers.bob, m);
  await until(async () => (await peers.bob.members(spaces.bob)).role(ids.bob) === 'removed', 5000, 'bob learns removal');
  await settle(200);
  assert.equal(spaces.bob.epoch, 0);
  assert.equal((await values(peers.bob, spaces.bob, 'chat')).includes('nach dem Entfernen'), false);
  assert.equal((await values(peers.carol, spaces.carol, 'chat')).includes('heimlich'), false);
  await assert.rejects(peers.bob.write(spaces.bob, 'chat', 'nochmal'), /not an active member/);
});

test('a removed member cannot announce (and so block) the next epoch at the mirror', async () => {
  const { m, peers, spaces, ids } = await group('alice', 'bob');
  await peers.bob.link.disconnect();
  await (await peers.alice.members(spaces.alice)).remove(ids.bob).catch(() => {});
  // ... but suppose bob races ahead with his own "epoch 2" (he still holds epoch 0/1-era keys and his alias)
  const bobAlias = await spaces.bob.authorFor(peers.bob.identity);
  const forged = { epoch: 2, writePub: crypto.randomBytes(32), by: bobAlias.publicKey };
  forged.sig = await crypto.sign(grantMessage(spaces.bob.id, forged), bobAlias.privateKey);
  const { changed } = await m.keyring.accept(spaces.bob.id, [forged]);
  assert.deepEqual(changed, []);
  // the admin's real next epoch is still accepted
  await (await peers.alice.members(spaces.alice)).rotate();
  await until(async () => (await m.mirror.writeKeys(spaces.alice.id)).has(2), 5000, 'mirror accepts real epoch 2');
});

test('owner promotes an admin, who can then remove members and rotate - accepted by the mirror', async () => {
  const { m, peers, spaces, ids } = await group('alice', 'bob', 'carol');
  await (await peers.alice.members(spaces.alice)).promote(ids.carol, 'admin');
  await until(async () => (await peers.carol.members(spaces.carol)).isAdmin(), 5000, 'carol is admin');
  await until(async () => (await m.mirror.admins(spaces.alice.id)).includes(ids.carol), 5000, 'mirror knows the admin');
  await (await peers.carol.members(spaces.carol)).remove(ids.bob);
  await until(async () => spaces.alice.epoch === 1, 5000, 'alice adopts carol\'s epoch');
  await peers.carol.write(spaces.carol, 'chat', 'von carol');
  await until(async () => (await values(peers.alice, spaces.alice, 'chat')).includes('von carol'));
  assert.equal(await m.mirror.count(spaces.alice.id) > 0, true);
});

test('someone with a leaked link but no invite token never gets in', async () => {
  const { peers, spaces } = await group('alice');
  const eve = await fullClient();
  const { Space } = await import('../src/index.js');
  const leaked = eve.join(await Space.open(spaces.alice.invite));
  await assert.rejects(eve.write(leaked, 'chat', 'ich bin drin'), /not an active member/);
  await assert.rejects((await eve.members(leaked)).join({ id: 'x', role: 'member', by: (await peers.alice.members(spaces.alice)).me, sig: 'AAAA' }), /invite token/);
});

test('a reload keeps every group and every epoch key (joined after a rotation)', async () => {
  const { memoryDriver } = await import('../src/index.js');
  const m = await mirrorNode();
  const alice = await fullClient();
  await connectInProcess(alice, m).ready;
  const space = await alice.createGroup();
  await (await alice.members(space)).rotate();
  await alice.write(space, 'chat', 'in epoch 1');

  const disk = memoryDriver();
  let bob = await fullClient({ root: disk });
  const identity = bob.identity;
  await connectInProcess(bob, m).ready;
  const joined = await bob.acceptInvite(await (await alice.members(space)).invite());
  assert.equal(joined.epoch, 1);
  await until(async () => (await values(bob, joined, 'chat')).includes('in epoch 1'));

  bob = await fullClient({ root: disk, identity }); // reload: fresh process, same storage
  const [restored] = await bob.restoreGroups();
  assert.equal(restored.id, space.id);
  assert.equal(restored.epoch, 1);
  assert.deepEqual(await values(bob, restored, 'chat'), ['in epoch 1']);
});
