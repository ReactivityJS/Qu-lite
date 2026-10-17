import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQu, createPeer, records, sync, blobs, mirror, memoryDriver, Space, connectInProcess } from '../src/index.js';
import { until } from './helpers.js';

const bytesOf = (n, seed = 1) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) out[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return out;
};

/** A wake lock that records what happened. */
function fakeWakeLock() {
  const log = [];
  return {
    log,
    async request(type) {
      log.push(`request ${type}`);
      return { release: async () => log.push('release'), addEventListener() {} };
    },
  };
}

async function client({ disk, blobOptions = {}, syncOptions = {} } = {}) {
  const qu = await createQu({ root: disk });
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 5000, retryMs: 0, ...syncOptions }));
  qu.use(blobs({ chunkSize: 16 * 1024, wakeLock: null, warnOnUnload: false, ...blobOptions }));
  await qu.blobs.ready;
  return qu;
}

async function mirrorNode() {
  const m = await createQu();
  m.use(sync({ role: 'mirror', timeoutMs: 5000, retryMs: 0 }));
  m.use(mirror());
  await m.mirror.ready;
  return m;
}

test('put/get round trip: empty, one byte, exact chunk multiples, odd sizes; same content = same ref, nothing rewritten', async () => {
  const qu = await client();
  const space = qu.join(await Space.create(qu.identity));
  for (const size of [0, 1, 16 * 1024, 3 * 16 * 1024, 50_001]) {
    const data = bytesOf(size, size + 1);
    const ref = await qu.blobs.put(space, data, { type: 'application/octet-stream', name: `f${size}` });
    assert.equal(ref.size, size);
    assert.equal(ref.chunks, Math.ceil(size / (16 * 1024)));
    assert.equal(ref.name, `f${size}`);
    assert.deepEqual(await qu.blobs.get(space, ref), data, `size ${size}`);
    assert.deepEqual(await qu.blobs.has(space, ref.blob), { have: ref.chunks, total: ref.chunks, complete: true });
  }
  const data = bytesOf(40_000, 7);
  const first = await qu.blobs.put(space, data.buffer.slice(0)); // ArrayBuffer works too
  const before = (await qu.storage.keys(`rec/${space.id}/`)).length;
  const again = await qu.blobs.put(space, new Blob([data])); // and a Blob (read in slices)
  assert.equal(again.blob, first.blob);
  assert.equal((await qu.storage.keys(`rec/${space.id}/`)).length, before, 'dedupe: no new records');
  await assert.rejects(qu.blobs.put(space, bytesOf(10), { type: 'x' }).then(() => qu.blobs.get(space, 'feedbeef', { wait: false })), /incomplete/);
});

test('a blob travels through the blind mirror: progress up and down, the mirror holds only ciphertext', async () => {
  const m = await mirrorNode();
  const alice = await client({ syncOptions: { ackFrom: 'mirror' } });
  const bob = await client();
  const sa = alice.join(await Space.create(alice.identity));
  const sb = bob.join(await Space.open(sa.invite));
  await alice.watch({ space: sa });
  await bob.watch({ space: sb, path: 'chat' }); // partial sync: blobs are fetched on demand
  await connectInProcess(alice, m).ready;
  await connectInProcess(bob, m).ready;

  const marker = new TextEncoder().encode('SECRET-ATTACHMENT-CONTENT ');
  const data = new Uint8Array(150_000);
  for (let i = 0; i < data.length; i++) data[i] = marker[i % marker.length];
  const up = [];
  alice.bus.on('qu.blob.progress', (e) => up.push(e));
  const doneUp = new Promise((resolve) => alice.bus.on('qu.blob.done', resolve));
  const ref = await alice.blobs.put(sa, data, { type: 'text/plain', name: 'secret.txt' });
  await alice.write(sa, 'chat', { text: 'see attachment', file: ref });
  await doneUp;
  assert.equal(up.at(-1).done, up.at(-1).total);
  assert.equal(up.at(-1).total, ref.chunks + 1, 'chunks + manifest');
  assert.deepEqual(alice.blobs.pending(), []);

  // bob sees the message, then fetches exactly that blob
  await until(async () => (await bob.query({ space: sb, path: 'chat' })).length === 1, 5000, 'bob gets the message');
  assert.equal((await bob.blobs.has(sb, ref)).have, 0, 'not synced before it is asked for');
  const down = [];
  bob.bus.on('qu.blob.progress', (e) => e.direction === 'down' && down.push(e));
  const [message] = await bob.query({ space: sb, path: 'chat' });
  const got = await bob.blobs.get(sb, message.value.file, { timeoutMs: 10_000 });
  assert.deepEqual(got, data);
  assert.equal(down.at(-1).done, ref.chunks);

  for (const key of await m.storage.keys(`rec/${sa.id}/`)) {
    assert.equal(Buffer.from(await m.storage.get(key)).includes('SECRET-ATTACHMENT'), false, 'mirror stores ciphertext only');
  }
});

test('an upload written offline survives a reload and completes on reconnect - with the screen kept awake meanwhile', async () => {
  const m = await mirrorNode();
  const disk = memoryDriver();
  const wake = fakeWakeLock();
  const peer = (d) => createPeer({ store: d, plugins: ['records', ['sync', { releaseMs: 0, timeoutMs: 5000, retryMs: 0, ackFrom: 'mirror' }], ['blobs', { chunkSize: 16 * 1024, wakeLock: wake, warnOnUnload: false }]] });
  let alice = await peer(disk);
  const invite = (await Space.create(alice.identity)).invite;
  let space = alice.join(await Space.open(invite));
  const data = bytesOf(70_000, 3);
  const ref = await alice.blobs.put(space, data);
  assert.equal(alice.blobs.pending()[0].direction, 'up');
  assert.equal(alice.blobs.awake, false, 'offline: no wake lock, it would only drain the battery');

  // reload: same storage, new peer
  alice = await peer(disk);
  space = alice.join(await Space.open(invite));
  await alice.blobs.ready;
  assert.equal(alice.blobs.pending().length, 1, 'the unfinished upload is known after the reload');
  const done = new Promise((resolve) => alice.bus.on('qu.blob.done', resolve));
  let awakeWhileUploading = false;
  alice.bus.on('qu.blob.progress', () => (awakeWhileUploading ||= alice.blobs.awake));
  await alice.watch({ space });
  await connectInProcess(alice, m).ready;
  await done;
  assert.equal(awakeWhileUploading, true, 'connected and uploading: the screen is kept on');
  assert.equal(wake.log[0], 'request screen');
  assert.deepEqual(alice.blobs.pending(), []);
  assert.equal(alice.blobs.awake, false);
  assert.equal(wake.log.at(-1), 'release');
  assert.equal(await m.mirror.count(space.id), ref.chunks + 1);
});

test('junk under a blob path changes nothing; get() times out on a blob nobody has; delete reaches the mirror', async () => {
  const m = await mirrorNode();
  const alice = await client();
  const bob = await client();
  const sa = alice.join(await Space.create(alice.identity));
  const sb = bob.join(await Space.open(sa.invite));
  await alice.watch({ space: sa });
  await bob.watch({ space: sb });
  await connectInProcess(alice, m).ready;
  await connectInProcess(bob, m).ready;

  const data = bytesOf(40_000, 9);
  const ref = await alice.blobs.put(sa, data);
  // bob (a member) writes a forged chunk 0 and a forged manifest under the same path
  await bob.write(sb, bob.blobs.path(ref.blob), { i: 0, d: Buffer.from('not the real chunk').toString('base64') });
  await bob.write(sb, bob.blobs.path(ref.blob), { v: 1, size: 3, chunkSize: 16384, hashes: Buffer.alloc(32).toString('base64') });
  await until(async () => (await alice.query({ space: sa, path: alice.blobs.path(ref.blob) })).length === ref.chunks + 3, 5000, 'junk arrived');
  assert.deepEqual(await alice.blobs.get(sa, ref), data);
  assert.deepEqual(await bob.blobs.get(sb, ref, { timeoutMs: 5000 }), data);

  await assert.rejects(bob.blobs.get(sb, 'ab'.repeat(16), { timeoutMs: 200 }), /incomplete after 200 ms/);

  assert.equal(await alice.blobs.del(sa, ref), ref.chunks + 3);
  await until(async () => (await bob.blobs.has(sb, ref)).have === 0, 5000, 'gone at bob');
  // alice owns the space, so her drop list also removes bob's junk: only the drop list itself is left
  await until(async () => (await m.mirror.count(sa.id)) === 1, 5000, 'mirror dropped every record of the blob');
});
