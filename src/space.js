/**
 * SPACE - the root of every app and every piece of data. A Space is a
 * 32-byte secret plus a set of key EPOCHS; everything else is derived:
 *
 *   sid          = HKDF(secret, "qu-lite/sid")[0..16]   opaque id on the wire
 *   shardKey     = HKDF(secret, "qu-lite/shard")        HMAC key for path shards
 *   epoch 0 key  = HKDF(secret, "qu-lite/epoch/0")
 *   epoch n key  = random, distributed wrapped per member (rotate/acceptEpoch)
 *   write key(n) = Ed25519 from HKDF(epochKey(n), "qu-lite/write")
 *
 * The write key signs the OUTER envelope (envelope.js): it proves "a holder
 * of this epoch's key", never WHO - authorship is signed INSIDE the
 * ciphertext. Rotating the epoch (dropping a member) therefore revokes both
 * reading and writing of new records for whoever didn't get the new key.
 *
 * A USER is a Space too: `Space.forUser(identity)` derives its secret from
 * the identity's private key (only that identity can open it) and carries
 * `owner = publicKey`, so its human-facing id is the pubkey, not a uuid.
 */
import { QuCrypto } from '@qu/core';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

/** @param {Uint8Array} ikm @param {string} info @param {number} [length] @returns {Promise<Uint8Array>} */
export async function hkdf(ikm, info, length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, key, length * 8);
  return new Uint8Array(bits);
}

/** @param {Uint8Array} keyBytes @param {Uint8Array} data @returns {Promise<Uint8Array>} */
export async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}

async function deriveEpoch(epochKey) {
  const seed = await hkdf(epochKey, 'qu-lite/write');
  const { publicKey, privateKeyPkcs8 } = await QuCrypto.keypairFromSeed('Ed25519', seed);
  const aesKey = await subtle.importKey('raw', epochKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key: epochKey, aesKey, writePub: publicKey, writePriv: privateKeyPkcs8 };
}

export class Space {
  /** @type {Map<number, {key: Uint8Array, aesKey: CryptoKey, writePub: Uint8Array, writePriv: Uint8Array}>} */
  #epochs = new Map();
  #shardKey;

  /** Use `Space.create()`/`Space.open()`/`Space.forUser()`. */
  constructor(secret, sid, shardKey, owner) {
    this.secret = secret;
    /** @type {Uint8Array} 16 bytes, what travels on the wire. */
    this.sid = sid;
    /** @type {string} hex of `sid` - storage keys, bus topics. */
    this.id = QuCrypto.toHex(sid);
    /** @type {Uint8Array|null} Set for user spaces: the owning identity's Ed25519 pubkey. */
    this.owner = owner ?? null;
    this.#shardKey = shardKey;
    /** @type {number} The epoch new records are sealed with. */
    this.epoch = 0;
  }

  /** @param {{owner?: Uint8Array}} [options] @returns {Promise<Space>} */
  static async create(options = {}) {
    return Space.open(globalThis.crypto.getRandomValues(new Uint8Array(32)), options);
  }

  /** @param {Uint8Array} secret @param {{owner?: Uint8Array}} [options] @returns {Promise<Space>} */
  static async open(secret, { owner } = {}) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('Space.open: secret must be 32 bytes');
    const space = new Space(secret, await hkdf(secret, 'qu-lite/sid', 16), await hkdf(secret, 'qu-lite/shard'), owner);
    space.#epochs.set(0, await deriveEpoch(await hkdf(secret, 'qu-lite/epoch/0')));
    return space;
  }

  /**
   * The identity's own space: secret derived from its private key, so every
   * device holding the identity opens the same space and nobody else can.
   * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} identity
   * @returns {Promise<Space>}
   */
  static async forUser(identity) {
    const secret = await hkdf(identity.privateKey, 'qu-lite/user-space');
    return Space.open(secret, { owner: identity.publicKey });
  }

  /** @returns {string|null} The user space's human-facing id (owner pubkey hex), else null. */
  get ownerId() {
    return this.owner ? QuCrypto.toHex(this.owner) : null;
  }

  /** @param {number} epoch */
  hasEpoch(epoch) {
    return this.#epochs.has(epoch);
  }

  /** @param {number} epoch */
  epochKeys(epoch) {
    const keys = this.#epochs.get(epoch);
    if (!keys) throw new Error(`Space ${this.id}: unknown epoch ${epoch}`);
    return keys;
  }

  /**
   * 8-byte opaque shard tag for a path: HMAC over its FIRST segment
   * (`chat/general` -> `chat`), so a mirror can serve "only the chat part"
   * without ever learning the word "chat".
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  async shardOf(path) {
    return (await hmac(this.#shardKey, enc.encode(path.split('/')[0]))).slice(0, 8);
  }

  /**
   * Starts a new epoch with a fresh random key and wraps it for exactly
   * `memberXPubs` - whoever is left out can neither read nor (outer-)sign
   * anything sealed from now on. The returned object is meant to be stored
   * as an ordinary record (`_keys`) so members pick it up via sync.
   * @param {Uint8Array[]} memberXPubs
   * @param {{xPublicKey: Uint8Array, xPrivateKey: Uint8Array}} by
   * @returns {Promise<{epoch: number, from: Uint8Array, iv: Uint8Array, ct: Uint8Array, to: Array<{pub: Uint8Array, key: Uint8Array}>}>}
   */
  async rotate(memberXPubs, by) {
    const epoch = Math.max(...this.#epochs.keys()) + 1;
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const { iv, ct, to } = await QuCrypto.encrypt(key, memberXPubs, by.xPrivateKey);
    this.#epochs.set(epoch, await deriveEpoch(key));
    this.epoch = epoch;
    return { epoch, from: by.xPublicKey, iv, ct, to };
  }

  /**
   * Unwraps an epoch produced by `rotate()`. Throws if `identity` wasn't a recipient.
   * @param {{epoch: number, from: Uint8Array, iv: Uint8Array, ct: Uint8Array, to: Array<{pub: Uint8Array, key: Uint8Array}>}} wrapped
   * @param {{xPublicKey: Uint8Array, xPrivateKey: Uint8Array}} identity
   */
  async acceptEpoch(wrapped, identity) {
    const mine = QuCrypto.toHex(identity.xPublicKey);
    const entry = wrapped.to.find((t) => QuCrypto.toHex(t.pub) === mine);
    if (!entry) throw new Error(`Space ${this.id}: not a recipient of epoch ${wrapped.epoch}`);
    const key = await QuCrypto.decrypt(wrapped.iv, wrapped.ct, entry.key, wrapped.from, identity.xPrivateKey);
    this.#epochs.set(wrapped.epoch, await deriveEpoch(key));
    if (wrapped.epoch > this.epoch) this.epoch = wrapped.epoch;
  }
}
