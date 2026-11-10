/**
 * Redundancy with several relays (relay.js `url: [a, b]`): every relay is
 * kept connected; one going down changes nothing for the app; when it comes
 * back it receives what it missed through the reconcile. With `isolate`,
 * each space gets its own connection per relay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, Space } from '../src/index.js';
import { createRelay } from '../src/node.js';
import { until } from './helpers.js';

const ws = { WebSocketImpl: WebSocket, minDelayMs: 50, maxDelayMs: 200 };
const chat = async (qu, space) => (await qu.query({ space, path: 'chat' })).map((r) => r.value);

test('two relays: one goes down, chat continues over the other; back up, it catches up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qu-multi-'));
  let a = await createRelay({ port: 0, host: '127.0.0.1', db: join(dir, 'a.sqlite'), log: () => {} });
  const b = await createRelay({ port: 0, host: '127.0.0.1', db: join(dir, 'b.sqlite'), log: () => {} });
  const urls = [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`];
  const portA = a.port;
  const anna = await createClient({ url: urls, relay: ws, devtools: false });
  const ben = await createClient({ url: urls, relay: ws, devtools: false });
  try {
    await until(() => anna.transports.relay.status().filter((s) => s.connected).length === 2, 5000, 'anna on both');
    assert.deepEqual(anna.transports.relay.urls, urls);
    const group = await anna.createGroup();
    const shared = await ben.acceptInvite(await (await anna.members(group)).invite());
    await anna.write(group, 'chat', 'eins');
    await until(async () => (await chat(ben, shared)).includes('eins'), 5000, 'ben has eins');
    await until(async () => (await a.qu.mirror.count(group.id)) > 0 && (await b.qu.mirror.count(group.id)) > 0, 5000, 'both relays store the group');

    // relay A goes away
    await a.close();
    await anna.write(group, 'chat', 'zwei');
    await ben.write(shared, 'chat', 'drei');
    await until(async () => (await chat(ben, shared)).includes('zwei'), 5000, 'ben gets zwei via B');
    await until(async () => (await chat(anna, group)).includes('drei'), 5000, 'anna gets drei via B');
    await until(async () => (await anna.syncStatus()).outbox === 0 && (await ben.syncStatus()).outbox === 0, 5000, 'acked by B alone');

    // relay A comes back on its old database and port: it catches up from the clients
    a = await createRelay({ port: portA, host: '127.0.0.1', db: join(dir, 'a.sqlite'), log: () => {} });
    const all = await b.qu.mirror.count(group.id);
    await until(async () => (await a.qu.mirror.count(group.id)) === all, 10_000, 'A has everything B has');

    // and a third device that only knows relay A sees the whole chat
    const carla = await createClient({ url: urls[0], relay: ws, devtools: false });
    try {
      const space = await carla.acceptInvite(await (await anna.members(group)).invite());
      await until(async () => (await chat(carla, space)).length === 3, 10_000, 'carla reads everything from A');
      assert.deepEqual((await chat(carla, space)).sort(), ['drei', 'eins', 'zwei']);
    } finally {
      await carla.close();
    }
  } finally {
    await Promise.all([anna.close(), ben.close()]);
    await Promise.all([a.close(), b.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two relays with isolate: one connection per space and relay, each with its own network id', async () => {
  const a = await createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  const b = await createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  const urls = [`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`];
  const qu = await createClient({ url: urls, relay: { ...ws, isolate: true }, devtools: false });
  try {
    qu.join(await Space.create(qu.identity));
    qu.join(await Space.create(qu.identity));
    // shared connection + one per joined space, on each relay - wait until every one is up
    await until(() => {
      const all = qu.transports.relay.status();
      return all.length >= 6 && all.every((s) => s.connected && s.peer);
    }, 5000, 'all connected');
    const scoped = qu.transports.relay.status().filter((s) => s.scope);
    const perRelay = (url) => scoped.filter((s) => s.url === url).length;
    assert.equal(perRelay(urls[0]), perRelay(urls[1]), 'the same spaces on both relays');
    assert.equal(new Set(scoped.map((s) => s.peer)).size, scoped.length, 'a separate connection each');
    qu.transports.relay.disconnect();
    assert.deepEqual(qu.transports.relay.status(), []);
  } finally {
    await qu.close();
    await Promise.all([a.close(), b.close()]);
  }
});
