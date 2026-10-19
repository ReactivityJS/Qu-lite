import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, records, sync, mirror, compaction, limits, relayTransport, connectWs, Space, sealEnvelope, openEnvelope, formatHlc, peekEnvelope } from '../src/index.js';
import { fullClient, connectInProcess, until, values, settle } from './helpers.js';
import { startMirror } from '../bin/mirror.mjs';

async function plain({ syncOptions = {}, ...options } = {}) {
  const qu = await createQu(options);
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ackFrom: 'mirror', ...syncOptions }));
  return qu;
}

async function mirrorWith(options = {}, syncOptions = {}) {
  const qu = await createQu();
  if (options.limits) qu.use(limits(options.limits));
  qu.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0, ...syncOptions }));
  qu.use(mirror({ expireEveryMs: 0, ...options }));
  await qu.mirror.ready;
  return qu;
}

/** Counts `net.in.<peer>.<type>` frames a peer receives. */
function frames(qu) {
  const seen = [];
  qu.bus.on('net.in.*.*', (payload, ctx) => seen.push({ peer: ctx.topic.split('.')[2], type: ctx.topic.split('.')[3], payload }));
  return seen;
}

test('connecting to a mirror reveals none of its other spaces and costs it no reconcile per stored space', async () => {
  const m = await mirrorWith();
  const owner = await fullClient();
  await connectInProcess(owner, m).ready;
  for (let i = 0; i < 30; i++) await owner.createGroup();
  await until(async () => (await m.mirror.spaces()).length >= 30, 5000, 'mirror serves 30 spaces');

  const foreign = new Set(await m.mirror.spaces());
  const carol = await fullClient();
  const seen = frames(carol);
  await connectInProcess(carol, m).ready;
  await settle(200);
  // the mirror only reconciles carol's own new spaces (user node, inbox) with her - fetching what it refused before the grant
  assert.equal(seen.filter((f) => f.type === 'sub').length, 0);
  assert.ok(seen.filter((f) => f.type === 'neg').length <= 2);
  const leaked = seen.filter((f) => typeof f.payload?.sid === 'string' && foreign.has(f.payload.sid));
  assert.deepEqual(leaked.map((f) => f.type), []);

  // her own space still syncs both ways through the mirror
  const group = await carol.createGroup();
  await carol.write(group, 'chat', 'hi');
  const dave = await fullClient();
  await connectInProcess(dave, m).ready;
  const joined = await dave.acceptInvite(await (await carol.members(group)).invite());
  await until(async () => (await values(dave, joined, 'chat')).includes('hi'), 5000, 'dave reads carol');
  await dave.write(joined, 'chat', 'yo');
  await until(async () => (await values(carol, group, 'chat')).includes('yo'), 5000, 'carol reads dave');
});

test('two peers watching the same space run ONE reconcile when they connect', async () => {
  const a = await plain();
  const b = await plain();
  const space = await Space.create();
  const sa = a.join(await Space.open(space.invite));
  const sb = b.join(await Space.open(space.invite));
  await a.watch({ space: sa });
  await b.watch({ space: sb });
  for (let i = 0; i < 5; i++) await a.write(sa, 'chat', `a${i}`);
  await b.write(sb, 'chat', 'b');
  let starts = 0;
  for (const qu of [a, b]) qu.bus.on('sync.start', () => starts++);
  await connectInProcess(a, b).ready;
  await until(async () => (await values(b, sb, 'chat')).length === 6 && (await values(a, sa, 'chat')).length === 6, 5000, 'converged');
  await settle(50);
  assert.equal(starts, 1);
});

test('quota: the mirror refuses (and nacks) beyond the quota, accepts drop lists, and takes the record once there is room', async () => {
  const m = await mirrorWith({ quota: { records: 5 }, maxEnvelopeBytes: 2048 });
  const alice = await plain();
  alice.use(compaction({ auto: false, expireEveryMs: 0 }));
  const space = alice.join(await Space.create());
  let link = connectInProcess(alice, m);
  await link.ready;
  const refused = [];
  alice.bus.on('qu.record.refused', (e) => refused.push(e));

  const written = [];
  for (let i = 0; i < 5; i++) written.push(await alice.write(space, 'chat', `m${i}`));
  await until(async () => (await m.mirror.usage(space.id)).records === 5, 5000, 'five stored');
  const sixth = await alice.write(space, 'chat', 'm5');
  await until(() => refused.length === 1, 5000, 'nack');
  assert.deepEqual([refused[0].id, refused[0].reason], [sixth.id, 'quota']);
  assert.equal(await alice.syncState(space.id, sixth.id), 'pending'); // kept in the outbox

  const big = await alice.write(space, 'chat', 'x'.repeat(4000));
  await until(() => refused.some((r) => r.id === big.id && r.reason === 'too large'), 5000, 'too large');

  // a drop list is accepted although the space is full, and frees room
  await alice.records.dropList(space, written.slice(0, 2));
  await until(async () => (await m.mirror.usage(space.id)).records === 4, 5000, 'two dropped, one drop list');
  await link.disconnect();
  link = connectInProcess(alice, m); // the outbox is re-pushed on connect
  await link.ready;
  await until(async () => (await alice.syncState(space.id, sixth.id)) === 'sent', 5000, 'sixth accepted');
  const usage = await m.mirror.usage(space.id);
  const keys = await m.storage.keys(`rec/${space.id}/`);
  let bytes = 0;
  for (const key of keys) bytes += (await m.storage.get(key)).length;
  assert.deepEqual(usage, { records: keys.length, bytes });
});

test('rate limit: a flood is dropped above the burst and the connection is closed after repeated strikes', async () => {
  const m = await mirrorWith({ limits: { frames: { rate: 1, burst: 20 }, strikes: 10, windowMs: 60_000 } });
  const flooder = await plain();
  const limited = [];
  m.bus.on('net.limited', (e) => limited.push(e));
  const link = connectInProcess(flooder, m);
  await link.ready;
  const mirrorName = link.peer();
  let down = false;
  flooder.bus.on('net.peer.down', () => (down = true));
  for (let i = 0; i < 60; i++) flooder.bus.emit(`net.out.${mirrorName}.sub`, { sid: `x${i}` });
  await until(() => limited.some((e) => e.closed), 5000, 'closed');
  assert.ok(limited.length >= 10);

  // ordinary traffic below the limit is untouched
  const calm = await plain();
  const before = limited.length;
  const space = calm.join(await Space.create());
  await connectInProcess(calm, m).ready;
  await calm.write(space, 'chat', 'hello');
  await until(async () => (await m.mirror.count(space.id)) === 1, 5000, 'stored');
  assert.equal(limited.length, before);
  assert.equal(down, true);
});

test('a busy responder declines extra sessions; the reconcile succeeds when retried', async () => {
  const a = await plain();
  const b = await plain({ syncOptions: { maxSessionsPerPeer: 1 } });
  const spaces = [];
  for (let i = 0; i < 2; i++) {
    const s = await Space.create();
    spaces.push([a.join(await Space.open(s.invite)), b.join(await Space.open(s.invite))]);
    await b.write(spaces[i][1], 'chat', `s${i}`);
  }
  await connectInProcess(a, b).ready;
  const results = (await Promise.all(spaces.map(([sa]) => a.resync({ space: sa })))).flat();
  assert.ok(results.some((r) => /declined: busy/.test(r.error ?? '')));
  for (const [sa] of spaces) {
    const [again] = await a.resync({ space: sa });
    assert.equal(again.error, undefined);
  }
  for (const [i, [sa]] of spaces.entries()) assert.deepEqual(await values(a, sa, 'chat'), [`s${i}`]);
});

test('padding: private envelopes come in a few size steps (at most +25 %), public ones and padding none stay exact', async () => {
  const space = await Space.create();
  const author = await space.authorFor((await createQu()).identity);
  const sizes = { quarter: new Set(), none: new Set() };
  for (let n = 1; n <= 300; n += 7) {
    const value = 'x'.repeat(n);
    const length = {};
    for (const padding of ['quarter', 'none']) {
      const { bytes } = await sealEnvelope(space, { path: 'chat', hlc: formatHlc(Date.now()), value, padding }, author);
      sizes[padding].add(bytes.length);
      length[padding] = bytes.length;
      assert.equal((await openEnvelope(space, bytes)).value, value); // 'none' = an old, unpadded envelope
    }
    const overhead = 192 + 12 + 16; // header + signatures, IV, GCM tag
    const [padded, exact] = [length.quarter - overhead, length.none - overhead];
    assert.ok(padded <= Math.max(128, 1.25 * (exact + 1)), `n=${n}`); // min 128 B, then at most +25 %
  }
  assert.ok(sizes.quarter.size <= 8, `steps: ${[...sizes.quarter]}`);
  assert.ok(sizes.none.size > 30);
  const value = 'x'.repeat(50);
  const pub = await sealEnvelope(space, { path: 'chat', hlc: formatHlc(Date.now()), value, visibility: 'public' }, author);
  assert.equal((await openEnvelope(space, pub.bytes)).value, value);
  assert.ok(pub.bytes.length < 192 + 120); // public: not padded
});

test('isolate: one connection per space over real WebSockets - the relay sees separate network ids, each carrying one space', async () => {
  const relay = await startMirror({ port: 0, log: () => {} });
  const url = `http://localhost:${relay.port}`;
  try {
    const seen = new Map(); // mirror-side peer -> sids it carried
    relay.qu.bus.on('net.in.*.*', (payload, ctx) => {
      const peer = ctx.topic.split('.')[2];
      const sid = typeof payload?.sid === 'string' ? payload.sid : payload?.bytes instanceof Uint8Array ? peekEnvelope(payload.bytes).sid : null;
      if (!sid) return;
      if (!seen.has(peer)) seen.set(peer, new Set());
      seen.get(peer).add(sid);
    });
    const peersUp = new Set();
    relay.qu.bus.on('net.peer.up', ({ peer }) => peersUp.add(peer));

    const carol = await plain();
    carol.use(relayTransport({ url, isolate: true, minDelayMs: 50 }));
    const one = carol.join(await Space.create());
    const two = carol.join(await Space.create());
    await carol.write(one, 'chat', 'in one');
    await carol.write(two, 'chat', 'in two');
    await until(async () => (await relay.qu.mirror.count(one.id)) === 1 && (await relay.qu.mirror.count(two.id)) === 1, 10_000, 'both stored');
    assert.equal(peersUp.size, 3); // shared + one per space
    for (const sids of seen.values()) assert.equal(sids.size, 1, `a connection carried ${[...sids]}`);

    const dave = await plain();
    const conn = connectWs(dave, url.replace('http', 'ws') + '/ws', { minDelayMs: 50 });
    const daves = dave.join(await Space.open(one.invite));
    await dave.watch({ space: daves });
    await until(async () => (await values(dave, daves, 'chat')).includes('in one'), 10_000, 'dave reads');
    await carol.write(one, 'chat', 'live');
    await until(async () => (await values(dave, daves, 'chat')).includes('live'), 10_000, 'live');
    conn.close();
    carol.transports.relay.close();
  } finally {
    await relay.close();
  }
});

test('a relay routes live records only to peers that subscribed: an anonymous connection learns nothing', async () => {
  const m = await mirrorWith();
  const a = await plain();
  const b = await plain();
  const sa = a.join(await Space.create(a.identity));
  const sb = b.join(await Space.open(sa.invite));
  await a.watch({ space: sa });
  await b.watch({ space: sb });
  await connectInProcess(a, m).ready;
  await connectInProcess(b, m).ready;
  const bare = await createQu(); // no plugins at all: never says hello, never subscribes
  const lurker = await createQu();
  lurker.use(sync({ retryMs: 0 })); // says hello, watches nothing
  const seen = [frames(bare), frames(lurker)];
  await connectInProcess(bare, m).ready;
  await connectInProcess(lurker, m).ready;
  await a.write(sa, 'chat', 'for members only');
  await until(async () => (await values(b, sb, 'chat')).length === 1, 5000, 'b gets it');
  await settle(100);
  for (const list of seen) assert.deepEqual(list.filter((f) => f.type === 'rec' || f.type === 'sig').length, 0);
});

test('a second connection claiming a connected network id replaces it - it never shares that peer\'s traffic', async () => {
  const m = await mirrorWith();
  const victim = await plain();
  const other = await plain();
  const sv = victim.join(await Space.create(victim.identity));
  const so = other.join(await Space.open(sv.invite));
  await victim.watch({ space: sv });
  await other.watch({ space: so });
  await connectInProcess(victim, m).ready;
  await connectInProcess(other, m).ready;
  const replaced = new Promise((resolve) => m.bus.on('net.peer.down', ({ peer }) => peer === victim.peerId && resolve()));
  const impostor = await createQu({ netId: victim.peerId }); // learned the id, e.g. over a direct link
  const seen = frames(impostor);
  await connectInProcess(impostor, m).ready;
  await replaced;
  await other.write(so, 'chat', 'for the victim');
  await settle(200);
  assert.equal(seen.filter((f) => f.type === 'rec').length, 0);
});

test('maxSpaces: a mirror accepts no new spaces beyond its limit, known ones keep working', async () => {
  const m = await mirrorWith({ maxSpaces: 1 });
  const full = [];
  m.bus.on('mirror.full', (e) => full.push(e));
  const a = await plain();
  const s1 = a.join(await Space.create(a.identity));
  await connectInProcess(a, m).ready;
  await a.write(s1, 'chat', 'first space');
  await until(async () => (await a.syncStatus()).outbox === 0, 5000, 'first space stored');
  const s2 = a.join(await Space.create(a.identity));
  await a.write(s2, 'chat', 'second space');
  await until(() => full.length > 0, 5000, 'refused');
  await settle(100);
  assert.equal(await m.mirror.count(s2.id), 0);
  assert.deepEqual(await m.mirror.spaces(), [s1.id]);
  await a.write(s1, 'chat', 'still fine');
  await until(async () => (await m.mirror.count(s1.id)) === 2, 5000, 'known space keeps working');
});
