/**
 * Sync traffic: what a reconcile sends beyond the records themselves.
 * Guarantees: one session per (peer, scope), bounded concurrency instead of
 * `busy` declines, the digest pre-check (and its fallback to the plain
 * reconcile), no double upload of outbox records, batched acks, no acks to
 * mirrors, the direct download (pull) into an empty scope with its fallbacks,
 * and paced sending. Results must stay identical to the plain reconcile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQu, records, sync, Space, connectInProcess, memoryDriver } from '../src/index.js';
import { until, settle } from './helpers.js';

async function peer(options = {}, qu = null) {
  qu ??= await createQu(options.root ? { root: options.root, identity: options.identity } : {});
  qu.use(records());
  const { root, identity, ...syncOptions } = options;
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ...syncOptions }));
  return qu;
}

/** Frames leaving `qu`, counted per type. */
/** Frames leaving `qu` per type; `rec` counts records, whether sent alone or batched in `recs`. */
function frames(qu) {
  const count = {};
  qu.bus.on('net.out.*.*', (payload, ctx) => {
    const type = ctx.topic.split('.')[3];
    count[type] = (count[type] ?? 0) + 1;
    if (type === 'recs') count.rec = (count.rec ?? 0) + payload.items.length;
  });
  return count;
}

async function spaces(n, ...peers) {
  const out = peers.map(() => []);
  for (let i = 0; i < n; i++) {
    const secret = (await Space.create()).invite;
    for (let p = 0; p < peers.length; p++) out[p].push(peers[p].join(await Space.open(secret)));
  }
  return out;
}

const recCount = async (qu) => (await qu.storage.keys('rec/')).length;

test('upload: each outbox record crosses the link once, acks come batched', async () => {
  const mirror = await peer({ role: 'mirror' });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(3, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 60; i++) await client.write(s, 'chat', i);
  for (const s of cs) await client.watch({ space: s });
  const out = frames(client);
  const back = frames(mirror);
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  await settle(50);
  assert.equal(out.rec, 180, 'every record exactly once');
  assert.ok(back.ack <= 30, `acks batched (${back.ack} frames for 180 records)`);
  await Promise.all([client.close(), mirror.close()]);
});

test('download: watch() racing the reconnect fetches every record once; a mirror gets no acks', async () => {
  const mirror = await peer({ role: 'mirror' });
  const writer = await peer({ ackFrom: 'mirror' });
  const [ms, ws] = await spaces(10, mirror, writer);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of ws) for (let i = 0; i < 20; i++) await writer.write(s, 'chat', i);
  const seed = connectInProcess(writer, mirror);
  await seed.ready;
  await until(async () => (await writer.syncStatus()).outbox === 0);

  const fresh = await peer({ ackFrom: 'mirror' });
  const freshSpaces = [];
  for (const s of ws) freshSpaces.push(fresh.join(await Space.open(s.invite)));
  const out = frames(fresh);
  const sent = frames(mirror);
  const declined = [];
  fresh.bus.on('sync.error', (e) => declined.push(e.error));
  const link = connectInProcess(fresh, mirror);
  // no await link.ready: the watches race the handshake and the mirror's hello on purpose
  await Promise.all(freshSpaces.map((space) => fresh.watch({ space })));
  await until(async () => (await recCount(fresh)) >= 200, 10_000);
  await settle(50);
  assert.equal(sent.rec, 200, `records sent once (${sent.rec})`);
  assert.equal(out.ack ?? 0, 0, 'no acks to a mirror');
  assert.deepEqual(declined, [], '10 spaces > responder limit: queued, never declined');
  assert.equal((await fresh.syncStatus()).pending, 0);
  await link.disconnect();
  await Promise.all([fresh.close(), writer.close(), mirror.close(), seed.disconnect()]);
});

test('digest: an unchanged reconnect runs no Negentropy session; a changed scope still reconciles', async () => {
  const mirror = await peer({ role: 'mirror' });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(5, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) await client.write(s, 'chat', 'hi');
  for (const s of cs) await client.watch({ space: s });
  let link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  await link.disconnect();

  const out = frames(client);
  const done = [];
  client.bus.on('sync.done', (e) => done.push(e));
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.length === 5);
  assert.equal(out.digest, 1, 'one digest frame for all five scopes');
  assert.equal(out.neg ?? 0, 0, 'no reconcile session');
  assert.ok((await client.lastSync(cs[0].id)) !== null, 'a matching digest counts as a complete reconcile with the mirror');
  await link.disconnect();

  // the mirror got a record the client lacks -> that scope (only) reconciles and fetches it
  const other = await peer({});
  const os = other.join(await Space.open(cs[2].invite));
  await other.write(os, 'chat', 'from elsewhere');
  const l2 = connectInProcess(other, mirror);
  await l2.ready;
  await until(async () => (await other.syncStatus()).outbox === 0);
  done.length = 0;
  for (const k of Object.keys(out)) delete out[k];
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.length === 5);
  assert.equal(out.neg, 1, 'exactly the changed scope reconciles');
  assert.deepEqual(
    (await client.query({ space: cs[2], path: 'chat' })).map((r) => r.value),
    ['hi', 'from elsewhere']
  );
  await Promise.all([link.disconnect(), l2.disconnect(), client.close(), mirror.close(), other.close()]);
});

test('digest is optional: with a peer that does not offer it, the plain reconcile gives the same result', async () => {
  const mirror = await peer({ role: 'mirror', digest: false });
  const client = await peer({ ackFrom: 'mirror' });
  const [ms, cs] = await spaces(2, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) await client.write(s, 'chat', 'x');
  for (const s of cs) await client.watch({ space: s });
  const out = frames(client);
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  assert.equal(out.digest ?? 0, 0);
  assert.equal(out.neg, 2);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});

test('a busy decline is retried within seconds, not after retryMs', async () => {
  // responder accepts one session, initiator does not limit itself: the second scope is declined once
  const mirror = await peer({ role: 'mirror', maxSessionsPerPeer: 1, digest: false });
  const client = await peer({ ackFrom: 'mirror', maxConcurrentPerPeer: 8, retryMs: 600_000 });
  const [ms, cs] = await spaces(6, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 40; i++) await client.write(s, 'chat', i);
  for (const s of cs) await client.watch({ space: s });
  const errors = [];
  const done = new Set();
  client.bus.on('sync.error', (e) => errors.push(e.error));
  client.bus.on('sync.done', (e) => done.add(e.sid));
  const started = Date.now();
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => done.size === 6, 15_000, 'all six scopes reconciled');
  assert.ok(errors.includes('declined: busy'), 'the responder declined some sessions');
  assert.ok(Date.now() - started < 15_000, 'retried long before retryMs (10 min)');
  assert.equal((await client.syncStatus()).pending, 0);
  for (const s of ms) assert.equal((await mirror.query({ space: s, path: 'chat' })).length, 40);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});

test('reload while offline: outbox and pending survive, everything converges with digests on', async () => {
  const disk = memoryDriver();
  const mirror = await peer({ role: 'mirror' });
  let client = await peer({ ackFrom: 'mirror', root: disk });
  const identity = client.identity;
  const [ms, cs] = await spaces(3, mirror, client);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of cs) for (let i = 0; i < 5; i++) await client.write(s, 'chat', i);
  await client.close({ keepStore: true });

  client = await peer({ ackFrom: 'mirror', root: disk, identity });
  const again = [];
  for (const s of cs) again.push(client.join(await Space.open(s.invite)));
  for (const s of again) await client.watch({ space: s });
  const link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await client.syncStatus()).outbox === 0 && (await client.syncStatus()).pending === 0);
  for (const s of ms) assert.equal((await mirror.query({ space: s, path: 'chat' })).length, 5);
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});

/** A mirror holding `n` spaces x `per` records, written by a seeding peer. */
async function seededMirror(n, per, mirrorOptions = {}) {
  const mirror = await peer({ role: 'mirror', ...mirrorOptions });
  const writer = await peer({ ackFrom: 'mirror' });
  const [ms, ws] = await spaces(n, mirror, writer);
  for (const s of ms) await mirror.watch({ space: s });
  for (const s of ws) for (let i = 0; i < per; i++) await writer.write(s, i % 10 === 0 ? 'secret' : 'chat', i);
  const link = connectInProcess(writer, mirror);
  await link.ready;
  await until(async () => (await writer.syncStatus()).outbox === 0, 20_000);
  await link.disconnect();
  await writer.close();
  return { mirror, invites: ws.map((s) => s.invite), mirrorSpaces: ms };
}

async function freshDevice(invites, options = {}) {
  const qu = await peer({ ackFrom: 'mirror', ...options });
  const joined = [];
  for (const invite of invites) joined.push(qu.join(await Space.open(invite)));
  return { qu, joined };
}

const allRecords = async (qu, spaces) => {
  const out = [];
  for (const s of spaces) out.push(...(await qu.query({ space: s, path: 'chat' })).map((r) => r.value), ...(await qu.query({ space: s, path: 'secret' })).map((r) => r.value));
  return out.sort((x, y) => x - y);
};

test('pull: an empty device downloads without id lists, verified by fingerprint, and counts as a complete sync', async () => {
  const { mirror, invites } = await seededMirror(3, 50);
  const { qu: fresh, joined } = await freshDevice(invites);
  const out = frames(fresh);
  const back = frames(mirror);
  const pulls = [];
  fresh.bus.on('sync.pull', (e) => pulls.push(e));
  const link = connectInProcess(fresh, mirror);
  await Promise.all(joined.map((space) => fresh.watch({ space })));
  await until(() => pulls.length === 3, 10_000);
  await until(async () => (await fresh.syncStatus()).pending === 0);
  assert.deepEqual(pulls.map((p) => [p.complete, p.received]), [[true, 50], [true, 50], [true, 50]]);
  assert.equal(out.pull, 3);
  assert.equal(out.want ?? 0, 0, 'no id list from the device');
  assert.equal(out.neg ?? 0, 0, 'no reconcile session');
  assert.equal(back.negr ?? 0, 0, 'no id list from the mirror');
  assert.equal(back.rec, 150);
  assert.equal((await allRecords(fresh, joined)).length, 150);
  for (const s of joined) assert.ok((await fresh.lastSync(s.id)) !== null, 'a verified pull from a mirror proves the device current');
  await link.disconnect();
  await Promise.all([fresh.close(), mirror.close()]);
});

test('pull falls back to the reconcile when the sets differ - same result as without pull', async () => {
  const { mirror, invites } = await seededMirror(2, 30);
  // this device refuses one path: the pulled set can never match the mirror's
  const refuse = (qu) =>
    qu.bus.on('qu.accept', (record, ctx) => {
      if (record.path === 'secret') ctx.stop();
    });
  const withPull = await freshDevice(invites);
  const without = await freshDevice(invites, { pull: false });
  refuse(withPull.qu);
  refuse(without.qu);
  const pulls = [];
  withPull.qu.bus.on('sync.pull', (e) => pulls.push(e));
  const negs = frames(withPull.qu);
  const results = [];
  for (const { qu, joined } of [withPull, without]) {
    const link = connectInProcess(qu, mirror);
    await link.ready;
    const summaries = await Promise.all(joined.map((space) => qu.resync({ space })));
    results.push({ stored: await allRecords(qu, joined), missing: summaries.flat().reduce((n, s) => n + s.missing.length, 0) });
    await link.disconnect();
  }
  assert.ok(pulls.length >= 2 && pulls.every((p) => p.complete === false && p.reason === 'different set'));
  assert.ok(negs.neg >= 2, 'fell back to Negentropy');
  assert.deepEqual(results[0], results[1], 'identical outcome with and without pull');
  assert.equal(results[0].stored.length, 54);
  await Promise.all([withPull.qu.close(), without.qu.close(), mirror.close()]);
});

test('pull is optional: a peer without the feature gets the plain reconcile', async () => {
  const { mirror, invites } = await seededMirror(2, 20, { pull: false });
  const { qu: fresh, joined } = await freshDevice(invites);
  const out = frames(fresh);
  const link = connectInProcess(fresh, mirror);
  await link.ready;
  await Promise.all(joined.map((space) => fresh.resync({ space })));
  assert.equal(out.pull ?? 0, 0);
  assert.ok(out.neg >= 2);
  assert.equal((await allRecords(fresh, joined)).length, 40);
  await link.disconnect();
  await Promise.all([fresh.close(), mirror.close()]);
});

test('pull interrupted by a disconnect stays pending; the next connect completes it by reconcile', async () => {
  const { mirror, invites } = await seededMirror(1, 300);
  const { qu: fresh, joined } = await freshDevice(invites);
  let link = connectInProcess(fresh, mirror);
  await link.ready;
  // the mirror's send buffer "fills up" after 40 records - then the link drops
  const sent = frames(mirror);
  const end = mirror.net.links.get(fresh.peerId);
  end.buffered = () => ((sent.rec ?? 0) >= 40 ? 10_000 : 0);
  end.maxBuffered = 1000;
  fresh.watch({ space: joined[0] });
  // whatever went out before the buffer "filled" (40 single records or one batch of 64) arrives
  await until(async () => sent.rec > 0 && (await allRecords(fresh, joined)).length === sent.rec, 5000);
  await link.disconnect();
  await settle(50);
  assert.ok((await allRecords(fresh, joined)).length < 300, 'interrupted');
  assert.equal((await fresh.syncStatus()).pending, 1, 'remembered as unfinished');

  const out = frames(fresh);
  link = connectInProcess(fresh, mirror);
  await link.ready;
  await until(async () => (await fresh.syncStatus()).pending === 0, 10_000);
  assert.equal((await allRecords(fresh, joined)).length, 300);
  assert.equal(out.pull ?? 0, 0, 'not empty any more: reconcile, fetching only the rest');
  await link.disconnect();
  await Promise.all([fresh.close(), mirror.close()]);
});

test('pacing: bulk sends wait while the send buffer is full, and stop when the link goes', async () => {
  const { mirror, invites } = await seededMirror(1, 60);
  const { qu: fresh, joined } = await freshDevice(invites);
  const link = connectInProcess(fresh, mirror);
  await link.ready;
  // the in-process channel cannot fill up - give the mirror's end of the link a fake buffer
  const pressure = { bytes: 10_000 };
  const end = mirror.net.links.get([...mirror.net.links.keys()][0]);
  end.buffered = () => pressure.bytes;
  end.maxBuffered = 1000; // high-water mark 250 B, low 62 B
  const sent = frames(mirror);
  fresh.watch({ space: joined[0] });
  await settle(300);
  assert.equal(sent.rec ?? 0, 0, 'nothing sent into a full buffer');
  pressure.bytes = 0;
  await until(async () => (await allRecords(fresh, joined)).length === 60, 5000);

  // full again, then the link drops: the sender gives up instead of waiting forever
  const again = await freshDevice(invites);
  const l2 = connectInProcess(again.qu, mirror);
  await l2.ready;
  const end2 = mirror.net.links.get(again.qu.peerId);
  end2.buffered = () => 10_000;
  end2.maxBuffered = 1000;
  const before = sent.rec;
  again.qu.watch({ space: again.joined[0] });
  await settle(200);
  await l2.disconnect();
  await settle(100);
  assert.equal(sent.rec, before, 'no record sent after the link went');
  await link.disconnect();
  await Promise.all([fresh.close(), again.qu.close(), mirror.close()]);
});

test('batched records: one frame per batch, identical result with a peer that does not batch', async () => {
  const results = [];
  for (const batch of [true, false]) {
    const { mirror, invites } = await seededMirror(3, 120, { batch });
    const { qu: fresh, joined } = await freshDevice(invites);
    const out = frames(mirror);
    const link = connectInProcess(fresh, mirror);
    await Promise.all(joined.map((space) => fresh.watch({ space })));
    await until(async () => (await allRecords(fresh, joined)).length === 360, 10_000);
    await until(async () => (await fresh.syncStatus()).pending === 0);
    results.push({ batch, records: await allRecords(fresh, joined), recs: out.recs ?? 0, rec: out.rec });
    await link.disconnect();
    await Promise.all([fresh.close(), mirror.close()]);
  }
  const [batched, single] = results;
  assert.deepEqual(batched.records, single.records, 'same records either way');
  assert.equal(batched.rec, 360);
  assert.ok(batched.recs > 0 && batched.recs <= 12, `batched in ${batched.recs} frames`);
  assert.equal(single.recs, 0, 'no recs frames to a peer that did not offer them');
});

test('batched records: concurrent pulls never mix their records (each completes, verified)', async () => {
  const { mirror, invites } = await seededMirror(8, 40);
  const { qu: fresh, joined } = await freshDevice(invites);
  const pulls = [];
  fresh.bus.on('sync.pull', (e) => pulls.push(e));
  const link = connectInProcess(fresh, mirror);
  await Promise.all(joined.map((space) => fresh.watch({ space })));
  await until(() => pulls.length === 8, 10_000, 'all pulls ended');
  assert.ok(pulls.every((p) => p.complete && p.received === 40), JSON.stringify(pulls.map((p) => [p.complete, p.received, p.reason])));
  await link.disconnect();
  await Promise.all([fresh.close(), mirror.close()]);
});

test('grants on reconnect: only fingerprints when the mirror has them, the grants it lacks, all of them to an older mirror', async () => {
  const { createClient } = await import('../src/index.js');
  const { sqliteDriver, nodeRegistry } = await import('../src/node.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qu-grants-'));
  const makeMirror = async (options = {}) => {
    const { createPeer } = await import('../src/peer.js');
    return createPeer({ registry: nodeRegistry(), store: sqliteDriver({ path: join(dir, 'm.sqlite') }), plugins: [['sync', { role: 'mirror', retryMs: 0 }], 'mirror'], ...options });
  };
  let mirror = await makeMirror();
  await mirror.mirror.ready;
  const client = await createClient({ devtools: false, transports: [] });
  for (let i = 0; i < 4; i++) await client.createGroup();
  let out = frames(client);
  let link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await mirror.mirror.spaces()).length >= 4, 5000, 'mirror took the grants');
  await link.disconnect();

  // reconnect, nothing new: fingerprints only
  out = frames(client);
  link = connectInProcess(client, mirror);
  await link.ready;
  await settle(200);
  assert.equal(out.grantsum, 1);
  assert.equal(out.grant ?? 0, 0, 'no grants re-sent');
  await link.disconnect();

  // a new group while offline: exactly its grants are asked for
  await client.createGroup();
  out = frames(client);
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => (out.grant ?? 0) >= 1, 3000, 'grant sent');
  await settle(100);
  assert.equal(out.grant, 1, 'only the new space');
  await link.disconnect();

  // after a mirror restart (keyring rebuilt from its database) the fingerprints still match
  await mirror.close();
  mirror = await makeMirror();
  await mirror.mirror.ready;
  out = frames(client);
  link = connectInProcess(client, mirror);
  await link.ready;
  await settle(200);
  assert.equal(out.grant ?? 0, 0, 'restart: nothing re-sent');
  await link.disconnect();
  await mirror.close();

  // an older mirror (no grantsum in its hello) gets every grant, as before
  const old = await (await import('../src/peer.js')).createPeer({ plugins: [['sync', { role: 'mirror' }], 'mirror'] });
  old.net.features.delete('grantsum');
  out = frames(client);
  link = connectInProcess(client, old);
  await link.ready;
  await until(() => (out.grant ?? 0) >= 5, 3000, 'all grants');
  assert.equal(out.grantsum ?? 0, 0);
  await link.disconnect();
  await Promise.all([client.close(), old.close()]);
  rmSync(dir, { recursive: true, force: true });
});

test('grants on reconnect: a key rotation made offline changes the fingerprint - the mirror asks for it', async () => {
  const { createClient } = await import('../src/index.js');
  const mirror = await (await import('../src/peer.js')).createPeer({ plugins: [['sync', { role: 'mirror' }], 'mirror'] });
  const client = await createClient({ devtools: false, transports: [] });
  const group = await client.createGroup();
  let link = connectInProcess(client, mirror);
  await link.ready;
  await until(async () => (await mirror.mirror.spaces()).includes(group.id), 3000);
  await link.disconnect();

  await (await client.members(group)).rotate(); // new epoch while offline
  const out = frames(client);
  link = connectInProcess(client, mirror);
  await link.ready;
  await until(() => (out.grant ?? 0) >= 1, 3000, 'rotated grants sent');
  assert.ok(mirror.keyring.epochs(group.id).has(1), 'the mirror knows epoch 1');
  await client.write(group, 'chat', 'after rotation');
  await until(async () => (await client.syncStatus()).outbox === 0, 3000, 'accepted by the mirror');
  await link.disconnect();
  await Promise.all([client.close(), mirror.close()]);
});
