/**
 * Device backup and restore (device.js): the encrypted format and its
 * failure modes, a complete restore on a new device over a real relay
 * (identity, groups, epoch keys, profile, messages in both directions), the
 * guard against overwriting another identity, and the storage status.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, readBackup, device, createQu, memoryDriver } from '../src/index.js';
import { toHex } from '../src/crypto.js';
import { sealBackup } from '../src/device.js';
import { createRelay } from '../src/node.js';
import { until } from './helpers.js';

const PASS = 'correct horse battery staple';
const fast = { iterations: 1000 };

test('backup format: round trip; wrong passphrase, damage and lowered iterations all fail the same way', async () => {
  const identity = { publicKey: new Uint8Array([1, 2]), privateKey: new Uint8Array([3]), xPublicKey: new Uint8Array([4]), xPrivateKey: new Uint8Array([5]) };
  const entries = [['members/groups/abc', { secret: 'c2VjcmV0', owner: 'ff' }]];
  const text = await sealBackup({ identity, entries }, PASS, fast);
  assert.match(text, /^qu-backup\.[A-Za-z0-9_-]+$/, 'one line, URL-safe');
  const back = await readBackup(`  ${text}\n`, PASS);
  assert.deepEqual(back.identity, identity);
  assert.deepEqual(back.entries, entries);
  assert.ok(Math.abs(back.created - Date.now()) < 10_000);

  const failure = /wrong passphrase or damaged backup/;
  await assert.rejects(readBackup(text, 'correct horse battery stapler'), failure);
  const flipped = text.slice(0, -5) + (text.at(-5) === 'A' ? 'B' : 'A') + text.slice(-4);
  await assert.rejects(readBackup(flipped, PASS), failure);
  await assert.rejects(readBackup(text.slice(0, 60), PASS), failure);
  // an attacker lowering the iteration count breaks the authenticated header
  const outer = JSON.parse(Buffer.from(text.slice(10), 'base64url').toString());
  outer.h = outer.h.replace('"iterations":1000', '"iterations":1');
  await assert.rejects(readBackup('qu-backup.' + Buffer.from(JSON.stringify(outer)).toString('base64url'), PASS), failure);
  await assert.rejects(readBackup('hello', PASS), /not a qu-lite backup/);
  await assert.rejects(sealBackup({ identity, entries }, 'short', fast), /at least 8 characters/);
});

test('restore on a new device over a real relay: same identity, groups, profile and messages - both ways', async () => {
  const relay = await createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  const url = `http://127.0.0.1:${relay.port}`;
  const ws = { WebSocketImpl: WebSocket, minDelayMs: 50 };
  const old = await createClient({ url, relay: ws, devtools: false });
  let fresh = null;
  try {
    const group = await old.createGroup();
    for (const text of ['eins', 'zwei', 'drei']) await old.write(group, 'chat', text);
    await (await old.me()).set('name', 'Anna');
    await until(async () => (await old.syncStatus()).outbox === 0, 10_000, 'old device synced');

    const backup = await old.device.exportBackup(PASS);
    assert.ok((await old.device.status()).backupAt > 0, 'remembers when the last backup was made');

    fresh = await createClient({ url, relay: ws, devtools: false, restore: { backup, passphrase: PASS } });
    assert.equal(toHex(fresh.identity.publicKey), toHex(old.identity.publicKey), 'same identity');
    const [again] = await fresh.restoreGroups();
    assert.equal(again.id, group.id);
    await until(async () => (await fresh.query({ space: again, path: 'chat' })).length === 3, 10_000, 'messages back');
    assert.deepEqual((await fresh.query({ space: again, path: 'chat' })).map((r) => r.value), ['eins', 'zwei', 'drei']);
    await until(async () => (await (await fresh.me()).get('name')) === 'Anna', 10_000, 'profile back');

    // the restored device writes, the old one reads it (same identity on two devices)
    await fresh.write(again, 'chat', 'vom neuen Gerät');
    await until(async () => (await old.query({ space: group, path: 'chat' })).length === 4, 10_000, 'old device sees it');
  } finally {
    await Promise.all([old.close(), fresh?.close()]);
    await relay.close();
  }
});

test('restore never silently replaces another identity that has groups on this storage', async () => {
  const source = await createClient({ devtools: false });
  await source.createGroup();
  const backup = await source.device.exportBackup(PASS);
  await source.close();

  // a storage whose identity has a group
  const used = memoryDriver();
  const owner = await createClient({ store: used, devtools: false });
  await owner.createGroup();
  await owner.close({ keepStore: true });
  await assert.rejects(createClient({ store: used, devtools: false, restore: { backup, passphrase: PASS } }), /belongs to another identity with 1 group/);
  const forced = await createClient({ store: used, devtools: false, restore: { backup, passphrase: PASS, force: true } });
  assert.equal(toHex(forced.identity.publicKey), toHex((await readBackup(backup, PASS)).identity.publicKey));
  assert.equal((await forced.restoreGroups()).length, 1, 'only the restored group');
  await forced.close();

  // a fresh storage (identity created at first start, no groups) is simply taken over
  const blank = memoryDriver();
  const first = await createClient({ store: blank, devtools: false });
  await first.close({ keepStore: true });
  const restored = await createClient({ store: blank, devtools: false, restore: { backup, passphrase: PASS } });
  assert.equal((await restored.restoreGroups()).length, 1);
  // and a reload afterwards keeps the restored identity
  const id = toHex(restored.identity.publicKey);
  await restored.close({ keepStore: true });
  const reloaded = await createClient({ store: blank, devtools: false });
  assert.equal(toHex(reloaded.identity.publicKey), id);
  await reloaded.close();
});

test('storage status and persistence: null where unsupported, the browser answer where it is', async () => {
  const plain = await createQu();
  plain.use(device(fast));
  assert.deepEqual(await plain.device.status(), { persisted: null, usage: null, quota: null, backupAt: null, groups: 0 });
  assert.equal(await plain.device.persist(), null);
  await plain.close();

  const asked = [];
  const navigator = {
    storage: {
      persisted: async () => asked.includes('persist'),
      persist: async () => (asked.push('persist'), true),
      estimate: async () => ({ usage: 1234, quota: 1e9 }),
    },
  };
  const qu = await createQu();
  qu.use(device({ ...fast, navigator }));
  const granted = [];
  qu.bus.on('qu.device.persist', (e) => granted.push(e.granted));
  assert.equal((await qu.device.status()).persisted, false);
  assert.equal(await qu.device.persist(), true);
  assert.deepEqual(granted, [true]);
  assert.deepEqual(await qu.device.status(), { persisted: true, usage: 1234, quota: 1e9, backupAt: null, groups: 0 });
  await qu.close();
});
