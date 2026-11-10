/**
 * DEVICE - what keeps a user's access alive beyond this one browser profile:
 * an encrypted device backup and the browser's persistent-storage grant.
 *
 * Everything that is ONLY on this device is small: the identity
 * (`qu/identity`), how to reopen each group (`members/groups/<sid>`) and the
 * epoch keys this device holds (`members/keys/<sid>/<epoch>`). Everything
 * else - records, profiles, member lists - is on the relay and comes back
 * by sync. So a backup of those keys restores a user completely on a new
 * device: `createClient({ restore: {backup, passphrase} })`, then
 * `qu.restoreGroups()` as after every reload.
 *
 *   qu.use(device())
 *   const text = await qu.device.exportBackup('correct horse battery staple');
 *   await qu.device.downloadBackup(passphrase)       // browser: saves qu-backup.txt
 *   await qu.device.status()   // {persisted, usage, quota, backupAt, groups}
 *   await qu.device.persist()  // asks the browser not to evict this origin's storage
 *
 * Backup format (a single line of text, safe to paste or save):
 *   `qu-backup.` + base64url(JSON {h: header, d: sealed})
 *   header = JSON {v: 1, kdf: 'PBKDF2-SHA256', iterations, salt}
 *   sealed = AES-256-GCM(key, payload, additionalData = header) - iv first
 *   key    = PBKDF2-SHA256(passphrase, salt, iterations) (600 000 by default)
 * A wrong passphrase and a damaged backup fail the same way (GCM tag).
 * The header is authenticated, so iterations cannot be lowered unnoticed.
 *
 * IDENTITY LOCK (optional): `createClient({ passphrase })` keeps the
 * identity only encrypted in storage (`qu/identity-locked`, the backup
 * format with no group entries) - a copied disk, browser profile or
 * database file no longer contains usable keys. Every start then needs the
 * passphrase: without it the start fails with `error.code === 'QU_LOCKED'`,
 * with a wrong one `'QU_WRONG_PASSPHRASE'` - the app shows an unlock dialog
 * and calls createClient again. An existing unlocked identity is locked on
 * the first start with a passphrase (the plain copy is removed only after
 * the sealed one was read back). At runtime: `qu.device.lock(passphrase)`,
 * `changePassphrase(old, new)`, `removeLock(passphrase)`. While the app
 * runs the keys are in memory, as always - the lock protects data at rest,
 * not a compromised page.
 *
 * SECURITY KEYS / PASSKEYS (keys.js): `addKey()` puts identity and group
 * keys into a tresor that a YubiKey (USB, NFC) or a passkey opens; the
 * relay keeps a copy for other devices. A new device starts with
 * `createClient({ url, unlock: 'key' })` - one tap, same identity, then
 * `restoreGroups()`. `addKey({ lock: true })` keeps no usable identity on
 * this device: every start needs the key (`error.code` 'QU_LOCKED' without
 * `unlock`). Local records: `qu/vault` (the tresor), `qu/vault-dek` (its key,
 * only where the identity is stored plain anyway), `qu/vault-lock`.
 *
 * Why the browser grant matters: without `navigator.storage.persist()` a
 * browser may evict the origin's IndexedDB under storage pressure - and with
 * it the identity. Requesting it can show a prompt (Firefox), so it is up to
 * the app when: `createClient({ persist: true })` asks at start,
 * `qu.device.persist()` whenever the app chooses (e.g. after the first group).
 */
import * as crypto from './crypto.js';
/** Security-key code (keys.js) loads only when a key is used - not with every client. */
const keysJs = () => import('./keys.js');

const PREFIX = 'qu-backup.';
const PLAIN_KEY = 'qu/identity';
const LOCKED_KEY = 'qu/identity-locked';
const VAULT_KEY = 'qu/vault';
const VAULT_LOCK = 'qu/vault-lock';
/** Keys that exist only on this device and make up a backup. */
const DEVICE_KEYS = ['members/groups/', 'members/keys/'];
export const BACKUP_ITERATIONS = 600_000;
const MIN_PASSPHRASE = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (bytes) => crypto.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text) => crypto.fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));

/** JSON with Uint8Array support ({"$u8": base64}). */
const toJson = (value) => JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $u8: crypto.toBase64(v) } : v));
const fromJson = (text) => JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof v.$u8 === 'string' && Object.keys(v).length === 1 ? crypto.fromBase64(v.$u8) : v));

async function keyFrom(passphrase, salt, iterations) {
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return crypto.aesKey(new Uint8Array(bits));
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE) {
    throw new Error(`backup: the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  }
}

/**
 * Seals `{identity, entries}` with a passphrase.
 * @param {{identity: object, entries: Array<[string, *]>}} payload
 * @param {string} passphrase
 * @param {{iterations?: number}} [options]
 * @returns {Promise<string>}
 */
export async function sealBackup(payload, passphrase, { iterations = BACKUP_ITERATIONS } = {}) {
  checkPassphrase(passphrase);
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('backup: bad iteration count');
  const salt = crypto.randomBytes(16);
  const header = JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: crypto.toBase64(salt) });
  const sealed = await crypto.aesEncrypt(await keyFrom(passphrase, salt, iterations), enc.encode(toJson({ ...payload, created: Date.now() })), enc.encode(header));
  return PREFIX + b64url(enc.encode(JSON.stringify({ h: header, d: crypto.toBase64(sealed) })));
}

/**
 * Opens a backup.
 * @param {string} text - as produced by `exportBackup()` (surrounding whitespace is ignored)
 * @param {string} passphrase
 * @returns {Promise<{identity: object, entries: Array<[string, *]>, created: number}>}
 * @throws {Error} 'backup: wrong passphrase or damaged backup' - deliberately the same for both
 */
export async function readBackup(text, passphrase) {
  const fail = () => {
    throw new Error('backup: wrong passphrase or damaged backup');
  };
  if (typeof text !== 'string' || !text.trim().startsWith(PREFIX)) throw new Error('backup: not a qu-lite backup');
  let outer, header;
  try {
    outer = JSON.parse(dec.decode(unb64url(text.trim().slice(PREFIX.length))));
    header = JSON.parse(outer.h);
  } catch {
    return fail();
  }
  if (header?.v !== 1 || header.kdf !== 'PBKDF2-SHA256') throw new Error(`backup: unsupported format (${header?.v}/${header?.kdf})`);
  if (!Number.isInteger(header.iterations) || header.iterations < 1 || header.iterations > 10_000_000) return fail();
  let plain;
  try {
    const key = await keyFrom(String(passphrase ?? ''), crypto.fromBase64(header.salt), header.iterations);
    plain = await crypto.aesDecrypt(key, crypto.fromBase64(outer.d), enc.encode(outer.h));
  } catch {
    return fail();
  }
  const payload = fromJson(dec.decode(plain));
  const id = payload?.identity;
  if (!(id?.publicKey instanceof Uint8Array && id.privateKey instanceof Uint8Array && id.xPublicKey instanceof Uint8Array && id.xPrivateKey instanceof Uint8Array)) return fail();
  if (!Array.isArray(payload.entries) || !payload.entries.every(([k]) => typeof k === 'string' && DEVICE_KEYS.some((p) => k.startsWith(p)))) return fail();
  return payload;
}

const sameIdentity = (a, b) => Boolean(a && b) && crypto.toHex(a.publicKey) === crypto.toHex(b.publicKey);

const coded = (message, code) => Object.assign(new Error(message), { code });

/** Opens the locked identity. @throws QU_LOCKED (no passphrase) / QU_WRONG_PASSPHRASE */
async function openLocked(sealed, passphrase) {
  if (passphrase == null) throw coded('identity is locked: start with the passphrase', 'QU_LOCKED');
  try {
    return (await readBackup(sealed, passphrase)).identity;
  } catch {
    throw coded('identity is locked: wrong passphrase', 'QU_WRONG_PASSPHRASE');
  }
}

/** Stores `identity` locked, verified by reading it back, then removes any plain copy. */
async function lockStored(store, identity, passphrase, iterations = BACKUP_ITERATIONS) {
  const sealed = await sealBackup({ identity, entries: [] }, passphrase, { iterations });
  await store.set(LOCKED_KEY, sealed);
  const back = await readBackup(await store.get(LOCKED_KEY), passphrase);
  if (!sameIdentity(back.identity, identity)) throw new Error('identity lock: the sealed copy did not read back - nothing removed');
  await store.remove(PLAIN_KEY);
}

/**
 * The identity of a store, honouring the optional lock (createPeer uses it):
 * locked -> needs `passphrase`; plain + `passphrase` -> locked now; empty ->
 * a new identity, stored locked if a passphrase is given.
 * @param {object} store - a driver
 * @param {{passphrase?: string, generate?: () => Promise<object>}} [options]
 */
export async function loadIdentity(store, { passphrase, generate = crypto.generateIdentity } = {}) {
  const plain = await store.get(PLAIN_KEY);
  const sealed = await store.get(LOCKED_KEY);
  if (sealed) {
    const identity = await openLocked(sealed, passphrase);
    if (plain) {
      // a lock or a restore that stopped half-way
      if (!sameIdentity(plain, identity)) throw new Error('identity: this storage holds two different identities (locked and plain) - restore with force');
      await store.remove(PLAIN_KEY);
    }
    return identity;
  }
  if (plain) {
    if (passphrase != null) await lockStored(store, plain, passphrase);
    return plain;
  }
  const identity = await generate();
  if (passphrase != null) await lockStored(store, identity, passphrase);
  else await store.set(PLAIN_KEY, identity);
  return identity;
}

/**
 * Writes a backup into a store before a peer is built on it (createPeer's `restore`).
 * A store that already belongs to ANOTHER identity is refused if that identity has
 * groups here (their keys would be lost) - unless `force`.
 * @param {object} store - a driver (get/set/remove/keys)
 * @param {{backup: string, passphrase: string, force?: boolean, lockPassphrase?: string}} options
 * @returns {Promise<{identity: object, groups: number, replaced: boolean}>}
 */
export async function restoreInto(store, { backup, passphrase, force = false, lockPassphrase }) {
  const payload = await readBackup(backup, passphrase);
  let current = await store.get(PLAIN_KEY);
  const sealed = await store.get(LOCKED_KEY);
  if (sealed) {
    // a locked storage: only its passphrase tells whose it is
    current = await openLocked(sealed, lockPassphrase).catch(() => null);
    if (!current && !force) throw new Error('restore: this storage is locked by another passphrase - start with that passphrase, use another database name, or force: true');
    if (!current || !sameIdentity(current, payload.identity)) await store.remove(LOCKED_KEY);
  }
  let replaced = false;
  if (current && !sameIdentity(current, payload.identity)) {
    const groups = (await store.keys('members/groups/')).length;
    if (groups && !force) {
      throw new Error(`restore: this storage belongs to another identity with ${groups} group(s) - use another database name, or force: true to drop them`);
    }
    for (const prefix of DEVICE_KEYS) for (const key of await store.keys(prefix)) await store.remove(key);
    replaced = true;
  }
  if (!sealed || !current || !sameIdentity(current, payload.identity)) await store.set(PLAIN_KEY, payload.identity);
  for (const [key, value] of payload.entries) await store.set(key, value);
  return { identity: payload.identity, groups: payload.entries.filter(([k]) => k.startsWith('members/groups/')).length, replaced };
}

/**
 * Unlocks with a security key or passkey before a peer is built (createPeer's
 * `unlock`; keys.js `unlockStore`, loaded only now).
 * - identity stored plain here: nothing to do (returns null)
 * - tresor here (key lock): one tap opens it locally
 * - nothing here: one tap, the tresor comes from the relay; identity and groups are written
 * @param {object} store - a driver
 * @param {{relay?: string, credentials?: object, rpId?: string, kind?: 'security-key'|'passkey', remember?: boolean, fetch?: typeof fetch}} [options]
 *   `remember` (new device): keep the identity usable on this device (default true; false: every start taps).
 * @returns {Promise<object|null>} the identity, or null if the store holds a plain one
 * @throws QU_KEY_CANCELLED, QU_KEY_UNSUPPORTED, QU_KEY_UNKNOWN (no tresor for this key), QU_LOCKED (passphrase lock, no tresor)
 */
export async function unlockWithKey(store, options = {}) {
  if (await store.get(PLAIN_KEY)) return null;
  return (await keysJs()).unlockStore(store, options);
}

/** True if this storage needs a key to start (createPeer asks before it would create a new identity). */
export async function needsKey(store) {
  return !(await store.get(PLAIN_KEY)) && !(await store.get(LOCKED_KEY)) && Boolean(await store.get(VAULT_KEY));
}

/**
 * @param {{iterations?: number, navigator?: object, credentials?: object, relay?: string, rpId?: string, fetch?: typeof fetch, vaultDelayMs?: number}} [options]
 *   `iterations` for exports (default 600 000); `credentials`/`rpId` for security keys (tests inject them);
 *   `relay`: where tresors go (default: the relay transport's url).
 */
export function device({ iterations = BACKUP_ITERATIONS, navigator: nav = globalThis.navigator, credentials, relay, rpId, fetch, vaultDelayMs = 1000 } = {}) {
  const plugin = (qu) => {
    const storage = qu.storage;

    // --- the tresor (security keys / passkeys): keys.js, loaded on first use ---
    let lastRelay = relay ?? null;
    let manager = null;
    const vault = () =>
      (manager ??= keysJs().then(({ vaultManager }) =>
        vaultManager(qu, { credentials, rpId, fetch, delayMs: vaultDelayMs, relay: () => relay ?? qu.transports?.relay?.urls?.[0] ?? lastRelay }),
      ));
    qu.bus.on('net.peer.up', () => {
      lastRelay = relay ?? qu.transports?.relay?.urls?.[0] ?? lastRelay;
      manager?.then((m) => m.retry());
    });
    // the tresor follows new groups and epochs, so a key opens everything on the next device
    const offWrites = storage.afterWrite?.('members/', (keys) => {
      if (keys.some((k) => DEVICE_KEYS.some((p) => k.startsWith(p)))) storage.get(VAULT_KEY).then((v) => v && vault().then((m) => m.schedule()));
    });
    qu.onClose?.(() => {
      offWrites?.();
      manager?.then((m) => m.close());
    });

    const api = {
      /** @returns {Promise<string>} the encrypted backup of this device's keys */
      async exportBackup(passphrase) {
        const entries = [];
        for (const prefix of DEVICE_KEYS) for (const { key, value } of await storage.range(prefix)) entries.push([key, value]);
        const text = await sealBackup({ identity: qu.identity, entries }, passphrase, { iterations });
        await storage.set('qu/backup-at', Date.now());
        await qu.bus.notify('qu.device.backup', { groups: entries.filter(([k]) => k.startsWith('members/groups/')).length });
        return text;
      },
      /** Browser: offers the backup as a file download. @returns {Promise<string>} the backup text */
      async downloadBackup(passphrase, filename = 'qu-backup.txt') {
        const text = await api.exportBackup(passphrase);
        if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') throw new Error('downloadBackup: only in a browser - use exportBackup()');
        const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return text;
      },
      /** Asks the browser to keep this origin's storage (may prompt). @returns {Promise<boolean|null>} null: not supported here */
      async persist() {
        if (typeof nav?.storage?.persist !== 'function') return null;
        const granted = await nav.storage.persist();
        await qu.bus.notify('qu.device.persist', { granted });
        return granted;
      },
      /** Locks the stored identity with a passphrase (every start then needs it). */
      async lock(passphrase) {
        if (await storage.get(LOCKED_KEY)) throw new Error('lock: already locked - use changePassphrase(old, new)');
        await lockStored(storage, qu.identity, passphrase, iterations);
        await qu.bus.notify('qu.device.lock', { locked: true });
      },
      /** Re-seals the stored identity with a new passphrase. */
      async changePassphrase(oldPassphrase, newPassphrase) {
        const sealed = await storage.get(LOCKED_KEY);
        if (!sealed) throw new Error('changePassphrase: not locked - use lock(passphrase)');
        const identity = await openLocked(sealed, oldPassphrase);
        if (!sameIdentity(identity, qu.identity)) throw new Error('changePassphrase: the stored identity is not this peer\'s');
        await lockStored(storage, identity, newPassphrase, iterations);
      },
      /** Stores the identity unencrypted again (starts need no passphrase). */
      async removeLock(passphrase) {
        const sealed = await storage.get(LOCKED_KEY);
        if (!sealed) return;
        const identity = await openLocked(sealed, passphrase);
        await storage.set(PLAIN_KEY, identity);
        await storage.remove(LOCKED_KEY);
        await qu.bus.notify('qu.device.lock', { locked: false });
      },
      /**
       * Registers a security key (YubiKey: USB or NFC) or a passkey that unlocks this identity -
       * also on other devices (`createClient({ unlock: 'key' })`). Call from a click; register a
       * second key as a spare.
       * @param {{name?: string, kind?: 'security-key'|'passkey', lock?: boolean, rpName?: string}} [options]
       *   `name`: shown in `keys()` (default: what the browser tells, e.g. 'Security key (USB, NFC)',
       *   'Passkey (Google Password Manager)').
       *   `lock`: from now on this device keeps no usable identity - every start needs the key.
       * @returns {Promise<{id: string, synced: boolean}>} `synced`: the relay holds the tresor (other devices can unlock)
       */
      async addKey(options = {}) {
        return (await vault()).addKey(options);
      },
      /** @returns {Promise<Array<{id: string, name: string, type: 'security-key'|'passkey'|null, transports: string[], model: string|null, created: number}>>} keys that unlock this identity (`type`/`transports`/`model` as far as the browser tells) */
      async keys() {
        return ((await storage.get(VAULT_KEY))?.wraps ?? []).map(({ id, name, created, type = null, transports = [], model = null }) => ({ id, name, type, transports, model, created }));
      },
      /**
       * Removes a key (lost or replaced): it no longer opens the tresor, here or at the relay.
       * Removing the last key of a key-locked device stores the identity plain again.
       */
      async removeKey(id) {
        return (await vault()).removeKey(id);
      },

      /** @returns {Promise<{persisted: boolean|null, usage: number|null, quota: number|null, backupAt: number|null, groups: number, locked: boolean, keys: number, keyLocked: boolean}>} */
      async status() {
        const persisted = typeof nav?.storage?.persisted === 'function' ? await nav.storage.persisted() : null;
        const estimate = typeof nav?.storage?.estimate === 'function' ? await nav.storage.estimate() : {};
        return {
          persisted,
          usage: estimate.usage ?? null,
          quota: estimate.quota ?? null,
          backupAt: (await storage.get('qu/backup-at')) ?? null,
          groups: (await storage.keys('members/groups/')).length,
          locked: Boolean(await storage.get(LOCKED_KEY)),
          keys: ((await storage.get(VAULT_KEY))?.wraps ?? []).length,
          keyLocked: Boolean(await storage.get(VAULT_LOCK)),
        };
      },
    };
    qu.device = api;
    return api;
  };
  plugin.pluginName = 'device';
  return plugin;
}
