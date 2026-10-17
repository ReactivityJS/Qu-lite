import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createClock, records, sync, compaction, mirror, Space, connectInProcess } from '../src/index.js';
import { until } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

/** Every peer shares one fake wall clock, so 120 days pass in milliseconds. */
function world() {
  let now = Date.UTC(2026, 0, 1);
  const clock = () => createClock({ now: () => now });
  return {
    advance: (ms) => (now += ms),
    async client(syncOptions = {}) {
      const qu = await createQu({ clock: clock() });
      qu.use(records());
      qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ...syncOptions }));
      qu.use(compaction({ delayMs: 20, expireEveryMs: 0 }));
      return qu;
    },
    async mirror() {
      const qu = await createQu({ clock: clock() });
      qu.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
      qu.use(mirror({ expireEveryMs: 0 }));
      await qu.mirror.ready;
      return qu;
    },
  };
}

const values = async (qu, space) => (await qu.query({ space, path: 'notes' })).map((r) => r.value);

/** alice deletes X while bob is away; bob returns after the horizon, when no peer remembers the deletion. */
async function scenario(bobSync) {
  const w = world();
  const m = await w.mirror();
  const alice = await w.client();
  const bob = await w.client(bobSync);
  const sa = alice.join(await Space.create(alice.identity));
  const sb = bob.join(await Space.open(sa.invite));
  await alice.watch({ space: sa });
  await bob.watch({ space: sb });
  await connectInProcess(alice, m).ready;
  let bobLink = connectInProcess(bob, m);
  await bobLink.ready;

  const x = await alice.write(sa, 'notes', 'X - deleted later');
  await alice.write(sa, 'notes', 'K - kept');
  await until(async () => (await values(bob, sb)).length === 2, 5000, 'bob has X and K');
  await until(async () => (await bob.lastSync(sb.id)) !== null, 5000, 'bob recorded a complete reconcile');
  await bobLink.disconnect();

  w.advance(DAY);
  await alice.del(sa, x);
  await until(async () => !(await m.storage.has(`rec/${sa.id}/${x.id}`)), 5000, 'mirror dropped X');

  w.advance(120 * DAY);
  await alice.compaction.expireAll();
  await m.mirror.expire();
  assert.deepEqual(await m.storage.keys(`gone/${sa.id}/`), [], 'the deletion is forgotten everywhere');
  assert.deepEqual((await bob.staleSpaces()).map((s) => s.sid), bobSync?.stale === 'push' ? [] : [sb.id]);

  await bob.write(sb, 'notes', 'Y - written offline');
  return { w, m, alice, bob, sa, sb, x, reconnect: () => (bobLink = connectInProcess(bob, m)) };
}

test('a device back after the 90-day horizon does not resurrect what was deleted meanwhile', async () => {
  const { m, alice, bob, sa, sb, x, reconnect } = await scenario();
  const events = [];
  bob.bus.on('sync.stale', (e) => events.push(e));
  const deleted = [];
  bob.bus.on('qu.record.deleted', (e) => deleted.push(e));

  await reconnect().ready;
  await until(async () => (await bob.syncStatus()).outbox === 0, 5000, 'offline write acked');
  await until(async () => (await values(alice, sa)).includes('Y - written offline'), 5000, 'alice gets Y');
  await until(() => events.length > 0, 5000, 'sync.stale reported');

  assert.deepEqual((await values(bob, sb)).sort(), ['K - kept', 'Y - written offline'], 'bob retired X locally');
  assert.equal(events[0].retired, 1);
  assert.equal(deleted.find((d) => d.id === x.id)?.stale, true);
  assert.equal(await m.storage.has(`rec/${sa.id}/${x.id}`), false, 'the mirror did not get X back');
  assert.deepEqual((await values(alice, sa)).sort(), ['K - kept', 'Y - written offline']);
  await until(async () => (await bob.staleSpaces()).length === 0, 5000, 'bob is current again');
});

test("stale: 'push' keeps the old behaviour (e.g. to refill a mirror that lost its data)", async () => {
  const { m, bob, sa, x, reconnect } = await scenario({ stale: 'push' });
  await reconnect().ready;
  await until(async () => m.storage.has(`rec/${sa.id}/${x.id}`), 5000, 'X is pushed back');
  assert.equal(await bob.lastSync(sa.id) !== null, true);
});

test('records younger than the horizon are still pushed by a stale device (the peer really lost them)', async () => {
  const w = world();
  const m1 = await w.mirror();
  const alice = await w.client();
  const sa = alice.join(await Space.create(alice.identity));
  await alice.watch({ space: sa });
  let link = connectInProcess(alice, m1);
  await link.ready;
  await alice.write(sa, 'notes', 'old');
  await until(async () => (await alice.syncStatus()).outbox === 0, 5000, 'acked');
  await link.disconnect();
  w.advance(100 * DAY);
  // written and acked by a peer meanwhile, but this mirror never saw it
  const fresh = await alice.write(sa, 'notes', 'recent');
  await alice.storage.remove(`sync/out/${sa.id}/${fresh.id}`);
  const m2 = await w.mirror(); // a new, empty mirror
  link = connectInProcess(alice, m2);
  await link.ready;
  await until(async () => m2.storage.has(`rec/${sa.id}/${fresh.id}`), 5000, 'recent record pushed');
  assert.deepEqual(await values(alice, sa), ['recent'], 'only the ambiguous old record was retired');
  assert.equal((await m2.storage.keys(`rec/${sa.id}/`)).length, 1);
});
