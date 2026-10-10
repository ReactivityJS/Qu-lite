import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMountRouter, memoryDriver } from '../src/index.js';

/** A driver WITHOUT range(), to exercise the router's fallback. */
function plainDriver() {
  const data = new Map();
  return {
    name: 'plain',
    get: async (k) => (data.has(k) ? data.get(k) : null),
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
    keys: async (prefix = '') => [...data.keys()].filter((k) => k.startsWith(prefix)),
  };
}

test('the longest mounted prefix wins, the root catches the rest', async () => {
  const root = memoryDriver();
  const media = memoryDriver();
  const store = createMountRouter({ root });
  store.mount('media/', media);

  await store.set('media/a.png', 1);
  await store.set('idx/x', 2);

  assert.equal(await media.get('media/a.png'), 1);
  assert.equal(await root.get('media/a.png'), null);
  assert.equal(await root.get('idx/x'), 2);
  assert.deepEqual(await store.keys(''), ['idx/x', 'media/a.png']);
});

test('range() honours gte/lt/limit/reverse on a native range driver', async () => {
  const store = createMountRouter();
  for (const k of ['p/1', 'p/2', 'p/3', 'p/4', 'q/1']) await store.set(k, k);

  assert.deepEqual((await store.range('p/', { gte: 'p/2', lt: 'p/4' })).map((r) => r.key), ['p/2', 'p/3']);
  assert.deepEqual((await store.range('p/', { limit: 2, reverse: true })).map((r) => r.key), ['p/4', 'p/3']);
});

test('range() falls back to keys()+sort for drivers without range(), merged across mounts', async () => {
  const store = createMountRouter();
  store.mount('p/b', plainDriver());
  for (const k of ['p/a1', 'p/b1', 'p/b2', 'p/c1']) await store.set(k, k);

  assert.deepEqual((await store.range('p/')).map((r) => r.key), ['p/a1', 'p/b1', 'p/b2', 'p/c1']);
  assert.deepEqual((await store.range('p/', { gte: 'p/b2', limit: 2 })).map((r) => r.key), ['p/b2', 'p/c1']);
  assert.equal(await store.has('p/b1'), true);
  await store.remove('p/b1');
  assert.equal(await store.has('p/b1'), false);
});

test('unmount() removes a mount but never the root', () => {
  const store = createMountRouter();
  store.mount('x/', memoryDriver());
  store.unmount('x/');
  assert.deepEqual(store.mounts().map((m) => m.base), ['']);
  assert.throws(() => store.unmount(''));
});
