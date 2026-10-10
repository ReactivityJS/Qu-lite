import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from '../src/crypto.js';
import { Space, sealEnvelope, openEnvelope, formatHlc, verifyGrants, emptyGrantState } from '../src/index.js';

test('the same secret opens the same space; ids are opaque', async () => {
  const a = await Space.create();
  const b = await Space.open(a.invite);
  assert.equal(a.id, b.id);
  assert.equal(a.id.length, 32);
  assert.notEqual(a.id, crypto.toHex(a.secret).slice(0, 32));
});

test('a user node is reachable by pubkey, self-certifying, and only its owner can write', async () => {
  const alice = await crypto.generateIdentity();
  const owner = await Space.user(alice.publicKey, alice);
  const visitor = await Space.user(alice.publicKey);
  assert.equal(owner.id, visitor.id);
  assert.equal(owner.ownerId, crypto.toHex(alice.publicKey));
  assert.equal(owner.writable, true);
  assert.equal(visitor.writable, false);
  assert.equal(owner.kind, 'user');
  const { changed } = await verifyGrants(owner.id, await owner.grants(), emptyGrantState());
  assert.deepEqual(changed, ['epoch:0']);
  await assert.rejects(Space.user(alice.publicKey, await crypto.generateIdentity()), /does not match/);
});

test('aliases: stable per identity and space, unlinkable across spaces, not the identity', async () => {
  const alice = await crypto.generateIdentity();
  const s1 = await Space.create();
  const s2 = await Space.create();
  const a1 = await s1.authorFor(alice);
  const a1again = await (await Space.open(s1.invite)).authorFor(alice); // "another device"
  const a2 = await s2.authorFor(alice);
  assert.deepEqual(a1.publicKey, a1again.publicKey);
  assert.notDeepEqual(a1.publicKey, a2.publicKey);
  assert.notDeepEqual(a1.publicKey, alice.publicKey);
  assert.deepEqual((await s1.authorFor(alice, 'identity')).publicKey, alice.publicKey);
});

test('grant chain: owner signs admins, owner/admins sign epochs, nobody else does', async () => {
  const alice = await crypto.generateIdentity();
  const bob = await crypto.generateIdentity();
  const carol = await crypto.generateIdentity();
  const space = await Space.create(alice);
  const ownerKey = await space.authorFor(alice);
  assert.equal(crypto.toHex(ownerKey.publicKey), space.ownerId);
  const bobsView = await Space.open(space.invite);
  const carolKey = await bobsView.authorFor(carol);
  const bobKey = await bobsView.authorFor(bob);

  // only the owner sets admins
  await assert.rejects(bobsView.setAdmins(bobKey, [bobKey.publicKey]), /only the owner/);
  const admins = await space.setAdmins(ownerKey, [carolKey.publicKey]);
  // an admin (carol) may sign the next epoch; a plain member (bob) may not
  const carolsView = await Space.open(space.invite);
  await carolsView.addAdmins(admins);
  const real = await carolsView.rotate(carolKey);
  const fake = await (await Space.open(space.invite)).rotate(bobKey);

  const mirror = emptyGrantState();
  const genesis = await space.grants();
  const step1 = await verifyGrants(space.id, [...genesis, fake.grant], mirror);
  assert.deepEqual(step1.changed, ['epoch:0', `admins:${admins.seq}`]);
  const step2 = await verifyGrants(space.id, [real.grant], step1.state);
  assert.deepEqual(step2.changed, ['epoch:1']);

  // members verify the same way: a key that does not match its grant is refused
  assert.equal(await bobsView.addEpoch(real.grant, crypto.randomBytes(32)), false);
  assert.equal(await bobsView.addAdmins(admins), true);
  assert.equal(await bobsView.addEpoch(real.grant, real.key), true);
  assert.equal(bobsView.hasEpoch(1), true);
});

test('local index tags hide path names and are stable per space', async () => {
  const space = await Space.create();
  const tag = await space.tag('chat/general');
  assert.equal(tag, await (await Space.open(space.invite)).tag('chat/general'));
  assert.notEqual(tag, await (await Space.create()).tag('chat/general'));
  assert.equal(/chat|general/.test(tag), false);
});
