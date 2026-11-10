import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, CLIENT_PLUGINS, crypto } from '../src/index.js';
import { memoryDriver } from '../src/drivers/memory.js';
import { createRelay } from '../src/node.js';
import { vaultClient } from '../src/keys.js';
import { until } from './helpers.js';
void vaultClient;

const quiet = () => {};

/**
 * A stand-in for navigator.credentials with hardware keys that support PRF:
 * every credential has its own secret; PRF = HMAC(secret, input), like CTAP2 hmac-secret.
 * `tap(name)` chooses which key the user presents next (discoverable login).
 */
function fakeKeys() {
  const creds = new Map(); // id hex -> {id, secret, key}
  let presented = null;
  let cancelNext = false;
  const taps = { create: 0, get: 0 };
  const prf = async (secret, input) => new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), input));
  return {
    taps,
    tap(key) {
      presented = key;
    },
    cancel() {
      cancelNext = true;
    },
    async create({ publicKey }) {
      taps.create++;
      if (cancelNext) throw ((cancelNext = false), new DOMException('cancelled', 'NotAllowedError'));
      assert.equal(publicKey.authenticatorSelection.residentKey, 'required');
      const id = crypto.randomBytes(16);
      creds.set(crypto.toHex(id), { id, secret: crypto.randomBytes(32), key: presented });
      return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }; // like most security keys: no PRF result on create
    },
    async get({ publicKey }) {
      taps.get++;
      if (cancelNext) throw ((cancelNext = false), new DOMException('cancelled', 'NotAllowedError'));
      const allowed = publicKey.allowCredentials.map((c) => crypto.toHex(c.id));
      const cred = [...creds.values()].find((c) => c.key === presented && (!allowed.length || allowed.includes(crypto.toHex(c.id))));
      if (!cred) throw new DOMException('no credential on this key', 'NotAllowedError');
      const first = await prf(cred.secret, publicKey.extensions.prf.eval.first);
      return { rawId: cred.id.buffer, getClientExtensionResults: () => ({ prf: { results: { first: first.buffer } } }) };
    },
  };
}

const plugins = (credentials) => [...CLIENT_PLUGINS.filter((p) => p !== 'device'), ['device', { credentials, vaultDelayMs: 50 }]];

test('security keys: register on one device, unlock identity and groups on another with one tap', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const keys = fakeKeys();
  keys.tap('yubikey');

  const pc = await createClient({ url, devtools: false, plugins: plugins(keys) });
  const family = await pc.createGroup();
  await pc.write(family, 'chat', 'vom PC');
  const added = await pc.device.addKey({ name: 'YubiKey blau' });
  assert.equal(added.synced, true, 'the relay holds the tresor');
  assert.deepEqual((await pc.device.keys()).map((k) => k.name), ['YubiKey blau']);
  assert.deepEqual(keys.taps, { create: 1, get: 1 }, 'register + one get (no PRF on create)');
  // a group created later travels too (the tresor follows, debounced)
  const refreshed = new Promise((resolve) => pc.bus.on('qu.device.vault', ({ synced }) => synced && resolve()));
  const work = await pc.createGroup();
  await refreshed;

  // the phone: empty storage, one tap
  const before = keys.taps.get;
  const phone = await createClient({ url, devtools: false, unlock: { credentials: keys }, plugins: plugins(keys) });
  assert.equal(keys.taps.get, before + 1, 'one tap');
  assert.equal(crypto.toHex(phone.identity.publicKey), crypto.toHex(pc.identity.publicKey), 'same identity');
  const groups = await phone.restoreGroups();
  assert.deepEqual(groups.map((g) => g.id).sort(), [family.id, work.id].sort(), 'both groups');
  await until(async () => (await phone.query({ space: phone.space(family.id), path: 'chat' })).length === 1, 5000, 'messages sync');
  await phone.close();

  await pc.close();
  await relay.close();
});

test('security keys: key lock (every start taps), errors, spare key, removal, relay refuses foreign writes', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const keys = fakeKeys();
  const store = memoryDriver();
  keys.tap('blue');
  let qu = await createClient({ url, store, devtools: false, plugins: plugins(keys) });
  const me = crypto.toHex(qu.identity.publicKey);
  const group = await qu.createGroup();
  await qu.device.addKey({ name: 'blau', lock: true });
  keys.tap('spare');
  const spare = await qu.device.addKey({ name: 'Ersatz' });
  assert.deepEqual((await qu.device.status()).keyLocked, true);
  assert.ok(!(await store.get('qu/identity')), 'no usable identity at rest');
  await qu.close();

  // without unlock: refused, never a new identity
  await assert.rejects(createClient({ url, store, devtools: false, plugins: plugins(keys) }), (e) => e.code === 'QU_LOCKED');
  // cancelled
  keys.cancel();
  await assert.rejects(createClient({ url, store, devtools: false, unlock: { credentials: keys }, plugins: plugins(keys) }), (e) => e.code === 'QU_KEY_CANCELLED');
  // with the key: opens locally (no relay needed), still locked at rest
  keys.tap('blue');
  qu = await createClient({ url, store, devtools: false, unlock: { credentials: keys }, plugins: plugins(keys) }); // the tresor is local: opens without the relay
  assert.equal(crypto.toHex(qu.identity.publicKey), me);
  assert.deepEqual((await qu.restoreGroups()).map((g) => g.id), [group.id]);
  assert.ok(!(await store.get('qu/identity')));

  // the spare key opens it on a new device; then the spare is removed (lost)
  keys.tap('spare');
  const other = await createClient({ url, devtools: false, unlock: { credentials: keys }, plugins: plugins(keys) });
  assert.equal(crypto.toHex(other.identity.publicKey), me);
  await other.close();
  await qu.device.removeKey(spare.id);
  assert.deepEqual((await qu.device.keys()).map((k) => k.name), ['blau']);
  await assert.rejects(createClient({ url, devtools: false, unlock: { credentials: keys }, plugins: plugins(keys) }), (e) => e.code === 'QU_KEY_UNKNOWN' || e.code === 'QU_KEY_CANCELLED');

  // a key nobody registered
  keys.tap('blue');
  const stranger = fakeKeys();
  stranger.tap('x');
  const tmp = await createClient({ devtools: false, plugins: plugins(stranger) });
  await tmp.device.addKey({ name: 'nur lokal' }); // no relay: works, stays local
  await tmp.close();
  await assert.rejects(createClient({ url, devtools: false, unlock: { credentials: stranger }, plugins: plugins(stranger) }), (e) => e.code === 'QU_KEY_UNKNOWN');

  // the relay binds a key's tresor to its identity
  const intruder = await crypto.generateIdentity();
  const blue = (await qu.device.keys())[0].id;
  const idBytes = crypto.fromBase64(blue.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (blue.length % 4)) % 4));
  await assert.rejects(vaultClient(url).put(idBytes, null, intruder), /403/);
  assert.ok(await vaultClient(url).get(idBytes), 'still there');

  // a key without PRF support
  const noPrf = { create: async () => ({ rawId: new Uint8Array(8).buffer, getClientExtensionResults: () => ({ prf: { enabled: false } }) }) };
  const q2 = await createClient({ devtools: false, plugins: plugins(noPrf) });
  await assert.rejects(q2.device.addKey(), (e) => e.code === 'QU_KEY_UNSUPPORTED');
  await q2.close();

  await qu.close();
  await relay.close();
});
