import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, connectInProcess, compareValues } from '../src/index.js';
import { until } from './helpers.js';

const day = (d, h = 9) => Date.UTC(2026, 10, d, h);
const titles = (rows) => rows.map((r) => r.value.title);

async function calendar() {
  const qu = await createClient({ devtools: false });
  const space = await qu.createGroup();
  const add = (title, start, extra = {}) => qu.write(space, 'events', { title, start, ...extra }, { key: title });
  await add('Zahnarzt', day(12, 8), { tags: ['health'], room: { floor: 2 } });
  await add('Standup', day(10, 9), { tags: ['work', 'daily'] });
  await add('Review', day(11, 14), { tags: ['work'], room: { floor: 1 } });
  await add('Geburtstag', new Date(day(20)).toISOString().slice(0, 10), { tags: ['family'] }); // ISO date string
  await add('Ohne Datum', undefined, { tags: [] });
  return { qu, space, add };
}

test('field queries: ranges, equality, arrays, nested fields, prefix, search, ordering', async () => {
  const { qu, space } = await calendar();
  const q = (extra) => qu.query({ space, path: 'events', ...extra });

  // a week, ordered by start - the calendar case, nothing calendar-specific
  assert.deepEqual(titles(await q({ where: { start: { gte: day(10, 0), lt: day(17, 0) } }, orderBy: 'start' })), ['Standup', 'Review', 'Zahnarzt']);
  assert.deepEqual(titles(await q({ where: { start: { gte: day(10, 0), lt: day(17, 0) } }, orderBy: 'start', reverse: true, limit: 2 })), ['Zahnarzt', 'Review']);
  // strings compare as strings (ISO dates sort correctly)
  assert.deepEqual(titles(await q({ where: { start: { gte: '2026-11-01', lt: '2026-12-01' } } })), ['Geburtstag']);
  // arrays match by element; several fields AND
  assert.deepEqual(titles(await q({ where: { tags: 'work' }, orderBy: 'start' })), ['Standup', 'Review']);
  assert.deepEqual(titles(await q({ where: { tags: ['family', 'health'] }, orderBy: 'title' })), ['Geburtstag', 'Zahnarzt']);
  assert.deepEqual(titles(await q({ where: { tags: 'work', 'room.floor': 1 } })), ['Review']);
  // prefix and case-insensitive search
  assert.deepEqual(titles(await q({ where: { title: { prefix: 'Ge' } } })), ['Geburtstag']);
  assert.deepEqual(titles(await q({ where: { title: { contains: 'VIE' } } })), ['Review']);
  assert.deepEqual(titles(await q({ where: { $key: { prefix: 'S' } } })), ['Standup']);
  // orderBy alone: records without the field come last
  assert.deepEqual(titles(await q({ orderBy: 'room.floor' })).slice(0, 2), ['Review', 'Zahnarzt']);
  assert.equal((await q({ orderBy: 'room.floor' })).length, 5);
  // unknown operator
  await assert.rejects(q({ where: { start: { after: 1 } } }), /unknown condition/);
  // type order: numbers < strings < booleans
  assert.ok(compareValues(5, 'a') < 0 && compareValues('a', true) < 0);
  await qu.close();
});

test('field queries follow changes: updates move, deletes leave, records from other peers arrive', async () => {
  const { qu, space, add } = await calendar();
  const week = { where: { start: { gte: day(10, 0), lt: day(17, 0) } }, orderBy: 'start' };
  const q = () => qu.query({ space, path: 'events', ...week });
  assert.deepEqual(titles(await q()), ['Standup', 'Review', 'Zahnarzt']); // index built

  await add('Review', day(25, 10), { tags: ['work'] }); // moved out of the week (new version of the key)
  assert.deepEqual(titles(await q()), ['Standup', 'Zahnarzt']);
  await qu.del(space, 'events', 'Standup'); // deleted
  assert.deepEqual(titles(await q()), ['Zahnarzt']);

  // a second device: its records show up in the same index
  const other = await createClient({ devtools: false });
  const joined = await other.acceptInvite(await (await qu.members(space)).invite());
  const link = connectInProcess(qu, other);
  await link.ready;
  await other.write(joined, 'events', { title: 'Mittag', start: day(13, 12) }, { key: 'Mittag' });
  await until(async () => titles(await q()).includes('Mittag'), 5000, 'remote record indexed');
  assert.deepEqual(titles(await q()), ['Zahnarzt', 'Mittag']);
  // log entries (no key) and $value on plain values
  await qu.write(space, 'chat', 'Hallo Welt');
  await qu.write(space, 'chat', 'Tschüss');
  assert.deepEqual((await qu.query({ space, path: 'chat', where: { $value: { contains: 'welt' } } })).map((r) => r.value), ['Hallo Welt']);
  await link.disconnect();
  await qu.close();
  await other.close();
});

test('field queries scale: 20,000 records, a range query after the first build takes milliseconds', async () => {
  const qu = await createClient({ devtools: false });
  const space = await qu.createGroup();
  for (let i = 0; i < 20_000; i++) await qu.write(space, 'scores', { player: `p${i % 500}`, points: (i * 7919) % 100_000, round: i % 50 });
  let t = Date.now();
  const top = await qu.query({ space, path: 'scores', where: { round: 7 }, orderBy: 'points', reverse: true, limit: 3 });
  const build = Date.now() - t;
  assert.equal(top.length, 3);
  assert.ok(top[0].value.points >= top[1].value.points);
  t = Date.now();
  await qu.query({ space, path: 'scores', where: { points: { gte: 0, lt: 1 } } }); // builds the 'points' index
  const build2 = Date.now() - t;
  t = Date.now();
  for (let i = 0; i < 20; i++) await qu.query({ space, path: 'scores', where: { points: { gte: 50_000, lt: 50_200 } } });
  const per = (Date.now() - t) / 20;
  console.log(`# 20k records: index builds ${build} / ${build2} ms, then ${per.toFixed(1)} ms per range query`);
  assert.ok(per < 50, `range query ${per} ms`);
  await qu.close();
});

test('memory stays bounded: field indexes by total entries, the record cache by bytes (file chunks)', async () => {
  const { createPeer } = await import('../src/index.js');
  const qu = await createPeer({ plugins: [['records', { maxIndexEntries: 150, cacheBytes: 64 * 1024 }], 'blobs'] });
  const space = qu.join(await (await import('../src/index.js')).Space.create(qu.identity));
  for (let i = 0; i < 100; i++) await qu.write(space, 'items', { a: i, b: i % 3 });
  await qu.query({ space, path: 'items', where: { a: { gte: 50 } } });
  assert.deepEqual(qu.records.memory().fields.entries, 100);
  await qu.query({ space, path: 'items', where: { b: 1 } }); // 200 > 150: the older index leaves
  assert.deepEqual(qu.records.memory().fields, { indexes: 1, entries: 100, maxEntries: 150 });
  assert.equal((await qu.query({ space, path: 'items', where: { a: { gte: 98 } } })).length, 2, 'rebuilt when needed again');

  const ref = await qu.blobs.put(space, new Uint8Array(1024 * 1024).fill(7));
  await qu.blobs.get(space, ref);
  const { cache } = qu.records.memory();
  assert.ok(cache.bytes <= 64 * 1024, `record cache ${cache.bytes} bytes`);
  await qu.close();
});
