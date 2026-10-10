import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, sealEnvelope, openEnvelope, formatHlc, verifyGrants } from '../src/index.js';

test('the same secret opens the same space; ids are opaque', async () => {
  const a = await Space.create();
  const b = await Space.open(a.secret);
  assert.equal(a.id, b.id);
  assert.equal(a.id.length, 32);
  assert.notEqual(a.id, QuCrypto.toHex(a.secret).slice(0, 32));
});

test('a user node is reachable by pubkey, self-certifying, and only its owner can write', async () => {
  const alice = await QuCrypto.generateKeypair();
  const owner = await Space.user(alice.publicKey, alice);
  const visitor = await Space.user(alice.publicKey);
  assert.equal(owner.id, visitor.id);
  assert.equal(owner.ownerId, QuCrypto.toHex(alice.publicKey));
  assert.equal(owner.writable, true);
  assert.equal(visitor.writable, false);
  assert.equal(owner.kind, 'user');
  const grants = await owner.grants();
  assert.deepEqual([...(await verifyGrants(owner.id, grants, new Map())).keys()], [0]);
  await assert.rejects(Space.user(alice.publicKey, await QuCrypto.generateKeypair()), /does not match/);
});

test('aliases: stable per identity and space, unlinkable across spaces, not the identity', async () => {
  const alice = await QuCrypto.generateKeypair();
  const s1 = await Space.create();
  const s2 = await Space.create();
  const a1 = await s1.authorFor(alice);
  const a1again = await (await Space.open(s1.secret)).authorFor(alice); // "another device"
  const a2 = await s2.authorFor(alice);
  assert.deepEqual(a1.publicKey, a1again.publicKey);
  assert.notDeepEqual(a1.publicKey, a2.publicKey);
  assert.notDeepEqual(a1.publicKey, alice.publicKey);
  assert.deepEqual((await s1.authorFor(alice, 'identity')).publicKey, alice.publicKey);
});

test('rotating the epoch locks a removed member out of new records', async () => {
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();
  const carol = await QuCrypto.generateKeypair();

  const aliceSpace = await Space.create();
  const bobSpace = await Space.open(aliceSpace.secret);
  const carolSpace = await Space.open(aliceSpace.secret);
  const signer = await aliceSpace.authorFor(alice);

  const before = await sealEnvelope(aliceSpace, { path: 'chat', hlc: formatHlc(1), value: 'old' }, signer);
  assert.equal((await openEnvelope(carolSpace, before.bytes)).value, 'old');

  // Carol is removed: new epoch wrapped for Alice and Bob only.
  const wrapped = await aliceSpace.rotate([alice.xPublicKey, bob.xPublicKey], alice);
  await bobSpace.acceptEpoch(wrapped, bob);
  await assert.rejects(carolSpace.acceptEpoch(wrapped, carol), /not a recipient/);

  const after = await sealEnvelope(aliceSpace, { path: 'chat', hlc: formatHlc(2), value: 'new' }, signer);
  assert.equal((await openEnvelope(bobSpace, after.bytes)).value, 'new');
  await assert.rejects(openEnvelope(carolSpace, after.bytes), /unknown epoch 1/);

  // Carol can't forge a new-epoch record either: she only has the epoch-0 write key.
  const forged = await sealEnvelope(carolSpace, { path: 'chat', hlc: formatHlc(3), value: 'forged' }, await carolSpace.authorFor(carol));
  forged.bytes[27] = 1; // claim epoch 1
  await assert.rejects(openEnvelope(bobSpace, forged.bytes), /signature invalid/);
});

test('local index tags hide path names and are stable per space', async () => {
  const space = await Space.create();
  const tag = await space.tag('chat/general');
  assert.equal(tag, await (await Space.open(space.secret)).tag('chat/general'));
  assert.notEqual(tag, await (await Space.create()).tag('chat/general'));
  assert.equal(/chat|general/.test(tag), false);
});
