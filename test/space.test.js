import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, sealEnvelope, openEnvelope, formatHlc } from '../src/index.js';

test('the same secret opens the same space; ids are opaque', async () => {
  const a = await Space.create();
  const b = await Space.open(a.secret);
  assert.equal(a.id, b.id);
  assert.equal(a.id.length, 32);
  assert.notEqual(a.id, QuCrypto.toHex(a.secret).slice(0, 32));
});

test('a user space is derived from the identity and named by its pubkey', async () => {
  const alice = await QuCrypto.generateKeypair();
  const s1 = await Space.forUser(alice);
  const s2 = await Space.forUser(alice);
  assert.equal(s1.id, s2.id);
  assert.equal(s1.ownerId, QuCrypto.toHex(alice.publicKey));
  assert.notEqual(s1.id, (await Space.forUser(await QuCrypto.generateKeypair())).id);
});

test('rotating the epoch locks a removed member out of new records', async () => {
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();
  const carol = await QuCrypto.generateKeypair();

  const aliceSpace = await Space.create();
  const bobSpace = await Space.open(aliceSpace.secret);
  const carolSpace = await Space.open(aliceSpace.secret);

  const before = await sealEnvelope(aliceSpace, { path: 'chat', hlc: formatHlc(1), value: 'old' }, alice);
  assert.equal((await openEnvelope(carolSpace, before.bytes)).value, 'old');

  // Carol is removed: new epoch wrapped for Alice and Bob only.
  const wrapped = await aliceSpace.rotate([alice.xPublicKey, bob.xPublicKey], alice);
  await bobSpace.acceptEpoch(wrapped, bob);
  await assert.rejects(carolSpace.acceptEpoch(wrapped, carol), /not a recipient/);

  const after = await sealEnvelope(aliceSpace, { path: 'chat', hlc: formatHlc(2), value: 'new' }, alice);
  assert.equal((await openEnvelope(bobSpace, after.bytes)).value, 'new');
  await assert.rejects(openEnvelope(carolSpace, after.bytes), /unknown epoch 1/);

  // Carol can't forge a new-epoch record either: she only has the epoch-0 write key.
  const forged = await sealEnvelope(carolSpace, { path: 'chat', hlc: formatHlc(3), value: 'forged' }, carol);
  forged.bytes[26] = 1; // claim epoch 1
  await assert.rejects(openEnvelope(bobSpace, forged.bytes), /outer signature invalid/);
});
