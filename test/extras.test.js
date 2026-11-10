import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createPeer, checkFormat, readArchive, describeCredential } from '../src/index.js';
import { memoryDriver } from '../src/drivers/memory.js';
import { createRelay } from '../src/node.js';
import { until, settle } from './helpers.js';

test('live: renders at once, again on changes of its path (coalesced, only when different), stops', async () => {
  const qu = await createClient({ devtools: false, extra: ['live'] });
  const g = await qu.createGroup();
  const renders = [];
  const stop = qu.live({ space: g, path: 'events', where: { day: { gte: 10 } }, orderBy: 'day' }, (rows) => renders.push(rows.map((r) => r.value.title)));
  await until(() => renders.length === 1);
  assert.deepEqual(renders[0], []);
  for (let i = 0; i < 20; i++) await qu.write(g, 'events', { title: `e${i}`, day: i }, { key: `e${i}` });
  await until(() => renders.at(-1)?.length === 10, 3000, 'burst rendered');
  assert.ok(renders.length <= 4, `coalesced (${renders.length} renders for 20 writes)`);
  const before = renders.length;
  await qu.write(g, 'other', 'x'); // another path: no re-render
  await qu.write(g, 'events', { title: 'early', day: 1 }, { key: 'early' }); // matches the path, not the result
  await settle(100);
  assert.equal(renders.length, before, 'unchanged result: no render');
  await qu.del(g, 'events', 'e15');
  await until(() => !renders.at(-1).includes('e15'), 3000, 'deletion rendered');
  stop();
  await qu.write(g, 'events', { title: 'late', day: 99 }, { key: 'late' });
  await settle(100);
  assert.ok(!renders.at(-1).includes('late'), 'stopped');
  await qu.close();
});

test('schema: invalid writes fail here, invalid records from elsewhere are refused', async () => {
  const strict = await createClient({ devtools: false, extra: [['schema', { events: { title: 'string', start: 'number', tags: 'string[]?' }, chat: 'string', 'files/': { name: 'string' }, scores: (v) => v.points >= 0 || 'points must not be negative' }]] });
  const g = await strict.createGroup();
  await strict.write(g, 'events', { title: 'ok', start: 1, tags: ['a'] });
  await assert.rejects(strict.write(g, 'events', { title: 'no start' }), (e) => e.code === 'QU_INVALID' && /start is missing/.test(e.message));
  await assert.rejects(strict.write(g, 'chat', { not: 'a string' }), /chat must be string/);
  await assert.rejects(strict.write(g, 'files/img/1', { size: 3 }), /name is missing/);
  await assert.rejects(strict.write(g, 'scores', { points: -1 }), /negative/);
  await strict.write(g, 'free', { anything: true }); // no rule: not checked
  strict.schema('polls', { question: 'string' });
  await assert.rejects(strict.write(g, 'polls', {}), /question/);
  await strict.del(g, (await strict.query({ space: g, path: 'events' }))[0]); // deletions are never checked

  // a lax peer writes what the strict one refuses: refused on arrival, never shown
  const lax = await createClient({ devtools: false });
  const lg = await lax.acceptInvite(await (await strict.members(g)).invite());
  const rejected = [];
  strict.bus.on('qu.record.rejected', (e) => rejected.push(e.reason));
  const { connectInProcess } = await import('../src/index.js');
  const link = connectInProcess(strict, lax);
  await link.ready;
  await lax.write(lg, 'events', { title: 'bad', start: 'tomorrow' });
  await lax.write(lg, 'events', { title: 'good', start: 5 });
  await until(async () => (await strict.query({ space: g, path: 'events' })).some((r) => r.value.title === 'good'), 5000);
  assert.ok(!(await strict.query({ space: g, path: 'events' })).some((r) => r.value.title === 'bad'));
  assert.ok(rejected.some((r) => /invalid: start must be number/.test(r)));
  await link.disconnect();
  await strict.close();
  await lax.close();
});

test('storage format: new stores are marked, older ones migrated, newer ones refused', async () => {
  const store = memoryDriver();
  const qu = await createPeer({ store });
  assert.equal(await store.get('qu/format'), 1);
  await qu.close();
  // a store from a newer version: refused before anything is written
  await store.set('qu/format', 7);
  await assert.rejects(createPeer({ store }), (e) => e.code === 'QU_FORMAT_NEWER');
  // migrations run in order, the marker moves step by step
  const old = memoryDriver();
  await old.set('qu/format', 1);
  await old.set('legacy', 'a');
  const ran = [];
  const result = await checkFormat(old, { format: 3, migrations: { 1: async (s) => ran.push(1) && s.set('legacy', 'b'), 2: async () => ran.push(2) } });
  assert.deepEqual([result, ran, await old.get('qu/format'), await old.get('legacy')], [{ from: 1, to: 3 }, [1, 2], 3, 'b']);
});

test('storage full: one event, a clear error code, the write fails cleanly', async () => {
  const disk = memoryDriver();
  let full = false;
  const set = disk.set.bind(disk);
  const batch = disk.batch.bind(disk);
  const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  disk.set = (k, v) => (full ? Promise.reject(quota()) : set(k, v));
  disk.batch = (ops) => (full ? Promise.reject(quota()) : batch(ops));
  const qu = await createClient({ store: disk, devtools: false });
  const g = await qu.createGroup();
  const events = [];
  qu.bus.on('qu.storage.full', (e) => events.push(e));
  full = true;
  await assert.rejects(qu.write(g, 'chat', 'x'), (e) => e.code === 'QU_STORAGE_FULL');
  await assert.rejects(qu.write(g, 'chat', 'y'), (e) => e.code === 'QU_STORAGE_FULL');
  assert.equal(events.length, 1, 'throttled');
  full = false;
  await qu.write(g, 'chat', 'z'); // space again: works
  assert.deepEqual((await qu.query({ space: g, path: 'chat' })).map((r) => r.value), ['z']);
  await qu.close();
});

test('archive: a space or a whole user to a file and back; verified on import; works for relays too', async () => {
  const a = await createClient({ devtools: false, extra: ['archive'] });
  const g = await a.createGroup();
  for (let i = 0; i < 5; i++) await a.write(g, 'chat', `m${i}`);
  const other = await a.createGroup();
  await a.write(other, 'notes', 'n');
  const one = await a.archive.export({ spaces: [g] });
  assert.equal(readArchive(one).spaces.length, 1);
  assert.equal(readArchive(one).backup, null, 'no keys inside without a passphrase');

  // a whole user: every space plus the sealed keys
  const all = await a.archive.export({ passphrase: 'lange passphrase 123' });
  const { backup, spaces } = readArchive(all);
  assert.ok(backup.startsWith('qu-backup.'));
  assert.ok(spaces.length >= 3, 'groups and the user node');
  const b = await createClient({ devtools: false, extra: ['archive'], restore: { backup, passphrase: 'lange passphrase 123' } });
  const counts = await b.archive.import(all);
  assert.equal(counts.rejected, 0);
  assert.ok(counts.stored > 0);
  const restored = await b.restoreGroups();
  assert.deepEqual(restored.map((s) => s.id).sort(), [g.id, other.id].sort());
  assert.deepEqual((await b.query({ space: b.space(g.id), path: 'chat' })).map((r) => r.value), ['m0', 'm1', 'm2', 'm3', 'm4']);
  const held = (await b.storage.keys('rec/')).length;
  assert.equal((await b.archive.import(all)).rejected, 0);
  assert.equal((await b.storage.keys('rec/')).length, held, 'a second import changes nothing');

  // tampering is caught: a changed envelope is rejected, a broken file refused
  const bad = all.slice();
  bad[bad.length - 5] ^= 1;
  const c = await createClient({ devtools: false, extra: ['archive'] });
  assert.equal((await c.archive.import(bad)).rejected, 1);
  assert.throws(() => readArchive(new Uint8Array(20)), (e) => e.code === 'QU_ARCHIVE_INVALID');

  // moving a relay: export there, import into a new one
  const relay = await createRelay({ port: 0, log: () => {} });
  const d = await createClient({ url: `http://127.0.0.1:${relay.port}`, devtools: false });
  const dg = await d.createGroup();
  await d.write(dg, 'chat', 'auf dem alten Relay');
  await until(async () => (await d.syncStatus()).outbox === 0, 5000);
  const { archive } = await import('../src/index.js');
  const relayArchive = archive()(relay.qu);
  const moved = await relayArchive.export();
  const relay2 = await createRelay({ port: 0, log: () => {} });
  const result = await archive()(relay2.qu).import(moved);
  assert.equal(result.rejected, 0);
  assert.ok(await relay2.qu.storage.has(`rec/${dg.id}/${(await d.query({ space: dg, path: 'chat' }))[0].id}`), 'the new relay has it, verified');
  for (const qu of [a, b, c, d]) await qu.close();
  await relay.close();
  await relay2.close();
});

test('describeCredential: kind, transports and provider from what the browser returns', () => {
  const aaguid = (hex) => {
    const data = new Uint8Array(55);
    data.set(hex.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)), 37);
    return data.buffer;
  };
  const cred = (attachment, transports, id = '00000000-0000-0000-0000-000000000000') => ({ authenticatorAttachment: attachment, response: { getTransports: () => transports, getAuthenticatorData: () => aaguid(id) } });
  assert.equal(describeCredential(cred('cross-platform', ['usb', 'nfc'])).label, 'Security key (USB, NFC)');
  assert.equal(describeCredential(cred('platform', ['internal', 'hybrid'], 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).label, 'Passkey (Google Password Manager)');
  assert.equal(describeCredential(cred('cross-platform', ['hybrid'])).label, 'Passkey (phone)');
  assert.deepEqual(describeCredential(cred('platform', ['internal'])), { type: 'passkey', transports: ['internal'], model: null, label: 'Passkey (this device)' });
});
