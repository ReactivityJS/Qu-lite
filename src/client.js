/**
 * CLIENT PRESET - the usual app peer in one call, the counterpart of
 * `createRelay()` (`@qu/lite/node`). Both are plain `createPeer()` calls
 * with sensible defaults; anything can still be overridden.
 *
 *   const qu = await createClient({ url: 'https://relay.example' });
 *   const group = await qu.createGroup();
 *   await qu.write(group, 'chat', 'hallo');
 *
 * Defaults: IndexedDB when the runtime has it (identity and data survive a
 * reload), memory otherwise (Node scripts, tests); the plugin set of a chat
 * style app; the relay transport (WebSocket, HTTPS + SSE fallback) when a
 * `url` is given; `devtools` in browsers (window.qu, qu.dev).
 */
import { createPeer, defaultRegistry } from './peer.js';

/** The plugin set `createClient()` installs unless `plugins` is given. */
export const CLIENT_PLUGINS = Object.freeze(['records', 'user', 'members', 'inbox', ['sync', { ackFrom: 'mirror' }], 'status', 'compaction', 'device']);

/**
 * @param {{
 *   url?: string|string[],
 *   name?: string,
 *   store?: string|[string, object]|object,
 *   plugins?: Array<string|[string, object]|Function>,
 *   extra?: Array<string|[string, object]|Function>,
 *   relay?: object,
 *   transports?: Array<string|[string, object]|Function>,
 *   devtools?: boolean|object,
 *   persist?: boolean,
 *   restore?: {backup: string, passphrase: string, force?: boolean},
 *   passphrase?: string,
 *   unlock?: 'key'|{kind?: 'security-key'|'passkey', remember?: boolean, rpId?: string, credentials?: object},
 *   registry?: import('./registry.js').Registry,
 *   identity?: object|'persisted',
 * }} [options]
 *   `url`: relay origin (http(s):// or ws(s)://), or several for redundancy - every one is
 *   kept connected, one going down changes nothing. `name`: IndexedDB database name (one per app).
 *   `extra`: plugins added to the defaults (e.g. ['text', 'blobs']). `relay`: options for the relay
 *   transport (e.g. {isolate: true}). `transports`: replaces the relay transport entirely.
 *   `persist`: ask the browser right away to keep this origin's storage (may
 *   prompt; default false - call `qu.device.persist()` at a better moment).
 *   `restore`: start from a device backup (`qu.device.exportBackup()` on the
 *   old device); then `await qu.restoreGroups()`.
 *   `passphrase`: keep the identity encrypted in storage; every start needs it
 *   (`error.code` 'QU_LOCKED' without, 'QU_WRONG_PASSPHRASE' with a wrong one).
 *   `unlock: 'key'`: open the identity with a security key (YubiKey, USB/NFC) or passkey -
 *   on a new device the tresor comes from the relay (`qu.device.addKey()` registers keys).
 *   Errors: 'QU_KEY_CANCELLED', 'QU_KEY_UNSUPPORTED', 'QU_KEY_UNKNOWN'. Call from a click.
 * @returns {Promise<import('./qu-types.js').Qu>}
 */
export async function createClient({
  url,
  name = 'qu-lite',
  store,
  plugins = CLIENT_PLUGINS,
  extra = [],
  relay = {},
  transports,
  devtools = typeof window !== 'undefined',
  registry = defaultRegistry(),
  identity = 'persisted',
  persist = false,
  restore,
  passphrase,
  unlock,
} = {}) {
  store ??= globalThis.indexedDB ? ['indexeddb', { name }] : 'memory';
  transports ??= url && [url].flat().length ? [['relay', { url, ...relay }]] : [];
  const tools = devtools ? [['devtools', devtools === true ? {} : devtools]] : [];
  const unlockWith = unlock ? { ...(unlock === 'key' ? {} : unlock), relay: [url].flat()[0] } : undefined;
  const qu = await createPeer({ registry, store, identity, restore, passphrase, unlock: unlockWith, plugins: [...plugins, ...extra, ...tools], transports });
  if (persist && qu.device) await qu.device.persist().catch((error) => qu.bus.error(error, 'device.persist'));
  return qu;
}
