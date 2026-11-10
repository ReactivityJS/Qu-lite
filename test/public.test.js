import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, fetchPublic, publicLink, packEnvelopes } from '../src/index.js';
import { createRelay } from '../src/node.js';
import { until } from './helpers.js';

const quiet = () => {};

test('public reads: a non-member reads public records of a path, verified; private ones never leave', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const author = await createClient({ url, devtools: false });
  const blog = await author.createGroup();
  await author.write(blog, 'blog', { title: 'Erster Beitrag' }, { visibility: 'public' });
  await author.write(blog, 'blog', { title: 'Zweiter Beitrag' }, { visibility: 'public' });
  await author.write(blog, 'blog', { title: 'Entwurf' }); // private
  await author.write(blog, 'pages', { text: 'v1' }, { key: 'about', visibility: 'public' });
  await author.write(blog, 'pages', { text: 'v2' }, { key: 'about', visibility: 'public' });
  await until(async () => (await author.syncStatus()).outbox === 0, 5000, 'uploaded');

  const posts = await fetchPublic(url, blog.id, 'blog');
  assert.deepEqual(posts.map((p) => p.value.title), ['Zweiter Beitrag', 'Erster Beitrag'], 'newest first, no draft');
  assert.equal(posts[0].author.length, 64);
  const about = await fetchPublic(url, blog.id, 'pages', { key: 'about' });
  assert.deepEqual(about.map((p) => p.value.text), ['v2'], 'newest version of a keyed entry');
  // the link form, and paging
  const link = publicLink(url, blog.id, 'blog');
  assert.equal(link, `${url}/q/${blog.id}/blog`);
  const first = await fetchPublic(link, { limit: 1 });
  assert.equal(first.length, 1);
  assert.ok(first.next, 'a cursor for the next page');
  const second = await fetchPublic(link, { limit: 1, before: first.next });
  assert.deepEqual(second.map((p) => p.value.title), ['Erster Beitrag']);

  // a relay that alters a record is caught: the reader verifies
  const fake = async (input) => {
    const res = await fetch(input);
    const body = await res.json();
    const bytes = Uint8Array.from(atob(body.records[0]), (c) => c.charCodeAt(0));
    bytes[bytes.length - 3] ^= 1;
    body.records[0] = btoa(String.fromCharCode(...bytes));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  assert.equal((await fetchPublic(url, blog.id, 'blog', { fetch: fake })).length, 1, 'the altered one is dropped');

  // unknown space / malformed
  assert.equal((await fetch(`${url}/q/${'0'.repeat(32)}/blog`)).status, 404);
  assert.equal((await fetch(`${url}/q/nope`)).status, 400);
  assert.equal((await fetch(`${url}/q/${blog.id}/blog`, { method: 'OPTIONS' })).status, 204);
  await author.close();
  await relay.close();
});

test('offline delivery over HTTP: POST /q/in ingests sealed envelopes like a link would', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const a = await createClient({ url, devtools: false });
  const group = await a.createGroup();
  await until(async () => (await relay.qu.mirror.spaces()).includes(group.id), 5000, 'grant');
  a.transports.relay.disconnect();
  const rec = await a.write(group, 'chat', 'per http');
  const bytes = await a.storage.get(`rec/${group.id}/${rec.id}`);
  const res = await fetch(`${url}/q/in`, { method: 'POST', body: packEnvelopes([bytes, bytes, new Uint8Array(10)]) });
  const { results } = await res.json();
  assert.deepEqual(results.map((r) => r.status), ['stored', 'duplicate', 'rejected']);
  assert.ok(await relay.qu.storage.has(`rec/${group.id}/${rec.id}`));
  assert.equal((await fetch(`${url}/q/in`, { method: 'POST', body: new Uint8Array([0, 0, 0, 9, 1]) })).status, 400);
  // plain HTTP bypasses the per-link limits: the route has its own ceiling (20/s, burst 40)
  const statuses = await Promise.all(Array.from({ length: 60 }, () => fetch(`${url}/q/in`, { method: 'POST', body: packEnvelopes([bytes]) }).then((r) => r.status)));
  assert.ok(statuses.includes(429) && statuses.includes(200), 'some refused with 429');
  await a.close();
  await relay.close();
});
