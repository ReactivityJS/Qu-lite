import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createLink } from '../src/index.js';

/** The contract every transport (WebSocket today, WebRTC/SSE later) fulfils: bytes in, bytes out, close. */
function pair(a, b) {
  const ends = {};
  ends.a = createLink(a, { send: (bytes) => queueMicrotask(() => ends.b.receive(bytes)), via: 'fake' });
  ends.b = createLink(b, { send: (bytes) => queueMicrotask(() => ends.a.receive(bytes)), via: 'fake' });
  return ends;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('handshake by network id, net.out -> net.in across the link, peer.down on close', async () => {
  const a = await createQu();
  const b = await createQu();
  const events = [];
  for (const topic of ['net.peer.up', 'net.peer.down']) a.bus.on(topic, (p) => events.push([topic, p.peer, p.via]));
  const got = [];
  b.bus.on(`net.in.${a.peerId}.*`, (payload, ctx) => got.push([ctx.topic.split('.')[3], payload]));

  const ends = pair(a, b);
  await settle();
  assert.deepEqual(events, [['net.peer.up', b.peerId, 'fake']]);
  assert.equal(ends.a.peer, b.peerId);

  await a.bus.emit(`net.out.${b.peerId}.rec`, { bytes: new Uint8Array([1, 2]), sync: true });
  await settle();
  assert.deepEqual(got, [['rec', { bytes: new Uint8Array([1, 2]), sync: true }]]);
  assert.ok(ends.a.stats.sent > 0 && ends.b.stats.received === ends.a.stats.sent);

  ends.a.closed();
  assert.deepEqual(events.at(-1), ['net.peer.down', b.peerId, 'fake']);
  await a.bus.emit(`net.out.${b.peerId}.rec`, { bytes: new Uint8Array([3]) });
  await settle();
  assert.equal(got.length, 1);
});

test('a malformed handshake closes the link; garbage frames are reported, not fatal', async () => {
  const a = await createQu();
  let closed = false;
  const errors = [];
  a.bus.on('net.error', (e) => errors.push(e.reason));
  const link = createLink(a, { send: () => {}, close: () => (closed = true) });
  link.receive(new Uint8Array([200, 1, 2]));
  assert.deepEqual(errors, ['bad frame']);
  const { encodeFrame } = await import('../src/index.js');
  link.receive(encodeFrame('hi', { peer: 'not-hex!' }));
  assert.equal(closed, true);
});
