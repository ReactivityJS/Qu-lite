import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, topology } from '../src/index.js';

async function setup(options) {
  const qu = await createQu();
  const open = new Set();
  const connect = (endpoint) => {
    open.add(endpoint);
    return { close: () => open.delete(endpoint) };
  };
  const topo = qu.use(topology({ connect, ...options }));
  return { qu, topo, open };
}

test('star keeps only mirrors, mesh adds every peer', async () => {
  const { topo, open } = await setup({ mode: 'star', mirrors: ['m'], peers: ['a', 'b'] });
  assert.deepEqual([...open].sort(), ['m']);
  topo.setMode('mesh');
  assert.deepEqual([...open].sort(), ['a', 'b', 'm']);
  topo.setMode('star');
  assert.deepEqual([...open].sort(), ['m']);
});

test('auto: mesh while small, mirrors + fanout once the group outgrows maxMesh, keeping open links', async () => {
  const { qu, topo, open } = await setup({ mode: 'auto', mirrors: ['m'], peers: ['a', 'b'], maxMesh: 4, fanout: 2 });
  const events = [];
  qu.bus.on('net.topology', (e) => events.push(e.effective));
  assert.equal(topo.effective, 'mesh');
  assert.deepEqual([...open].sort(), ['a', 'b', 'm']);

  topo.setPeers(['c', 'a', 'd', 'b', 'e']); // 6 > maxMesh
  assert.equal(topo.effective, 'star+');
  assert.deepEqual([...open].sort(), ['a', 'b', 'm']); // already-open links preferred, no churn
  topo.setPeers(['a']);
  assert.equal(topo.effective, 'mesh');
  assert.deepEqual([...open].sort(), ['a', 'm']);
  assert.deepEqual(events, ['star+', 'mesh']);
});
