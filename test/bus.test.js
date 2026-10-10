import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.js';

test('wildcards: * matches one segment, ** the rest; handlers run by order', async () => {
  const bus = new Bus();
  const seen = [];
  bus.on('a.*.c', () => seen.push('star'));
  bus.on('a.**', () => seen.push('globstar'), { order: -1 });
  bus.on('a.b.c', () => seen.push('literal'));
  await bus.emit('a.b.c');
  assert.deepEqual(seen, ['globstar', 'star', 'literal']);
});

test('notify hands every handler the concrete topic; emit can be stopped', async () => {
  const bus = new Bus();
  const topics = [];
  bus.on('net.peer.*', (_p, ctx) => topics.push(ctx.topic));
  await bus.notify('net.peer.up', {});
  await bus.notify('net.peer.down', {});
  assert.deepEqual(topics, ['net.peer.up', 'net.peer.down']);

  bus.on('x', (_p, ctx) => ctx.stop());
  let reached = false;
  bus.on('x', () => (reached = true));
  assert.equal((await bus.emit('x')).stopped, true);
  assert.equal(reached, false);
});

test('run merges patches, a throw aborts it; failing handlers elsewhere are isolated and reported', async () => {
  const bus = new Bus();
  bus.on('t', () => ({ b: 2 }));
  assert.deepEqual(await bus.run('t', { a: 1 }), { a: 1, b: 2 });
  bus.on('t', () => {
    throw new Error('veto');
  });
  await assert.rejects(bus.run('t', {}), /veto/);

  const errors = [];
  bus.on('bus.error', (e) => errors.push(e.topic));
  bus.on('n', () => {
    throw new Error('boom');
  });
  let other = false;
  bus.on('n', () => (other = true));
  await bus.notify('n');
  assert.equal(other, true);
  assert.deepEqual(errors, ['n']);
});

test('unsubscribe removes exactly that registration', async () => {
  const bus = new Bus();
  let n = 0;
  const handler = () => n++;
  const off1 = bus.on('t', handler);
  bus.on('t', handler);
  off1();
  await bus.emit('t');
  assert.equal(n, 1);
  bus.once('o', handler);
  await bus.emit('o');
  await bus.emit('o');
  assert.equal(n, 2);
});
