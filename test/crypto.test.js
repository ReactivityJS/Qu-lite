import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, keypairFromSeed, sign, verify, sealTo, openSealed, toHex, fromHex, toBase64, fromBase64, randomBytes } from '../src/crypto.js';

test('encodings round-trip', () => {
  const bytes = randomBytes(33);
  assert.deepEqual(fromHex(toHex(bytes)), bytes);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.throws(() => fromHex('xyz'));
});

test('seeded key pairs are deterministic; signatures verify and reject tampering', async () => {
  const seed = randomBytes(32);
  const a = await keypairFromSeed('Ed25519', seed);
  const b = await keypairFromSeed('Ed25519', seed);
  assert.deepEqual(a.publicKey, b.publicKey);
  const data = new TextEncoder().encode('hallo');
  const sig = await sign(data, a.privateKey);
  assert.equal(await verify(data, sig, a.publicKey), true);
  assert.equal(await verify(new TextEncoder().encode('hallo!'), sig, a.publicKey), false);
  assert.equal(await verify(data, sig, new Uint8Array(3)), false); // malformed key: false, not a throw
});

test('sealed box: only the recipient opens it, and it names neither sender nor recipient', async () => {
  const bob = await generateIdentity();
  const eve = await generateIdentity();
  const box = await sealTo(bob.xPublicKey, new TextEncoder().encode('Einladung'));
  assert.equal(new TextDecoder().decode(await openSealed(bob.xPrivateKey, bob.xPublicKey, box)), 'Einladung');
  assert.equal(await openSealed(eve.xPrivateKey, eve.xPublicKey, box), null);
  assert.equal(Buffer.from(box).includes(Buffer.from(bob.xPublicKey)), false);
  // Two boxes of the same message to the same person are unlinkable.
  const again = await sealTo(bob.xPublicKey, new TextEncoder().encode('Einladung'));
  assert.notDeepEqual(box.subarray(0, 32), again.subarray(0, 32));
});
