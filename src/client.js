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
export const CLIENT_PLUGINS = Object.freeze(['records', 'user', 'members', 'inbox', ['sync', { ackFrom: 'mirror' }], 'status', 'compaction']);

/**
 * @param {{
 *   url?: string,
 *   name?: string,
 *   store?: string|[string, object]|object,
 *   plugins?: Array<string|[string, object]|Function>,
 *   extra?: Array<string|[string, object]|Function>,
 *   relay?: object,
 *   transports?: Array<string|[string, object]|Function>,
 *   devtools?: boolean|object,
 *   registry?: import('./registry.js').Registry,
 *   identity?: object|'persisted',
 * }} [options]
 *   `url`: relay origin (http(s):// or ws(s)://). `name`: IndexedDB database name (one per app).
 *   `extra`: plugins added to the defaults (e.g. ['text', 'blobs']). `relay`: options for the relay
 *   transport (e.g. {isolate: true}). `transports`: replaces the relay transport entirely.
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
} = {}) {
  store ??= globalThis.indexedDB ? ['indexeddb', { name }] : 'memory';
  transports ??= url ? [['relay', { url, ...relay }]] : [];
  const tools = devtools ? [['devtools', devtools === true ? {} : devtools]] : [];
  return createPeer({ registry, store, identity, plugins: [...plugins, ...extra, ...tools], transports });
}
