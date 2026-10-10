import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createClock, records, Space, connectInProcess, memoryDriver } from '../src/index.js';

/** A Qu with a controllable wall clock. */
async function makeQu(start = 1_760_000_000_000) {
  const time = { now: start };
  const qu = await createQu({ clock: createClock({ now: () => time.now }) });
  qu.use(records());
  return { qu, time };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('write + time-window query over a path', async () => {
  const { qu, time } = await makeQu();
  const space = qu.join(await Space.create());

  const t0 = time.now;
  await qu.write(space, 'chat', 'a');
  time.now += 60_000;
  await qu.write(space, 'chat', 'b');
  time.now += 60_000;
  await qu.write(space, 'chat', 'c');
  await qu.write(space, 'other', 'x');

  assert.deepEqual((await qu.query({ space, path: 'chat' })).map((r) => r.value), ['a', 'b', 'c']);
  assert.deepEqual((await qu.query({ space, path: 'chat', from: t0 + 60_000 })).map((r) => r.value), ['b', 'c']);
  assert.deepEqual((await qu.query({ space, path: 'chat', from: t0, to: t0 + 60_000 })).map((r) => r.value), ['a']);
  assert.deepEqual((await qu.query({ space, path: 'chat', limit: 1, reverse: true })).map((r) => r.value), ['c']);
});

test('keyed entries are last-write-wins; only the head is queryable', async () => {
  const { qu } = await makeQu();
  const space = qu.join(await Space.create());

  await qu.write(space, 'profile', 'Ann', { key: 'name' });
  await qu.write(space, 'profile', 'Anna', { key: 'name' });

  assert.equal(await qu.get(space, 'profile', 'name'), 'Anna');
  assert.deepEqual((await qu.query({ space, path: 'profile' })).map((r) => r.value), ['Anna']);
  // The superseded envelope is kept for sync (a key-less mirror can't tell it's old), just not indexed.
  assert.equal((await qu.storage.keys(`rec/${space.id}/`)).length, 2);
});

test('qu.write.before hooks can transform or veto a write', async () => {
  const { qu } = await makeQu();
  const space = qu.join(await Space.create());

  qu.bus.on('qu.write.before', (draft) => ({ value: String(draft.value).trim() }));
  qu.bus.on('qu.write.before', (draft) => {
    if (draft.value === '') throw new Error('empty');
  });

  assert.equal((await qu.write(space, 'chat', '  hi  ')).value, 'hi');
  await assert.rejects(qu.write(space, 'chat', '   '), /empty/);
  assert.equal((await qu.query({ space, path: 'chat' })).length, 1);
});

test('a per-space mount puts that space\'s sealed records on its own driver', async () => {
  const { qu } = await makeQu();
  const space = qu.join(await Space.create());
  const driver = memoryDriver();
  qu.mount(`rec/${space.id}/`, driver);

  const { id } = await qu.write(space, 'chat', 'x');
  assert.ok((await driver.get(`rec/${space.id}/${id}`)) instanceof Uint8Array);
});

test('records are mirrored live to a connected peer and duplicates are ignored', async () => {
  const a = await makeQu();
  const b = await makeQu();
  const c = await makeQu();
  const secret = (await Space.create()).secret;
  const sa = a.qu.join(await Space.open(secret));
  const sb = b.qu.join(await Space.open(secret));
  const sc = c.qu.join(await Space.open(secret));

  // Triangle: every record reaches each peer twice (direct + forwarded).
  connectInProcess(a.qu, b.qu);
  connectInProcess(b.qu, c.qu);
  connectInProcess(a.qu, c.qu);

  const seen = [];
  b.qu.bus.on(`qu.record.${sb.id}`, (rec) => seen.push(rec.value));
  let duplicates = 0;
  c.qu.bus.on('qu.record.duplicate', () => duplicates++);

  await a.qu.write(sa, 'chat', 'hallo');
  await settle();

  assert.deepEqual(seen, ['hallo']);
  assert.deepEqual((await c.qu.query({ space: sc, path: 'chat' })).map((r) => r.value), ['hallo']);
  assert.ok(duplicates >= 1);
});

test('qu.accept hooks can reject an incoming record, and an unknown space is dropped', async () => {
  const a = await makeQu();
  const b = await makeQu();
  const secret = (await Space.create()).secret;
  const sa = a.qu.join(await Space.open(secret));
  const sb = b.qu.join(await Space.open(secret));
  connectInProcess(a.qu, b.qu);

  const rejected = [];
  b.qu.bus.on('qu.record.rejected', (e) => rejected.push(e.reason));
  b.qu.bus.on('qu.accept', (rec, ctx) => {
    if (rec.path === 'admin') ctx.stop();
  });

  await a.qu.write(sa, 'admin', 'nope');
  await a.qu.write(sa, 'chat', 'ok');
  await settle();
  assert.deepEqual(rejected, ['hook']);
  assert.deepEqual((await b.qu.query({ space: sb, path: 'chat' })).map((r) => r.value), ['ok']);

  const unknown = [];
  b.qu.bus.on('qu.record.unknown-space', (e) => unknown.push(e.sid));
  const lone = a.qu.join(await Space.create());
  await a.qu.write(lone, 'chat', 'private');
  await settle();
  assert.deepEqual(unknown, [lone.id]);
});

test('a record from a peer with a clock too far ahead is rejected', async () => {
  const a = await makeQu(1_760_000_000_000 + 60 * 60 * 1000);
  const b = await makeQu();
  const secret = (await Space.create()).secret;
  const sa = a.qu.join(await Space.open(secret));
  const sb = b.qu.join(await Space.open(secret));
  connectInProcess(a.qu, b.qu);

  const rejected = [];
  b.qu.bus.on('qu.record.rejected', (e) => rejected.push(e.reason));
  await a.qu.write(sa, 'chat', 'from the future');
  await settle();
  assert.deepEqual(rejected, ['clock drift']);
  assert.equal((await b.qu.query({ space: sb, path: 'chat' })).length, 0);
});

test('concurrent keyed writes converge to the same head on both peers', async () => {
  const a = await makeQu();
  const b = await makeQu();
  const secret = (await Space.create()).secret;
  const sa = a.qu.join(await Space.open(secret));
  const sb = b.qu.join(await Space.open(secret));

  // Written while disconnected, same wall time, then connected.
  await a.qu.write(sa, 'doc', 'from a', { key: 'title' });
  await b.qu.write(sb, 'doc', 'from b', { key: 'title' });
  connectInProcess(a.qu, b.qu);
  // M1 has no reconciliation yet: re-deliver both heads explicitly.
  for (const [from, to, space] of [[a, b, sa], [b, a, sb]]) {
    for (const key of await from.qu.storage.keys(`rec/${space.id}/`)) {
      await to.qu.bus.emit(`net.in.${from.qu.peerId}.rec`, { bytes: await from.qu.storage.get(key) });
    }
  }
  await settle();
  assert.equal(await a.qu.get(sa, 'doc', 'title'), await b.qu.get(sb, 'doc', 'title'));
});
