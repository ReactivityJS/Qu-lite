/**
 * SPACE - the root of every app and every piece of data. Three kinds:
 *
 * GROUP - a 32-byte secret, an OWNER and key EPOCHS:
 *
 *   ctx           = hex(SHA-256(secret))                 alias context (stable, secret)
 *   owner         = the founder's alias in this space    (set at creation)
 *   epoch 0 key   = HKDF(secret, "qu-lite/epoch/0")
 *   epoch n key   = random; distributed as anonymous sealed boxes (members.js)
 *   write key(n)  = Ed25519 from HKDF(epochKey(n), "qu-lite/write")
 *   sid           = SHA-256(writePub(0) || ownerPub)[0..16]
 *   shard/tag key = HKDF(secret, "qu-lite/shard" | "qu-lite/tag")
 *
 * USER NODE - reachable by an identity's pubkey, written only by its owner:
 *   sid = SHA-256("qu-lite/user" || identityPub)[0..16], write key = identity key,
 *   private records encrypted with HKDF(identity.privateKey, "qu-lite/user-private").
 *
 * INBOX - reachable by an identity's pubkey, writable by ANYONE (the write
 *   key is derived from the public key), records are public envelopes that
 *   carry anonymous sealed boxes to the owner's epub (inbox.js):
 *   sid = SHA-256("qu-lite/inbox" || identityPub)[0..16].
 *
 * GRANTS - what lets a peer that holds no secret (a mirror) verify records:
 *
 *   {epoch: 0, writePub, owner}         group: SHA-256(writePub || owner) = sid
 *   {epoch: 0, writePub}                user node: SHA-256("qu-lite/user" || writePub) = sid
 *   {epoch: 0, writePub, inboxOf}       inbox: sid from inboxOf, writePub derived from it
 *   {kind: 'admins', seq, admins, sig}  signed by the OWNER; highest seq wins
 *   {epoch: n, writePub, by, sig}       signed by the owner or a current admin
 *
 * Epochs are thus authorised by the owner/admins, not by "whoever had the
 * previous key": a removed member cannot announce (and so block) the next
 * epoch at a mirror.
 *
 * AUTHORS - records are signed by a per-space ALIAS (Ed25519 + X25519 for
 * key packages) derived from the identity's private key and the space's
 * ctx: identical on all of a person's devices, unlinkable to the identity
 * and across spaces. User nodes sign with the identity itself.
 */
import * as crypto from './crypto.js';

const enc = new TextEncoder();

const digestPrefix = async (label, ...parts) => (await crypto.sha256(crypto.concat(enc.encode(label), ...parts))).slice(0, 16);

/** @returns {Promise<Uint8Array>} 16-byte sid of a group space */
export const sidOf = async (writePub0, ownerPub) => (await crypto.sha256(crypto.concat(writePub0, ownerPub))).slice(0, 16);
/** @returns {Promise<Uint8Array>} 16-byte sid of an identity's user node */
export const userSidOf = (identityPub) => digestPrefix('qu-lite/user', identityPub);
/** @returns {Promise<Uint8Array>} 16-byte sid of an identity's inbox */
export const inboxSidOf = (identityPub) => digestPrefix('qu-lite/inbox', identityPub);

/** The (public!) write key pair of an identity's inbox. */
export const inboxWriteKey = async (identityPub) => crypto.keypairFromSeed('Ed25519', await crypto.hkdf(identityPub, 'qu-lite/inbox-write'));

/** Canonical bytes a grant signature covers. */
export function grantMessage(sidHex, grant) {
  if (grant.kind === 'admins') return crypto.concat(enc.encode(`qu-lite/grant\n${sidHex}\nadmins\n${grant.seq}\n`), ...grant.admins);
  return crypto.concat(enc.encode(`qu-lite/grant\n${sidHex}\nepoch\n${grant.epoch}\n`), grant.writePub);
}

/**
 * Grant state of one space as a verifier knows it.
 * @typedef {{owner: Uint8Array|null, admins: {seq: number, list: Uint8Array[]}, epochs: Map<number, Uint8Array>}} GrantState
 */
export const emptyGrantState = () => ({ owner: null, admins: { seq: -1, list: [] }, epochs: new Map() });

const same = (a, b) => a && b && crypto.toHex(a) === crypto.toHex(b);

/**
 * Verifies offered grants against what is already known and returns the
 * new, merged state plus what changed. Pure: does not mutate `state`.
 * Order inside the offer does not matter (epoch 0, then admins, then epochs).
 * @param {string} sidHex
 * @param {Array<object>} grants
 * @param {GrantState} state
 * @returns {Promise<{state: GrantState, changed: string[]}>}
 */
export async function verifyGrants(sidHex, grants, state) {
  const next = { owner: state.owner, admins: { ...state.admins, list: [...state.admins.list] }, epochs: new Map(state.epochs) };
  const changed = [];
  const list = Array.isArray(grants) ? grants : [];
  const bytes = (v) => v instanceof Uint8Array;

  for (const g of list.filter((g) => g?.epoch === 0 && bytes(g.writePub))) {
    if (next.epochs.has(0)) break;
    let ok = false;
    let owner = null;
    if (bytes(g.owner) && crypto.toHex(await sidOf(g.writePub, g.owner)) === sidHex) [ok, owner] = [true, g.owner];
    else if (bytes(g.inboxOf) && crypto.toHex(await inboxSidOf(g.inboxOf)) === sidHex && same((await inboxWriteKey(g.inboxOf)).publicKey, g.writePub)) ok = true;
    else if (crypto.toHex(await userSidOf(g.writePub)) === sidHex) [ok, owner] = [true, g.writePub];
    if (ok) {
      next.epochs.set(0, g.writePub);
      next.owner = owner;
      changed.push('epoch:0');
    }
  }
  for (const g of list.filter((g) => g?.kind === 'admins' && Array.isArray(g.admins) && g.admins.every(bytes)).sort((a, b) => a.seq - b.seq)) {
    if (!next.owner || !(g.seq > next.admins.seq) || !bytes(g.sig)) continue;
    if (await crypto.verify(grantMessage(sidHex, g), g.sig, next.owner)) {
      next.admins = { seq: g.seq, list: g.admins, sig: g.sig };
      changed.push(`admins:${g.seq}`);
    }
  }
  const authorised = (by) => same(by, next.owner) || next.admins.list.some((a) => same(a, by));
  for (const g of list.filter((g) => Number.isInteger(g?.epoch) && g.epoch > 0 && bytes(g.writePub)).sort((a, b) => a.epoch - b.epoch)) {
    if (next.epochs.has(g.epoch) || !bytes(g.by) || !bytes(g.sig) || !authorised(g.by)) continue;
    if (await crypto.verify(grantMessage(sidHex, g), g.sig, g.by)) {
      next.epochs.set(g.epoch, g.writePub);
      changed.push(`epoch:${g.epoch}`);
    }
  }
  return { state: next, changed };
}

async function deriveEpoch(epochKey) {
  const { publicKey, privateKey } = await crypto.keypairFromSeed('Ed25519', await crypto.hkdf(epochKey, 'qu-lite/write'));
  return { key: epochKey, aesKey: await crypto.aesKey(epochKey), writePub: publicKey, writePriv: privateKey };
}

export class Space {
  /** @type {Map<number, {key: Uint8Array|null, aesKey: CryptoKey|null, writePub: Uint8Array, writePriv: Uint8Array|null}>} */
  #epochs = new Map();
  /** @type {Map<number, {by: Uint8Array, sig: Uint8Array}>} signatures of epoch grants n > 0 */
  #epochSigs = new Map();
  /** @type {{seq: number, list: Uint8Array[], sig?: Uint8Array}} */
  #admins = { seq: -1, list: [] };
  #shardKey;
  #tagKey;
  #ctx;
  #inboxOf = null;
  /** @type {Map<string, Promise<object>>} */
  #aliases = new Map();

  /** Use `Space.create()` / `Space.open()` / `Space.user()` / `Space.inbox()`. */
  constructor({ kind, secret = null, sid, shardKey, tagKey, ctx = null, owner = null }) {
    /** @type {'group'|'user'|'inbox'} */
    this.kind = kind;
    /** @type {Uint8Array|null} group secret */
    this.secret = secret;
    /** @type {Uint8Array} 16 bytes on the wire */
    this.sid = sid;
    /** @type {string} hex sid - storage keys, bus topics */
    this.id = crypto.toHex(sid);
    /** @type {Uint8Array|null} group: founder's alias; user node: the identity */
    this.owner = owner;
    this.#shardKey = shardKey;
    this.#tagKey = tagKey;
    this.#ctx = ctx;
    /** @type {number} the epoch new records are sealed with */
    this.epoch = 0;
  }

  // ------------------------------------------------------------- factories
  /**
   * A new group; `identity` becomes its owner (through its alias).
   * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} [identity]
   */
  static async create(identity) {
    // Without a founder the owner is a throwaway identity: a group nobody can administer.
    identity = identity ?? (await crypto.generateIdentity());
    const secret = crypto.randomBytes(32);
    const ctx = crypto.toHex(await crypto.sha256(secret));
    const owner = (await aliasPair(identity, ctx)).publicKey;
    return Space.open(secret, { owner });
  }

  /**
   * @param {Uint8Array|{secret: Uint8Array, owner: Uint8Array}} secret - or an `invite` object
   * @param {{owner?: Uint8Array|string}} [options] - the owner's alias public key (from the invite)
   */
  static async open(secret, { owner } = {}) {
    if (secret && !(secret instanceof Uint8Array)) ({ secret, owner } = secret); // an invite object
    if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('Space.open: secret must be 32 bytes');
    const ownerPub = typeof owner === 'string' ? crypto.fromHex(owner) : owner;
    if (!(ownerPub instanceof Uint8Array) || ownerPub.length !== 32) throw new Error('Space.open: owner public key required');
    const epoch0 = await deriveEpoch(await crypto.hkdf(secret, 'qu-lite/epoch/0'));
    const space = new Space({
      kind: 'group',
      secret,
      sid: await sidOf(epoch0.writePub, ownerPub),
      shardKey: await crypto.hkdf(secret, 'qu-lite/shard'),
      tagKey: await crypto.hkdf(secret, 'qu-lite/tag'),
      ctx: crypto.toHex(await crypto.sha256(secret)),
      owner: ownerPub,
    });
    space.#epochs.set(0, epoch0);
    return space;
  }

  /**
   * A user node. With the matching `identity` you get the owner's view
   * (writable, private records readable); without it the public view.
   */
  static async user(identityPub, identity) {
    if (identity && crypto.toHex(identity.publicKey) !== crypto.toHex(identityPub)) throw new Error('Space.user: identity does not match pubkey');
    const space = new Space({
      kind: 'user',
      sid: await userSidOf(identityPub),
      shardKey: await crypto.hkdf(identityPub, 'qu-lite/user-shard'),
      tagKey: await crypto.hkdf(identityPub, 'qu-lite/user-tag'),
      owner: identityPub,
    });
    const privateKey = identity ? await crypto.hkdf(identity.privateKey, 'qu-lite/user-private') : null;
    space.#epochs.set(0, { key: privateKey, aesKey: privateKey ? await crypto.aesKey(privateKey) : null, writePub: identityPub, writePriv: identity?.privateKey ?? null });
    return space;
  }

  /** An identity's inbox: anyone can drop (public envelopes of sealed boxes), only the owner can open them. */
  static async inbox(identityPub) {
    const space = new Space({
      kind: 'inbox',
      sid: await inboxSidOf(identityPub),
      shardKey: await crypto.hkdf(identityPub, 'qu-lite/inbox-shard'),
      tagKey: await crypto.hkdf(identityPub, 'qu-lite/inbox-tag'),
    });
    space.#inboxOf = identityPub;
    const writer = await inboxWriteKey(identityPub);
    space.#epochs.set(0, { key: null, aesKey: null, writePub: writer.publicKey, writePriv: writer.privateKey });
    return space;
  }

  // ------------------------------------------------------------- identity
  /** What a new member needs to open this group: `Space.open(space.invite)`. */
  get invite() {
    return { secret: this.secret, owner: this.owner };
  }

  get ownerId() {
    return this.owner ? crypto.toHex(this.owner) : null;
  }

  get writable() {
    return Boolean(this.#epochs.get(this.epoch)?.writePriv);
  }

  /**
   * The key pair that signs this identity's records here: the per-space
   * alias for groups (and inboxes: a fresh one-time key per call), the
   * identity itself for its user node or with mode 'identity'.
   * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
   */
  async authorFor(identity, mode = 'alias') {
    if (this.kind === 'user' || mode === 'identity') return { publicKey: identity.publicKey, privateKey: identity.privateKey };
    if (this.kind === 'inbox') return crypto.keypairFromSeed('Ed25519', crypto.randomBytes(32));
    return (await this.#alias(identity)).ed;
  }

  /** The alias' X25519 key pair (receives epoch key packages). */
  async aliasX(identity) {
    return (await this.#alias(identity)).x;
  }

  #alias(identity) {
    const key = crypto.toHex(identity.publicKey);
    if (!this.#aliases.has(key)) this.#aliases.set(key, aliasPair(identity, this.#ctx, true));
    return this.#aliases.get(key);
  }

  // ------------------------------------------------------------- tags
  /** 8-byte opaque shard tag of a path's first segment. */
  async shardOf(path) {
    return (await crypto.hmac(this.#shardKey, enc.encode(path.split('/')[0]))).slice(0, 8);
  }

  /** Opaque local-index tag for a path or key (24 hex chars). */
  async tag(text) {
    return crypto.toHex((await crypto.hmac(this.#tagKey, enc.encode(text))).slice(0, 12));
  }

  // ------------------------------------------------------------- epochs
  hasEpoch(epoch) {
    return this.#epochs.has(epoch);
  }

  epochKeys(epoch) {
    const keys = this.#epochs.get(epoch);
    if (!keys) throw new Error(`Space ${this.id}: unknown epoch ${epoch}`);
    return keys;
  }

  /** @returns {Map<number, Uint8Array>} epoch -> write public key */
  writeKeys() {
    return new Map([...this.#epochs].map(([epoch, keys]) => [epoch, keys.writePub]));
  }

  /** @returns {number} the highest known epoch */
  get latestEpoch() {
    return Math.max(...this.#epochs.keys());
  }

  /**
   * Creates the next epoch (an admin's action): a fresh key and its grant,
   * signed by `admin` (the admin's alias key pair). Does NOT switch
   * `this.epoch` - the caller first publishes the key packages under the
   * old epoch, then calls `useEpoch()`.
   * @returns {Promise<{epoch: number, key: Uint8Array, grant: object}>}
   */
  async rotate(admin) {
    if (this.kind !== 'group') throw new Error('Space.rotate: only group spaces have epochs');
    const epoch = this.latestEpoch + 1;
    const key = crypto.randomBytes(32);
    const keys = await deriveEpoch(key);
    const grant = { epoch, writePub: keys.writePub, by: admin.publicKey };
    grant.sig = await crypto.sign(grantMessage(this.id, grant), admin.privateKey);
    this.#epochs.set(epoch, keys);
    this.#epochSigs.set(epoch, { by: grant.by, sig: grant.sig });
    return { epoch, key, grant };
  }

  /**
   * Adds an epoch learned from a key package. The grant must be valid for
   * the current owner/admins (checked here, like a mirror would).
   * @returns {Promise<boolean>} false if the grant does not verify
   */
  async addEpoch(grant, key) {
    if (this.#epochs.has(grant.epoch)) return true;
    const keys = await deriveEpoch(key);
    if (crypto.toHex(keys.writePub) !== crypto.toHex(grant.writePub)) return false;
    const { changed } = await verifyGrants(this.id, [grant], this.grantState());
    if (!changed.includes(`epoch:${grant.epoch}`)) return false;
    this.#epochs.set(grant.epoch, keys);
    this.#epochSigs.set(grant.epoch, { by: grant.by, sig: grant.sig });
    return true;
  }

  /** Switches sealing to `epoch` (default: the latest known). */
  useEpoch(epoch = this.latestEpoch) {
    this.epochKeys(epoch);
    this.epoch = epoch;
  }

  /**
   * Sets the admin list (owner only).
   * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} owner - the owner's alias key pair
   * @param {Uint8Array[]} admins
   */
  async setAdmins(owner, admins) {
    if (crypto.toHex(owner.publicKey) !== this.ownerId) throw new Error('Space.setAdmins: only the owner can set admins');
    const grant = { kind: 'admins', seq: this.#admins.seq + 1, admins };
    grant.sig = await crypto.sign(grantMessage(this.id, grant), owner.privateKey);
    this.#admins = { seq: grant.seq, list: admins, sig: grant.sig };
    return grant;
  }

  /** Adopts an admin grant someone else made (verified). */
  async addAdmins(grant) {
    const { state, changed } = await verifyGrants(this.id, [grant], this.grantState());
    if (changed.length) this.#admins = state.admins;
    return changed.length > 0;
  }

  /** @param {Uint8Array} pub @returns {boolean} owner or current admin */
  isAdmin(pub) {
    return same(pub, this.owner) || this.#admins.list.some((a) => same(a, pub));
  }

  /** @returns {GrantState} */
  grantState() {
    return { owner: this.owner, admins: this.#admins, epochs: this.writeKeys() };
  }

  /** Everything a mirror needs to verify this space's records. */
  async grants() {
    const out = [];
    const epoch0 = this.#epochs.get(0);
    if (this.kind === 'group') out.push({ epoch: 0, writePub: epoch0.writePub, owner: this.owner });
    else if (this.kind === 'inbox') out.push({ epoch: 0, writePub: epoch0.writePub, inboxOf: this.#inboxOf });
    else out.push({ epoch: 0, writePub: epoch0.writePub });
    if (this.#admins.sig) out.push({ kind: 'admins', seq: this.#admins.seq, admins: this.#admins.list, sig: this.#admins.sig });
    for (const [epoch, { by, sig }] of [...this.#epochSigs].sort((a, b) => a[0] - b[0])) out.push({ epoch, writePub: this.#epochs.get(epoch).writePub, by, sig });
    return out;
  }
}

/** Alias key pairs of `identity` in the space with context `ctx`. */
async function aliasPair(identity, ctx, withX = false) {
  const ed = await crypto.keypairFromSeed('Ed25519', await crypto.hkdf(identity.privateKey, `qu-lite/alias/${ctx}`));
  if (!withX) return ed;
  const x = await crypto.keypairFromSeed('X25519', await crypto.hkdf(identity.privateKey, `qu-lite/alias-x/${ctx}`));
  return { ed, x };
}
