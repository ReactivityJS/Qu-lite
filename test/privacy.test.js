import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { createQu, records, sync, user, mirror, Space, connectInProcess, encodeFrame, sealEnvelope, formatHlc } from '../src/index.js';

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: condition not met in time');
    await settle(10);
  }
}

async function client(options = {}) {
  const qu = await createQu(options);
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000 }));
  qu.use(user());
  return qu;
}
async function mirrorPeer() {
  const qu = await createQu();
  qu.use(sync({ role: 'mirror', timeoutMs: 5000 }));
  qu.use(mirror());
  await qu.mirror.ready;
  return qu;
}

/** Records every frame a peer puts on the wire, encoded exactly as a transport would. */
function tap(qu) {
  const frames = [];
  qu.bus.on('net.out.**', (payload, ctx) => frames.push(Buffer.from(encodeFrame(ctx.topic.split('.')[3], payload))));
  return frames;
}

/** Every key and value in a peer's storage as one searchable buffer. */
async function dump(qu) {
  const parts = [];
  for (const key of await qu.storage.keys('')) {
    parts.push(Buffer.from(key));
    const value = await qu.storage.get(key);
    parts.push(value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value)));
  }
  return Buffer.concat(parts);
}

const needles = (identity) => [Buffer.from(identity.publicKey), Buffer.from(QuCrypto.toHex(identity.publicKey)), Buffer.from(QuCrypto.toBase64(identity.publicKey))];

test('nothing on the wire, at the mirror or in local storage reveals identity, path names or content', async () => {
  const m = await mirrorPeer();
  const alice = await client();
  const bob = await client();
  const secret = (await Space.create()).secret;
  const sa = alice.join(await Space.open(secret));
  const sb = bob.join(await Space.open(secret));
  await bob.watch({ space: sb });
  const wire = [...[alice, bob, m].map(tap)];
  connectInProcess(alice, m);
  connectInProcess(bob, m);

  await alice.write(sa, 'chat/private-group', 'Treffen um 18 Uhr', {});
  await alice.write(sa, 'meta', 'Geheimer Betreff', { key: 'title' });
  await until(async () => (await bob.get(sb, 'meta', 'title')) === 'Geheimer Betreff');

  const frames = Buffer.concat(wire.flat());
  const stores = [await dump(alice), await dump(bob), await dump(m)];
  for (const haystack of [frames, ...stores]) {
    for (const text of ['Treffen', 'Geheimer', 'private-group', 'chat', 'title', 'meta']) assert.equal(haystack.includes(Buffer.from(text)), false, `"${text}" visible`);
    for (const needle of [...needles(alice.identity), ...needles(bob.identity)]) assert.equal(haystack.includes(needle), false, 'identity visible');
  }
});

test('the network id is random and rotatable, never derived from the identity', async () => {
  const a = await client();
  assert.match(a.peerId, /^[0-9a-f]{16}$/);
  assert.notEqual(a.peerId, QuCrypto.toHex(a.identity.publicKey).slice(0, 16));
  const before = a.peerId;
  assert.notEqual(await a.rotateNetId(), before);
});

test('grants go to mirrors only - a plain peer learns nothing about our other spaces', async () => {
  const a = await client();
  const b = await client();
  a.join(await Space.create());
  a.join(await Space.create());
  const grants = [];
  b.bus.on('net.in.*.grant', (g) => grants.push(g.sid));
  connectInProcess(a, b);
  await settle(50);
  assert.deepEqual(grants, []);
});

test('authors are per-space aliases: the same person is unlinkable across spaces', async () => {
  const a = await client();
  const s1 = a.join(await Space.create());
  const s2 = a.join(await Space.create());
  const r1 = await a.write(s1, 'chat', 'x');
  const r2 = await a.write(s2, 'chat', 'y');
  assert.notEqual(r1.author, r2.author);
  assert.notEqual(r1.author, QuCrypto.toHex(a.identity.publicKey));
  // Another device of the same identity signs with the same alias.
  const device2 = await client({ identity: a.identity });
  const s1b = device2.join(await Space.open(s1.secret));
  assert.equal((await device2.write(s1b, 'chat', 'z')).author, r1.author);
});

test('user node: public fields readable by pubkey via the mirror, private ones never leave the owner', async () => {
  const m = await mirrorPeer();
  const alice = await client();
  const bob = await client();
  connectInProcess(alice, m);
  connectInProcess(bob, m);

  const me = await alice.me();
  await me.set('name', 'Alice');
  await me.set('phone', '0123 456', { visibility: 'private' });
  assert.equal(me.id, QuCrypto.toHex(alice.identity.publicKey));

  const aliceForBob = await bob.user(me.id);
  await until(async () => (await aliceForBob.get('name')) === 'Alice');
  const fields = await aliceForBob.fields();
  assert.equal(fields.epub, QuCrypto.toHex(alice.identity.xPublicKey));
  assert.equal('phone' in fields, false);
  assert.equal((await dump(bob)).includes(Buffer.from('0123 456')), false);

  // A second device of Alice gets the private field too.
  const device2 = await client({ identity: alice.identity });
  connectInProcess(device2, m);
  const me2 = await device2.me();
  await until(async () => (await me2.getPrivate('phone')) === '0123 456');

  // Bob cannot write into Alice's node: his view has no write key, and a forged envelope is refused.
  await assert.rejects(bob.write(aliceForBob.space, 'profile', 'hacked', { key: 'name', visibility: 'public' }));
  const bobsNode = await Space.user(bob.identity.publicKey, bob.identity);
  const forged = await sealEnvelope(bobsNode, { path: 'profile', key: 'name', hlc: formatHlc(Date.now()), value: 'hacked', visibility: 'public' }, await bobsNode.authorFor(bob.identity));
  forged.bytes.set(aliceForBob.space.sid, 2);
  assert.equal((await m.envelopes.ingest(forged.bytes, { from: 'test' })).status, 'rejected');
});
