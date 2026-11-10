import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, fetchPublic, sealEnvelope, formatHlc, packEnvelopes, crypto } from '../src/index.js';
import { createRelay } from '../src/node.js';
import { until, settle } from './helpers.js';

const quiet = () => {};
const texts = async (qu, space, path = 'posts') => (await qu.query({ space, path })).map((r) => r.value).sort();

test('open space: anyone with the link writes without invite; bans hold at members and relay; admins delete', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const mod = await createClient({ url, devtools: false });
  const forum = await mod.createGroup({ open: true });
  const m = await mod.members(forum);
  assert.equal(m.open, true);
  const link = await m.link();
  assert.equal(link.token, undefined, 'no invite token');

  const guest = await createClient({ url, devtools: false });
  const troll = await createClient({ url, devtools: false });
  const gs = await guest.acceptInvite(link);
  const ts = await troll.acceptInvite(link);
  await guest.write(gs, 'posts', 'Hallo Forum', { visibility: 'public' });
  await troll.write(ts, 'posts', 'spam 1', { visibility: 'public' });
  await until(async () => (await texts(mod, forum)).length === 2, 5000, 'posts of non-members accepted');
  assert.equal((await guest.members(gs)).open, true);

  // ban: the troll's later records are refused - by members and by the relay
  const trollAlias = (await troll.members(ts)).me;
  await m.ban(trollAlias);
  assert.deepEqual(m.bans(), [trollAlias]);
  await until(async () => (await troll.members(ts)).bans().includes(trollAlias), 5000, 'the ban reaches the troll');
  await assert.rejects(troll.write(ts, 'posts', 'spam 2'), /banned/, 'an honest client refuses locally');
  await guest.write(gs, 'posts', 'noch da', { visibility: 'public' });
  await until(async () => (await texts(mod, forum)).includes('noch da'), 5000);

  // an admin deletes the troll's old post for everyone
  const old = (await mod.query({ space: forum, path: 'posts' })).find((r) => r.value === 'spam 1');
  await mod.del(forum, old);
  await until(async () => !(await texts(guest, gs)).includes('spam 1'), 5000, 'deleted at the guest');
  await until(async () => !(await fetchPublic(url, forum.id, 'posts')).some((r) => r.value === 'spam 1'), 5000, 'and at the relay');
  // guests read without joining at all
  assert.deepEqual((await fetchPublic(url, forum.id, 'posts')).map((r) => r.value).sort(), ['Hallo Forum', 'noch da']);

  for (const qu of [mod, guest, troll]) await qu.close();
  await relay.close();
});

test('open space at the relay: a modified client is refused after its ban; fresh writes are rate limited per author', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const mod = await createClient({ url, devtools: false });
  const forum = await mod.createGroup({ open: true });
  const link = await (await mod.members(forum)).link();
  const troll = await createClient({ devtools: false }); // offline: it talks to the relay by hand
  const ts = await troll.acceptInvite(link);
  const author = await ts.authorFor(troll.identity);
  let n = 0;
  // what a modified client would send: validly signed, the local rules skipped
  const forge = async (at = Date.now()) => (await sealEnvelope(ts, { path: 'posts', hlc: formatHlc(at, n++), value: `p${n}` }, author)).bytes;
  const post = async (list) => (await (await fetch(`${url}/q/in`, { method: 'POST', body: packEnvelopes(list) })).json()).results;
  await until(async () => (await relay.qu.storage.get(`mirror/mod/${forum.id}`))?.open === true, 5000, 'the relay knows the space is open');

  // rate: a burst of 20 fresh records passes, the rest is refused for now ('rate': an honest outbox retries)
  const results = await post(await Promise.all(Array.from({ length: 26 }, () => forge())));
  assert.equal(results.filter((r) => r.status === 'stored').length, 20);
  assert.deepEqual([...new Set(results.slice(20).map((r) => r.reason))], ['rate']);
  // old records (a member syncing a backlog) are not limited
  const backlog = await post(await Promise.all(Array.from({ length: 5 }, () => forge(Date.now() - 3600_000))));
  assert.deepEqual(backlog.map((r) => r.status), ['stored', 'stored', 'stored', 'stored', 'stored']);
  // the owner is never limited
  for (let i = 0; i < 25; i++) await mod.write(forum, 'posts', `mod ${i}`);
  await until(async () => (await mod.syncStatus()).outbox === 0, 5000, 'owner not limited');

  // ban: what the troll writes afterwards is refused by the relay, even from a modified client
  const alias = crypto.toHex(author.publicKey);
  await (await mod.members(forum)).ban(alias);
  await until(async () => (await relay.qu.storage.get(`mirror/mod/${forum.id}`))?.bans?.[alias]?.ban === true, 5000, 'relay knows the ban');
  const after = await post([await forge(Date.now() + 120_000)]);
  assert.equal(after[0].reason, 'banned');
  await mod.close();
  await troll.close();
  await relay.close();
});
