import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, parseHlc, formatHlc } from '../src/index.js';

test('tick() is strictly increasing, even with a frozen wall clock', () => {
  const clock = createClock({ now: () => 1000 });
  const a = clock.tick();
  const b = clock.tick();
  assert.ok(b > a);
  assert.deepEqual(parseHlc(b), { ms: 1000, counter: 1 });
});

test('recv() moves the clock past a remote HLC', () => {
  const clock = createClock({ now: () => 1000 });
  assert.equal(clock.recv(formatHlc(2000, 5)), true);
  assert.ok(clock.tick() > formatHlc(2000, 5));
});

test('recv() rejects an HLC beyond the drift bound and leaves the clock untouched', () => {
  const clock = createClock({ now: () => 1000, maxDriftMs: 100 });
  const before = clock.peek();
  assert.equal(clock.recv(formatHlc(1101)), false);
  assert.equal(clock.peek(), before);
});

test('formatted HLCs sort lexicographically in time order', () => {
  const list = [formatHlc(20, 1), formatHlc(3, 0), formatHlc(20, 0), formatHlc(1_000_000)];
  assert.deepEqual([...list].sort(), [formatHlc(3, 0), formatHlc(20, 0), formatHlc(20, 1), formatHlc(1_000_000)]);
});
