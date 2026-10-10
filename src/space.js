/**
 * SPACE - the root of every app and every piece of data. Two kinds:
 *
 * GROUP SPACE - a 32-byte secret plus key EPOCHS; everything else derived:
 *
 *   epoch 0 key  = HKDF(secret, "qu-lite/epoch/0")
 *   epoch n key  = random, distributed wrapped per member (rotate/acceptEpoch)
 *   write key(n) = Ed25519 from HKDF(epochKey(n), "qu-lite/write")
 *   sid          = SHA-256(writePub(0))[0..16]          opaque id on the wire
 *   shardKey     = HKDF(secret, "qu-lite/shard")        HMAC key for path shards
 *   tagKey       = HKDF(secret, "qu-lite/tag")          HMAC key for local index tags
 *
 * USER NODE - a space reachable by an identity's PUBKEY instead of a secret:
 *
 *   sid          = SHA-256("qu-lite/user" || identityPub)[0..16]
 *   write key    = the identity key itself - only its owner can write
 *   public recs  = signed, plaintext: anyone who knows the pubkey reads them
 *   private recs = AES key HKDF(identity.privateKey, "qu-lite/user-private"):
 *                  only the owner's devices read them
 *
 * Both sids are SELF-CERTIFYING: a mirror shown epoch 0's write public key
 * can check it against the sid and then verify every record's signatures
 * without any secret. Later epochs of a group are announced as GRANTS signed
 * with the previous epoch's write key (`grants()`).
 *
 * AUTHORS: records are signed by an AUTHOR key that is public on the wire
 * (envelope.js). By default it is a per-space ALIAS derived from the
 * identity's private key (`authorFor()`): every device of the identity gets
 * the same alias, nobody without the private key can link it to the
 * identity, and the aliases of one identity in two spaces are unlinkable.
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

/** @param {Uint8Array} writePub0 @returns {Promise<Uint8Array>} 16-byte sid of a group space. */
export async function sidOf(writePub0) {
  return (await QuCrypto.sha256(writePub0)).slice(0, 16);
}

/** @param {Uint8Array} identityPub @returns {Promise<Uint8Array>} 16-byte sid of that identity's user node. */
export async function userSidOf(identityPub) {
  const prefix = enc.encode('qu-lite/user');
  const data = new Uint8Array(prefix.length + identityPub.length);
  data.set(prefix, 0);
  data.set(identityPub, prefix.length);
  return (await QuCrypto.sha256(data)).slice(0, 16);
}

/** What a grant for `epoch` signs (with the write key of `epoch - 1`). */
export function grantMessage(sidHex, epoch, writePub) {
  const head = enc.encode(`qu-lite/grant\n${sidHex}\n${epoch}\n`);
  const out = new Uint8Array(head.length + writePub.length);
  out.set(head, 0);
  out.set(writePub, head.length);
  return out;
}

/**
 * Checks a list of grants against already-known write keys (`known`: epoch
 * -> writePub) and returns the newly verified ones, in epoch order.
 * @param {string} sidHex
 * @param {Array<{epoch: number, writePub: Uint8Array, sig: Uint8Array|null}>} grants
 * @param {Map<number, Uint8Array>} known
 * @returns {Promise<Map<number, Uint8Array>>}
 */
export async function verifyGrants(sidHex, grants, known) {
  const accepted = new Map();
  const keyFor = (epoch) => known.get(epoch) ?? accepted.get(epoch);
  for (const { epoch, writePub, sig } of [...grants].sort((a, b) => a.epoch - b.epoch)) {
    if (keyFor(epoch)) continue;
    if (epoch === 0) {
      const certified = QuCrypto.toHex(await sidOf(writePub)) === sidHex || QuCrypto.toHex(await userSidOf(writePub)) === sidHex;
      if (certified) accepted.set(0, writePub);
    } else if (sig && keyFor(epoch - 1) && (await QuCrypto.verify(grantMessage(sidHex, epoch, writePub), sig, keyFor(epoch - 1)))) {
      accepted.set(epoch, writePub);
    }
  }
  return accepted;
}

async function deriveEpoch(epochKey) {
  const seed = await hkdf(epochKey, 'qu-lite/write');
  const { publicKey, privateKeyPkcs8 } = await QuCrypto.keypairFromSeed('Ed25519', seed);
  const aesKey = await subtle.importKey('raw', epochKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key: epochKey, aesKey, writePub: publicKey, writePriv: privateKeyPkcs8 };
}

export class Space {
  /** @type {Map<number, {key: Uint8Array|null, aesKey: CryptoKey|null, writePub: Uint8Array, writePriv: Uint8Array|null}>} */
  #epochs = new Map();
  #shardKey;
  #tagKey;
  /** @type {Map<string, Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>>} */
  #authors = new Map();

  /** Use `Space.create()`/`Space.open()`/`Space.user()`. */
  constructor({ secret = null, sid, shardKey, tagKey, owner = null }) {
    /** @type {Uint8Array|null} Group secret (null for user nodes). */
    this.secret = secret;
    /** @type {Uint8Array} 16 bytes, what travels on the wire. */
    this.sid = sid;
    /** @type {string} hex of `sid` - storage keys, bus topics. */
    this.id = QuCrypto.toHex(sid);
    /** @type {Uint8Array|null} User nodes: the owning identity's Ed25519 pubkey. */
    this.owner = owner;
    /** @type {'group'|'user'} */
    this.kind = owner ? 'user' : 'group';
    this.#shardKey = shardKey;
    this.#tagKey = tagKey;
    /** @type {number} The epoch new records are sealed with. */
    this.epoch = 0;
  }

  /** @returns {Promise<Space>} A new group space with a random secret. */
  static async create() {
    return Space.open(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  }

  /** @param {Uint8Array} secret @returns {Promise<Space>} */
  static async open(secret) {
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('Space.open: secret must be 32 bytes');
    const epoch0 = await deriveEpoch(await hkdf(secret, 'qu-lite/epoch/0'));
    const space = new Space({ secret, sid: await sidOf(epoch0.writePub), shardKey: await hkdf(secret, 'qu-lite/shard'), tagKey: await hkdf(secret, 'qu-lite/tag') });
    space.#epochs.set(0, epoch0);
    return space;
  }

  /**
   * A user node, reachable by `identityPub`. Pass the matching `identity`
   * (with private keys) to get the OWNER's view - writable, private records
   * readable; without it you get the public view anyone has.
   * @param {Uint8Array} identityPub
   * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} [identity]
   * @returns {Promise<Space>}
   */
  static async user(identityPub, identity) {
    if (identity && QuCrypto.toHex(identity.publicKey) !== QuCrypto.toHex(identityPub)) throw new Error('Space.user: identity does not match pubkey');
    const space = new Space({
      sid: await userSidOf(identityPub),
      shardKey: await hkdf(identityPub, 'qu-lite/user-shard'),
      tagKey: await hkdf(identityPub, 'qu-lite/user-tag'),
      owner: identityPub,
    });
    const privateKey = identity ? await hkdf(identity.privateKey, 'qu-lite/user-private') : null;
    space.#epochs.set(0, {
      key: privateKey,
      aesKey: privateKey ? await subtle.importKey('raw', privateKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) : null,
      writePub: identityPub,
      writePriv: identity ? identity.privateKey : null,
    });
    return space;
  }

  /** @returns {string|null} A user node's human-facing id (owner pubkey hex), else null. */
  get ownerId() {
    return this.owner ? QuCrypto.toHex(this.owner) : null;
  }

  /** Can this view write (holds the current epoch's write key)? */
  get writable() {
    return Boolean(this.#epochs.get(this.epoch)?.writePriv);
  }

  /**
   * The key pair that signs this identity's records in this space - public
   * on the wire as the record's author.
   *   'alias' (default for groups): Ed25519 from HKDF(identity.privateKey,
   *            "qu-lite/alias/" + sid) - stable across the identity's
   *            devices, unlinkable to the identity and across spaces.
   *   'identity' (always for user nodes): the identity key itself.
   * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} identity
   * @param {'alias'|'identity'} [mode]
   * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
   */
  authorFor(identity, mode = this.kind === 'user' ? 'identity' : 'alias') {
    if (this.kind === 'user' || mode === 'identity') return Promise.resolve({ publicKey: identity.publicKey, privateKey: identity.privateKey });
    const cacheKey = QuCrypto.toHex(identity.publicKey);
    if (!this.#authors.has(cacheKey)) {
      this.#authors.set(
        cacheKey,
        hkdf(identity.privateKey, `qu-lite/alias/${this.id}`).then(async (seed) => {
          const { publicKey, privateKeyPkcs8 } = await QuCrypto.keypairFromSeed('Ed25519', seed);
          return { publicKey, privateKey: privateKeyPkcs8 };
        })
      );
    }
    return this.#authors.get(cacheKey);
  }

  /**
   * Opaque, deterministic tag for a path or key - what local indexes are
   * keyed by, so no path or field name is ever stored in clear.
   * @param {string} text
   * @returns {Promise<string>} 24 hex chars
   */
  async tag(text) {
    return QuCrypto.toHex((await hmac(this.#tagKey, enc.encode(text))).slice(0, 12));
  }

  /** @returns {Map<number, Uint8Array>} epoch -> write public key, for the keyring. */
  writeKeys() {
    return new Map([...this.#epochs].map(([epoch, keys]) => [epoch, keys.writePub]));
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
    if (this.kind === 'user') throw new Error('Space.rotate: a user node has no epochs to rotate');
    const epoch = Math.max(...this.#epochs.keys()) + 1;
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const { iv, ct, to } = await QuCrypto.encrypt(key, memberXPubs, by.xPrivateKey);
    this.#epochs.set(epoch, await deriveEpoch(key));
    this.epoch = epoch;
    return { epoch, from: by.xPublicKey, iv, ct, to };
  }

  /**
   * The write public keys a mirror needs to verify this space's records:
   * epoch 0 is self-certifying (its hash is the sid), every later epoch is
   * signed with the previous epoch's write key. Epochs whose predecessor
   * this member never had are left out - the mirror already has that link.
   * @returns {Promise<Array<{epoch: number, writePub: Uint8Array, sig: Uint8Array|null}>>}
   */
  async grants() {
    const out = [];
    for (const epoch of [...this.#epochs.keys()].sort((a, b) => a - b)) {
      const { writePub } = this.#epochs.get(epoch);
      if (epoch === 0) out.push({ epoch, writePub, sig: null });
      else if (this.#epochs.has(epoch - 1)) {
        const sig = await QuCrypto.sign(grantMessage(this.id, epoch, writePub), this.#epochs.get(epoch - 1).writePriv);
        out.push({ epoch, writePub, sig });
      }
    }
    return out;
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
