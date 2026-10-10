import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeer, defaultRegistry, memoryDriver, Space, connectInProcess } from '../src/index.js';
import { nodeRegistry } from '../src/node.js';

test('a client and a mirror are built by the same createPeer from registry names', async () => {
  const mirror = await createPeer({ registry: nodeRegistry(), store: ['sqlite', {}], plugins: [['sync', { role: 'mirror' }], 'mirror'] });
  const client = await createPeer({ plugins: ['records', 'user', ['sync', { ackFrom: 'mirror' }]] });
  assert.equal(typeof mirror.mirror.ready.then, 'function');
  assert.equal(typeof client.write, 'function');
  assert.equal(typeof client.me, 'function');
  assert.equal(mirror.write, undefined); // a mirror never gets the reader

  const space = client.join(await Space.create());
  await connectInProcess(client, mirror).ready;
  await client.write(space, 'chat', 'hi');
  const deadline = Date.now() + 3000;
  while ((await client.syncStatus()).outbox > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await mirror.mirror.count(space.id), 1);
  mirror.root.close();
});

test("identity: 'persisted' survives a reload on the same store", async () => {
  const disk = memoryDriver();
  const registry = defaultRegistry();
  const first = await createPeer({ registry, store: disk });
  const second = await createPeer({ registry, store: disk });
  assert.deepEqual(second.identity.publicKey, first.identity.publicKey);
  assert.equal(second.peerId, first.peerId);
});
