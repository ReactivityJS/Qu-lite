import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crypto, encodeFrame } from '../src/index.js';
import { fullClient, mirrorNode, connectInProcess, until, settle, values } from './helpers.js';

test('invite by pubkey through the inbox; the mirror learns neither sender nor content', async () => {
  const m = await mirrorNode();
  const frames = [];
  m.bus.on('net.out.**', (payload, ctx) => frames.push(Buffer.from(encodeFrame(ctx.topic.split('.')[3], payload))));
  const alice = await fullClient();
  const bob = await fullClient();
  await connectInProcess(alice, m).ready;
  await connectInProcess(bob, m).ready;

  const invites = [];
  bob.bus.on('qu.inbox.message', (message) => invites.push(message.payload));
  const space = await alice.createGroup();
  const bobPub = crypto.toHex(bob.identity.publicKey);
  await (await alice.members(space)).invite(bobPub);
  await until(() => invites.length === 1, 5000, 'bob receives the invite');
  assert.equal(invites[0].type, 'invite');
  assert.equal((await bob.inbox.messages()).length, 1);

  const joined = await bob.acceptInvite(invites[0]);
  await alice.write(space, 'chat', 'willkommen');
  await until(async () => (await values(bob, joined, 'chat')).includes('willkommen'));

  // What the mirror holds for bob's inbox and for the group: sealed envelopes only. (Alice's own
  // user node is public by design - that is where her pubkey legitimately appears.)
  const { inboxSidOf } = await import('../src/index.js');
  const inboxSid = crypto.toHex(await inboxSidOf(bob.identity.publicKey));
  const relevant = [];
  for (const sid of [inboxSid, space.id]) for (const key of await m.storage.keys(`rec/${sid}/`)) relevant.push(Buffer.from(await m.storage.get(key)));
  assert.ok(relevant.length >= 3);
  const haystack = Buffer.concat([...relevant, ...frames.filter((f) => f.includes(Buffer.from('rec')))]);
  for (const needle of ['invite', 'willkommen', crypto.toHex(alice.identity.publicKey), crypto.toBase64(alice.identity.publicKey)]) {
    assert.equal(haystack.includes(Buffer.from(needle)), false, `${needle.slice(0, 12)} visible at the mirror`);
  }
  assert.equal(Buffer.concat(relevant).includes(Buffer.from(alice.identity.publicKey)), false);
});

test('inbox disabled: nobody can reach you that way', async () => {
  const m = await mirrorNode();
  const alice = await fullClient();
  const carol = await fullClient({ inbox: { enabled: false } });
  await connectInProcess(alice, m).ready;
  await connectInProcess(carol, m).ready;
  const got = [];
  carol.bus.on('qu.inbox.message', (msg) => got.push(msg));
  await alice.inbox.send(crypto.toHex(carol.identity.publicKey), { type: 'hello' }).catch(() => {});
  await settle(300);
  assert.deepEqual(got, []);
});
