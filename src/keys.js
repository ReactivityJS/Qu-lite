/**
 * SECURITY KEYS AND PASSKEYS - the identity unlocked by a YubiKey (USB, NFC)
 * or a passkey (Face ID, fingerprint, Windows Hello; synced by Apple or
 * Google), on every device that opens the same app address:
 *
 *   await qu.device.addKey({ name: 'YubiKey blau' })      // tap once (twice on some keys)
 *   const qu = await createClient({ url, unlock: 'key' })  // new device: tap -> same identity and groups
 *
 * HOW: WebAuthn's PRF extension (CTAP2 `hmac-secret`) makes the key return a
 * 32-byte secret that is fixed per key and app address and never leaves it
 * otherwise. Nothing is read out of the key; it signs nothing for Qu.
 *
 *   DEK   random 32 bytes                     encrypts the TRESOR (vault):
 *   data  AES-GCM(DEK, {identity, entries})   identity + this user's group keys (as in a backup)
 *   KEK   HKDF(prf secret | salt)             one per registered key
 *   wrap  AES-GCM(KEK, DEK)                   so every key opens the same tresor
 *
 * The tresor is kept on the device (`qu/vault`) and, for other devices, at
 * the relay under SHA-256(credential id) (vault-relay.js) - the relay holds
 * ciphertext only. Writes there are signed by the identity, so only its owner
 * replaces or deletes it. The tresor follows group changes (device.js).
 *
 * Unlocking needs no user name: the key is discoverable (resident), the
 * browser offers it, the credential id finds the tresor.
 */
import * as crypto from './crypto.js';
import { httpOrigin } from './net/http.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = 'qu-lite/identity-key/v1';
let prfInput = null;
/** The PRF input: fixed, so a new device can ask before it knows which key will answer. */
const prfFirst = async () => (prfInput ??= await crypto.sha256(enc.encode(INFO)));
export const b64url = (bytes) => crypto.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (text) => crypto.fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
const toJson = (value) => JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $u8: crypto.toBase64(v) } : v));
const fromJson = (text) => JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.$u8 === 'string' && Object.keys(v).length === 1 ? crypto.fromBase64(v.$u8) : v));
const coded = (message, code, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });

/** Where the relay keeps the tresor for one key: SHA-256 of the credential id. */
export const vaultHandle = async (credentialId) => crypto.toHex(await crypto.sha256(credentialId));
/** What the identity signs to write or delete a tresor at the relay. */
export const vaultMessage = (handle, digest, at) => enc.encode(`qu-lite/vault\n${handle}\n${digest}\n${at}`);

function fail(error) {
  if (error?.code) throw error;
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') throw coded('security key: cancelled or timed out', 'QU_KEY_CANCELLED', error);
  if (error?.name === 'InvalidStateError') throw coded('security key: this key is already registered here', 'QU_KEY_EXISTS', error);
  throw coded(`security key: ${error?.message ?? error}`, 'QU_KEY_FAILED', error);
}
const prfOf = (credential) => credential.getClientExtensionResults?.()?.prf;
const bytesOf = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

/**
 * Asks the key / passkey for its secret (one tap).
 * @param {{credentials?: object, allow?: Uint8Array[], rpId?: string, kind?: 'security-key'|'passkey', timeout?: number}} [options]
 * @returns {Promise<{id: Uint8Array, secret: Uint8Array}>}
 */
export async function keySecret({ credentials = globalThis.navigator?.credentials, allow, rpId, kind, timeout = 120_000 } = {}) {
  if (!credentials?.get) throw coded('security key: WebAuthn is not available here', 'QU_KEY_UNSUPPORTED');
  let assertion;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: crypto.randomBytes(32), // nothing checks the assertion: only the PRF secret is used
        ...(rpId ? { rpId } : {}),
        allowCredentials: (allow ?? []).map((id) => ({ type: 'public-key', id })),
        userVerification: 'preferred',
        timeout,
        ...(kind ? { hints: [kind === 'passkey' ? 'client-device' : 'security-key'] } : {}),
        extensions: { prf: { eval: { first: await prfFirst() } } },
      },
    });
  } catch (error) {
    fail(error);
  }
  const first = prfOf(assertion)?.results?.first;
  if (!first) throw coded('security key: this key or browser does not support the PRF extension (hmac-secret)', 'QU_KEY_UNSUPPORTED');
  return { id: bytesOf(assertion.rawId), secret: bytesOf(first) };
}

/**
 * Registers a new discoverable credential with PRF (one tap; a second one
 * when the authenticator gives no PRF result on creation).
 * @param {{credentials?: object, rpId?: string, rpName?: string, user?: string, kind?: 'security-key'|'passkey', timeout?: number}} [options]
 * @returns {Promise<{id: Uint8Array, secret: Uint8Array}>}
 */
export async function registerKey({ credentials = globalThis.navigator?.credentials, rpId, rpName, user = 'qu', kind, timeout = 120_000 } = {}) {
  if (!credentials?.create) throw coded('security key: WebAuthn is not available here', 'QU_KEY_UNSUPPORTED');
  let created;
  try {
    created = await credentials.create({
      publicKey: {
        rp: { name: rpName ?? globalThis.location?.hostname ?? 'qu', ...(rpId ? { id: rpId } : {}) },
        user: { id: crypto.randomBytes(16), name: user, displayName: user },
        challenge: crypto.randomBytes(32),
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })), // Ed25519, ES256, RS256
        authenticatorSelection: {
          residentKey: 'required', // unlock without a user name: the browser lists the key's credential
          requireResidentKey: true,
          userVerification: 'preferred',
          ...(kind === 'security-key' ? { authenticatorAttachment: 'cross-platform' } : kind === 'passkey' ? { authenticatorAttachment: 'platform' } : {}),
        },
        timeout,
        ...(kind ? { hints: [kind === 'passkey' ? 'client-device' : 'security-key'] } : {}),
        extensions: { prf: { eval: { first: await prfFirst() } } },
      },
    });
  } catch (error) {
    fail(error);
  }
  const prf = prfOf(created);
  if (prf?.enabled === false) throw coded('security key: this key or browser does not support the PRF extension (hmac-secret)', 'QU_KEY_UNSUPPORTED');
  const id = bytesOf(created.rawId);
  if (prf?.results?.first) return { id, secret: bytesOf(prf.results.first) };
  return keySecret({ credentials, allow: [id], rpId, kind, timeout }); // most security keys: PRF only on get
}

const kekOf = async (secret, salt) => crypto.aesKey(await crypto.hkdf(crypto.concat(secret, salt), INFO));

/**
 * The tresor: identity and group keys under a random DEK, the DEK wrapped once per key.
 * @returns {Promise<object>} JSON-safe
 */
export async function sealVault({ identity, entries }, dek, wraps) {
  const data = await crypto.aesEncrypt(await crypto.aesKey(dek), enc.encode(toJson({ identity, entries })), enc.encode(INFO));
  return { v: 1, pub: crypto.toHex(identity.publicKey), wraps, data: crypto.toBase64(data), at: Date.now() };
}

/** A wrap entry for one key: its id, a name, and the DEK under its KEK. */
export async function wrapFor(dek, { id, secret }, name = 'key') {
  const salt = crypto.randomBytes(16);
  const wrapped = await crypto.aesEncrypt(await kekOf(secret, salt), dek, enc.encode(INFO));
  return { id: b64url(id), name: String(name).slice(0, 64), salt: crypto.toBase64(salt), key: crypto.toBase64(wrapped), created: Date.now() };
}

/**
 * Opens a tresor with a key's secret.
 * @returns {Promise<{identity: object, entries: Array<[string, *]>, dek: Uint8Array}>}
 */
export async function openVault(vault, { id, secret }) {
  const wrap = vault?.wraps?.find((w) => w.id === b64url(id));
  if (!wrap) throw coded('security key: this key is not registered for this identity', 'QU_KEY_UNKNOWN');
  let dek, plain;
  try {
    dek = await crypto.aesDecrypt(await kekOf(secret, crypto.fromBase64(wrap.salt)), crypto.fromBase64(wrap.key), enc.encode(INFO));
    plain = await crypto.aesDecrypt(await crypto.aesKey(dek), crypto.fromBase64(vault.data), enc.encode(INFO));
  } catch (error) {
    throw coded('security key: the tresor does not open with this key (damaged?)', 'QU_KEY_FAILED', error);
  }
  const { identity, entries } = fromJson(dec.decode(plain));
  if (crypto.toHex(identity.publicKey) !== vault.pub) throw coded('security key: tresor and identity do not match', 'QU_KEY_FAILED');
  return { identity, entries: entries ?? [], dek };
}

/** Relay HTTP: fetch / store / delete the tresor of one key. */
export function vaultClient(relay, { fetch: fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const base = `${httpOrigin(relay)}/id/`;
  return {
    async get(credentialId) {
      const res = await fetchImpl(base + (await vaultHandle(credentialId)));
      if (res.status === 404) return null;
      if (!res.ok) throw coded(`security key: relay answered ${res.status}`, 'QU_KEY_FAILED');
      return (await res.json()).vault;
    },
    /** Writes (or with `vault: null` deletes) the tresor under one key's handle, signed by the identity. */
    async put(credentialId, vault, identity) {
      const handle = await vaultHandle(credentialId);
      const body = vault ? JSON.stringify(vault) : '';
      const digest = crypto.toHex(await crypto.sha256(enc.encode(body)));
      const at = Date.now();
      const sig = crypto.toBase64(await crypto.sign(vaultMessage(handle, digest, at), identity.privateKey));
      const res = await fetchImpl(base + handle, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault: vault ?? null, pub: crypto.toHex(identity.publicKey), at, sig }) });
      if (!res.ok) throw coded(`security key: relay refused the tresor (${res.status} ${await res.text().catch(() => '')})`.trim(), 'QU_KEY_FAILED');
    },
  };
}

// --- on a device (device.js delegates here, so clients that never use a key never load this) ---

const PLAIN_KEY = 'qu/identity';
const LOCKED_KEY = 'qu/identity-locked';
const VAULT_KEY = 'qu/vault';
const DEK_KEY = 'qu/vault-dek';
const VAULT_LOCK = 'qu/vault-lock';
const DEVICE_KEYS = ['members/groups/', 'members/keys/'];
/** DEKs of tresors opened this session where none may be stored (key lock, passphrase lock). */
const openDeks = new WeakMap();

async function deviceEntries(store) {
  const entries = [];
  for (const prefix of DEVICE_KEYS) for (const key of await store.keys(prefix)) entries.push([key, await store.get(key)]);
  return entries;
}

/**
 * device.js `unlockWithKey` for a store without a plain identity.
 * @param {object} store
 * @param {{relay?: string, credentials?: object, rpId?: string, kind?: 'security-key'|'passkey', remember?: boolean, fetch?: typeof fetch}} [options]
 */
export async function unlockStore(store, { relay, credentials, rpId, kind, remember, fetch } = {}) {
  const local = await store.get(VAULT_KEY);
  if (!local && (await store.get(LOCKED_KEY))) throw coded('identity is locked with a passphrase on this device', 'QU_LOCKED');
  const key = await keySecret({ credentials, rpId, kind, allow: local?.wraps.map((w) => unb64url(w.id)) });
  let vault = local?.wraps.some((w) => w.id === b64url(key.id)) ? local : null;
  if (!vault) {
    if (!relay) throw coded('security key: no relay to fetch the tresor from', 'QU_KEY_UNKNOWN');
    vault = await vaultClient(relay, { fetch }).get(key.id);
    if (!vault) throw coded('security key: no identity is registered for this key (at this address)', 'QU_KEY_UNKNOWN');
  }
  const { identity, entries, dek } = await openVault(vault, key);
  if (!local) {
    // a new device: everything the tresor carries
    if ((await store.keys('members/groups/')).length) throw new Error('unlock: this storage already has groups of another identity - use another database name');
    for (const [k, value] of entries) if (DEVICE_KEYS.some((p) => k.startsWith(p))) await store.set(k, value);
    await store.set(VAULT_KEY, vault);
  }
  if (remember ?? !(await store.get(VAULT_LOCK))) {
    await store.set(PLAIN_KEY, identity);
    await store.set(DEK_KEY, dek);
    await store.remove(VAULT_LOCK);
  } else {
    openDeks.set(store, dek);
    await store.set(VAULT_LOCK, true);
  }
  return identity;
}

/**
 * The tresor of a running peer: register and remove keys, keep the tresor in
 * step with the group keys, keep the relay's copies current.
 * @param {object} qu
 * @param {{credentials?: object, rpId?: string, fetch?: typeof fetch, delayMs?: number, relay: () => string|null}} options
 */
export function vaultManager(qu, { credentials, rpId, fetch, delayMs = 1000, relay }) {
  const storage = qu.storage;
  const root = qu.root ?? storage;
  const dekOf = async () => (await storage.get(DEK_KEY)) ?? openDeks.get(root) ?? openDeks.get(storage) ?? null;
  let timer = null;
  let dirty = false;

  async function upload(vault, removed = []) {
    const url = relay();
    if (!url) {
      dirty = true;
      return false;
    }
    try {
      const client = vaultClient(url, { fetch });
      for (const w of vault?.wraps ?? []) await client.put(unb64url(w.id), vault, qu.identity);
      for (const id of removed) await client.put(unb64url(id), null, qu.identity);
      dirty = false;
      await qu.bus.notify('qu.device.vault', { synced: true, keys: vault?.wraps.length ?? 0 });
      return true;
    } catch (error) {
      dirty = true;
      await qu.bus.notify('qu.device.vault', { synced: false, reason: error.message });
      return false;
    }
  }
  /** Seals the tresor anew (identity + current group keys) and sends it under every key. */
  async function refresh() {
    const dek = await dekOf();
    const current = await storage.get(VAULT_KEY);
    if (!dek || !current) return false;
    const vault = await sealVault({ identity: qu.identity, entries: await deviceEntries(storage) }, dek, current.wraps);
    await storage.set(VAULT_KEY, vault);
    return upload(vault);
  }
  function schedule() {
    if (timer || qu.closed) return;
    timer = setTimeout(() => {
      timer = null;
      refresh().catch((error) => qu.bus.error(error, 'device.vault'));
    }, delayMs);
    timer.unref?.();
  }

  return {
    schedule,
    /** after a reconnect: send what could not be sent */
    retry: () => dirty && schedule(),
    close: () => clearTimeout(timer),

    /** @param {{name?: string, kind?: 'security-key'|'passkey', lock?: boolean, rpName?: string}} [options] */
    async addKey({ name = 'key', kind, lock = false, rpName } = {}) {
      const key = await registerKey({ credentials, rpId, rpName, user: name, kind });
      const current = await storage.get(VAULT_KEY);
      let dek = current ? await dekOf() : null;
      if (current && !dek) throw new Error("addKey: the tresor is not open on this device - start with unlock: 'key' first");
      dek ??= crypto.randomBytes(32);
      const wraps = [...(current?.wraps ?? []).filter((w) => w.id !== b64url(key.id)), await wrapFor(dek, key, name)];
      const vault = await sealVault({ identity: qu.identity, entries: await deviceEntries(storage) }, dek, wraps);
      await openVault(vault, key); // opens with the new key, before anything relies on it
      await storage.set(VAULT_KEY, vault);
      const plain = Boolean(await storage.get(PLAIN_KEY));
      if (lock) {
        openDeks.set(root, dek);
        await storage.set(VAULT_LOCK, true);
        await storage.remove(DEK_KEY);
        await storage.remove(PLAIN_KEY);
      } else if (plain) await storage.set(DEK_KEY, dek); // no weaker than the plain identity next to it
      else openDeks.set(root, dek); // passphrase lock: the DEK stays in memory only
      const synced = await upload(vault);
      await qu.bus.notify('qu.device.keys', { added: b64url(key.id), keys: wraps.length });
      return { id: b64url(key.id), synced };
    },

    async removeKey(id) {
      const current = await storage.get(VAULT_KEY);
      if (!current?.wraps.some((w) => w.id === id)) return;
      const wraps = current.wraps.filter((w) => w.id !== id);
      if (!wraps.length) {
        if (await storage.get(VAULT_LOCK)) await storage.set(PLAIN_KEY, qu.identity);
        for (const k of [VAULT_KEY, DEK_KEY, VAULT_LOCK]) await storage.remove(k);
        await upload(null, [id]);
      } else {
        // The DEK stays (re-wrapping it would need a tap on every remaining key). The removed
        // key loses its wrap and its copy at the relay; what someone already opened with it
        // cannot be taken back - a lost key without PIN means: treat the identity as exposed.
        const dek = await dekOf();
        if (!dek) throw new Error('removeKey: the tresor is not open on this device');
        const vault = await sealVault({ identity: qu.identity, entries: await deviceEntries(storage) }, dek, wraps);
        await storage.set(VAULT_KEY, vault);
        await upload(vault, [id]);
      }
      await qu.bus.notify('qu.device.keys', { removed: id, keys: wraps.length });
    },
  };
}
