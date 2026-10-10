import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, sealEnvelope, openEnvelope, peekEnvelope, verifyOuter, formatHlc } from '../src/index.js';

const hlc = formatHlc(1_760_000_123_456, 7);

async function setup() {
  const author = await QuCrypto.generateKeypair();
  const space = await Space.create();
  const sealed = await sealEnvelope(space, { path: 'chat/general', hlc, value: { text: 'hallo' } }, author);
  return { author, space, ...sealed };
}

test('seal/open round-trips path, key, hlc, author and value', async () => {
  const { author, space, bytes, id } = await setup();
  const record = await openEnvelope(space, bytes);
  assert.equal(record.id, id);
  assert.equal(record.path, 'chat/general');
  assert.equal(record.key, null);
  assert.equal(record.hlc, hlc);
  assert.equal(record.author, QuCrypto.toHex(author.publicKey));
  assert.deepEqual(record.value, { text: 'hallo' });
});

test('the public header carries only opaque sid/shard, epoch and a minute-rounded time', async () => {
  const { space, bytes } = await setup();
  const header = peekEnvelope(bytes);
  assert.equal(header.sid, space.id);
  assert.equal(header.shard, QuCrypto.toHex(await space.shardOf('chat/anything')));
  assert.equal(header.epoch, 0);
  assert.equal(header.ts % 60_000, 0);
});

test('raw envelope bytes contain neither path, author nor precise hlc', async () => {
  const { author, bytes } = await setup();
  const raw = Buffer.from(bytes);
  for (const needle of ['chat', 'general', 'hallo', hlc, hlc.slice(0, 13), QuCrypto.toHex(author.publicKey), QuCrypto.toBase64(author.publicKey)]) {
    assert.equal(raw.includes(Buffer.from(needle)), false, `found "${needle}" in plaintext`);
  }
  assert.equal(raw.includes(Buffer.from(author.publicKey)), false);
});

test('tampering with ct or osig is rejected', async () => {
  const { space, bytes } = await setup();
  const ct = bytes.slice();
  ct[ct.length - 1] ^= 1;
  await assert.rejects(openEnvelope(space, ct), /outer signature invalid/);
  const sig = bytes.slice();
  sig[40] ^= 1;
  await assert.rejects(openEnvelope(space, sig), /outer signature invalid/);
});

test('a mirror can check the outer signature with only the write public key', async () => {
  const { space, bytes } = await setup();
  assert.equal(await verifyOuter(bytes, space.epochKeys(0).writePub), true);
  const other = await Space.create();
  assert.equal(await verifyOuter(bytes, other.epochKeys(0).writePub), false);
});

test('another space cannot open the envelope', async () => {
  const { bytes } = await setup();
  const other = await Space.create();
  await assert.rejects(openEnvelope(other, bytes), /another space/);
});

test('a forged envelope signed with a foreign write key is rejected', async () => {
  const { space, author } = await setup();
  // Same sid (attacker knows it from the wire) but no epoch key: they can't produce a valid osig.
  const attackerSpace = await Space.create();
  const forged = await sealEnvelope(attackerSpace, { path: 'chat/x', hlc, value: 'spam' }, author);
  forged.bytes.set(space.sid, 1);
  await assert.rejects(openEnvelope(space, forged.bytes), /outer signature invalid/);
});
