import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame } from '../src/index.js';

test('frames round-trip type and payload with nested binary fields, without base64', () => {
  const ids = new Uint8Array(64).fill(3);
  const payload = { session: 'abc', ids, list: [new Uint8Array([1]), { deep: new Uint8Array(0) }], n: 5, nul: null };
  const frame = encodeFrame('want', payload);
  assert.deepEqual(decodeFrame(frame), { type: 'want', payload });
  assert.ok(frame.length < 64 + 120, `frame is ${frame.length} bytes`);
});

test('a frame without payload decodes to null', () => {
  assert.deepEqual(decodeFrame(encodeFrame('hi')), { type: 'hi', payload: null });
});
