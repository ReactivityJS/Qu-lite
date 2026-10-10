import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { memoryDriver, indexedDbDriver } from '../src/index.js';
import { sqliteDriver } from '../src/drivers/sqlite.js';

const dir = mkdtempSync(join(tmpdir(), 'qu-lite-drivers-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const factory = new IDBFactory();
const drivers = {
  memory: () => memoryDriver(),
  sqlite: () => sqliteDriver({ path: join(dir, `t${Math.random()}.sqlite`) }),
  indexeddb: () => indexedDbDriver({ name: `t${Math.random()}`, indexedDB: factory, IDBKeyRange }),
};

for (const [name, make] of Object.entries(drivers)) {
  test(`${name}: get/set/has/remove and value types`, async () => {
    const d = make();
    assert.equal(await d.get('missing'), null);
    await d.set('bytes', new Uint8Array([1, 2, 3]));
    await d.set('obj', { a: 1, nested: { b: [1, 'x'], key: new Uint8Array([9, 8]) } });
    assert.deepEqual(await d.get('bytes'), new Uint8Array([1, 2, 3]));
    assert.ok((await d.get('bytes')) instanceof Uint8Array);
    assert.deepEqual(await d.get('obj'), { a: 1, nested: { b: [1, 'x'], key: new Uint8Array([9, 8]) } });
    assert.equal(await d.has('obj'), true);
    await d.remove('obj');
    assert.equal(await d.has('obj'), false);
    assert.equal(await d.get('obj'), null);
  });

  test(`${name}: keys() and range() with bounds, limit and reverse`, async () => {
    const d = make();
    for (const k of ['p/1', 'p/2', 'p/3', 'p/4', 'pz', 'q/1']) await d.set(k, k);
    assert.deepEqual(await d.keys('p/'), ['p/1', 'p/2', 'p/3', 'p/4']);
    assert.deepEqual((await d.range('p/', { gte: 'p/2', lt: 'p/4' })).map((r) => r.key), ['p/2', 'p/3']);
    assert.deepEqual((await d.range('p/', { limit: 2, reverse: true })).map((r) => [r.key, r.value]), [['p/4', 'p/4'], ['p/3', 'p/3']]);
    assert.deepEqual((await d.range('p/', { gte: 'a', lt: 'z' })).map((r) => r.key), ['p/1', 'p/2', 'p/3', 'p/4']);
    assert.deepEqual(await d.range('p/', { gte: 'p/9' }), []);
  });
}

test('sqlite: data survives closing and reopening the file', async () => {
  const path = join(dir, 'reopen.sqlite');
  const a = sqliteDriver({ path });
  await a.set('rec/x', new Uint8Array([7]));
  a.close();
  const b = sqliteDriver({ path });
  assert.deepEqual(await b.get('rec/x'), new Uint8Array([7]));
  b.close();
});

test('indexeddb: data survives closing and reopening the database', async () => {
  const a = indexedDbDriver({ name: 'reopen', indexedDB: factory, IDBKeyRange });
  await a.set('rec/x', new Uint8Array([7]));
  await a.close();
  const b = indexedDbDriver({ name: 'reopen', indexedDB: factory, IDBKeyRange });
  assert.deepEqual(await b.get('rec/x'), new Uint8Array([7]));
});
