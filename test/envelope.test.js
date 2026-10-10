import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from '../src/crypto.js';
import { Space, sealEnvelope, openEnvelope, peekEnvelope, verifyEnvelope, formatHlc } from '../src/index.js';

const hlc = formatHlc(1_760_000_123_456, 7);

async function setup(visibility = 'private') {
  const identity = await crypto.generateIdentity();
  const space = await Space.create();
  const author = await space.authorFor(identity);
  const sealed = await sealEnvelope(space, { path: 'chat/general', hlc, value: { text: 'hallo' }, visibility }, author);
  return { identity, author, space, ...sealed };
}

test('seal/open round-trips path, key, hlc, author and value', async () => {
  const { author, space, bytes, id } = await setup();
  const record = await openEnvelope(space, bytes);
  assert.equal(record.id, id);
  assert.equal(record.path, 'chat/general');
  assert.equal(record.key, null);
  assert.equal(record.hlc, hlc);
  assert.equal(record.author, crypto.toHex(author.publicKey));
  assert.deepEqual(record.value, { text: 'hallo' });
});

test('the public header carries opaque ids, epoch, a minute-rounded time and the ALIAS - never the identity', async () => {
  const { identity, author, space, bytes } = await setup();
  const header = peekEnvelope(bytes);
  assert.equal(header.sid, space.id);
  assert.equal(header.shard, crypto.toHex(await space.shardOf('chat/anything')));
  assert.equal(header.epoch, 0);
  assert.equal(header.ts % 60_000, 0);
  assert.equal(header.visibility, 'private');
  assert.equal(header.author, crypto.toHex(author.publicKey));
  assert.notEqual(header.author, crypto.toHex(identity.publicKey));
});

test('raw envelope bytes contain neither path, value, precise hlc nor the identity', async () => {
  const { identity, bytes } = await setup();
  const raw = Buffer.from(bytes);
  for (const needle of ['chat', 'general', 'hallo', hlc, hlc.slice(0, 13)]) {
    assert.equal(raw.includes(Buffer.from(needle)), false, `found "${needle}" in plaintext`);
  }
  assert.equal(raw.includes(Buffer.from(identity.publicKey)), false);
});

test('anyone can verify both signatures on the sealed bytes without any key', async () => {
  const { space, bytes } = await setup();
  const writePub = space.writeKeys().get(0);
  assert.equal(await verifyEnvelope(bytes, writePub), true);
  assert.equal(await verifyEnvelope(bytes, (await Space.create()).writeKeys().get(0)), false);
});

test('tampering with ct, header, author signature or membership signature is rejected', async () => {
  const { space, bytes } = await setup();
  const writePub = space.writeKeys().get(0);
  for (const offset of [bytes.length - 1, 30, 70, 140]) {
    const copy = bytes.slice();
    copy[offset] ^= 1;
    assert.equal(await verifyEnvelope(copy, writePub), false, `byte ${offset}`);
    await assert.rejects(openEnvelope(space, copy));
  }
});

test('a non-member cannot forge a record: no epoch write key, no valid membership signature', async () => {
  const { space } = await setup();
  const attacker = await crypto.generateIdentity();
  const attackerSpace = await Space.create();
  const forged = await sealEnvelope(attackerSpace, { path: 'chat/x', hlc, value: 'spam' }, attacker);
  forged.bytes.set(space.sid, 2);
  assert.equal(await verifyEnvelope(forged.bytes, space.writeKeys().get(0)), false);
});

test('another space cannot open the envelope', async () => {
  const { bytes } = await setup();
  await assert.rejects(openEnvelope(await Space.create(), bytes), /another space/);
});

test('public records are signed and readable without the space key', async () => {
  const owner = await crypto.generateIdentity();
  const mine = await Space.user(owner.publicKey, owner);
  const { bytes } = await sealEnvelope(mine, { path: 'profile', key: 'name', hlc, value: 'Anna', visibility: 'public' }, await mine.authorFor(owner));
  const strangersView = await Space.user(owner.publicKey);
  assert.equal(await verifyEnvelope(bytes, owner.publicKey), true);
  assert.equal((await openEnvelope(strangersView, bytes)).value, 'Anna');
  const secret = await sealEnvelope(mine, { path: 'profile', key: 'phone', hlc, value: '0123' }, await mine.authorFor(owner));
  await assert.rejects(openEnvelope(strangersView, secret.bytes), /no key to read/);
  assert.equal((await openEnvelope(mine, secret.bytes)).value, '0123');
});
