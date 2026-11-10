/**
 * PEER PRESETS - one builder for every kind of node. A browser client, a
 * Node peer and a mirror/relay are the same Qu with different adapters from
 * the registry - no relay-specific code paths:
 *
 *   browser:  createPeer({ store: 'indexeddb', plugins: ['records', 'user', 'sync'], transports: [['ws', {connect: [url]}]] })
 *   mirror:   createPeer({ registry: nodeRegistry(), store: ['sqlite', {path}],
 *                          plugins: [['sync', {role: 'mirror'}], 'mirror'], transports: [['ws-server', {port}]] })
 *
 * Every entry is a registry name, `[name, options]`, or a ready plugin
 * function. Node-only adapters (sqlite, ws-server) are added by
 * `nodeRegistry()` from `@qu/lite/node`, so browser bundles never see them.
 *
 * The default registry LOADS LAZILY: each factory imports its module only
 * when that name is used (`import()`), so a peer built from names carries
 * just what it asked for - a client without `text`, `blobs`, `rtc` or
 * `stats` never loads them, and a bundler puts each optional plugin into
 * its own chunk.
 *
 * If building fails half-way (a plugin throws, a port is taken), everything
 * installed so far is closed again and the error is rethrown - no open
 * store, socket or timer is left behind.
 */
import * as crypto from './crypto.js';
import { createQu } from './qu.js';
import { Registry } from './registry.js';
import { memoryDriver } from './drivers/memory.js';
import { checkFormat } from './format.js';

/** A factory that imports its module on first use. */
const lazy = (load, pick) => async (options) => (await load())[pick](options);

/** @returns {Registry} stores, plugins and transports usable in any environment. */
export function defaultRegistry() {
  return new Registry()
    .register('store', 'memory', () => memoryDriver())
    .register('store', 'indexeddb', lazy(() => import('./drivers/indexeddb.js'), 'indexedDbDriver'))
    .register('plugin', 'records', lazy(() => import('./records.js'), 'records'))
    .register('plugin', 'sync', lazy(() => import('./sync/sync.js'), 'sync'))
    .register('plugin', 'mirror', lazy(() => import('./mirror.js'), 'mirror'))
    .register('plugin', 'user', lazy(() => import('./user.js'), 'user'))
    .register('plugin', 'members', lazy(() => import('./members.js'), 'members'))
    .register('plugin', 'inbox', lazy(() => import('./inbox.js'), 'inbox'))
    .register('plugin', 'signals', lazy(() => import('./signals.js'), 'signals'))
    .register('plugin', 'status', lazy(() => import('./status.js'), 'status'))
    .register('plugin', 'compaction', lazy(() => import('./compaction.js'), 'compaction'))
    .register('plugin', 'limits', lazy(() => import('./limits.js'), 'limits'))
    .register('plugin', 'text', lazy(() => import('./text.js'), 'text'))
    .register('plugin', 'blobs', lazy(() => import('./blobs.js'), 'blobs'))
    .register('plugin', 'stats', lazy(() => import('./stats.js'), 'stats'))
    .register('plugin', 'devtools', lazy(() => import('./devtools.js'), 'devtools'))
    .register('plugin', 'device', lazy(() => import('./device.js'), 'device'))
    .register('plugin', 'background', lazy(() => import('./background.js'), 'background'))
    .register('plugin', 'live', lazy(() => import('./live.js'), 'live'))
    .register('plugin', 'schema', lazy(() => import('./schema.js'), 'schema'))
    .register('plugin', 'archive', lazy(() => import('./archive.js'), 'archive'))
    .register('plugin', 'push', lazy(() => import('./push.js'), 'push'))
    .register('plugin', 'push-relay', lazy(() => import('./push-relay.js'), 'pushRelay'))
    .register('plugin', 'topology', lazy(() => import('./net/topology.js'), 'topology'))
    .register('transport', 'webrtc', lazy(() => import('./net/webrtc.js'), 'rtc'))
    .register('transport', 'ws', lazy(() => import('./net/ws.js'), 'wsTransport'))
    .register('transport', 'sse', lazy(() => import('./net/sse.js'), 'sseTransport'))
    .register('transport', 'relay', lazy(() => import('./net/relay.js'), 'relayTransport'));
}

const entry = (spec) => (Array.isArray(spec) ? spec : typeof spec === 'string' ? [spec, {}] : [null, spec]);

/**
 * @param {{
 *   registry?: Registry,
 *   store?: string|[string, object]|object,
 *   identity?: object|'persisted',
 *   plugins?: Array<string|[string, object]|Function>,
 *   transports?: Array<string|[string, object]|Function>,
 *   netId?: string,
 *   restore?: {backup: string, passphrase: string, force?: boolean},
 *   passphrase?: string,
 *   unlock?: {relay?: string, credentials?: object, rpId?: string, kind?: 'security-key'|'passkey', remember?: boolean},
 * }} [options]
 *   `identity: 'persisted'` (default) loads the identity from the store or
 *   creates and saves one - so a reload keeps who you are.
 *   `restore`: writes a device backup (device.js) into the store first and
 *   uses its identity; refused if the store belongs to another identity
 *   that has groups here, unless `force`. Then call `qu.restoreGroups()`.
 *   `passphrase`: the identity is kept encrypted in the store (device.js
 *   IDENTITY LOCK); a locked store needs it on every start (errors with
 *   `code` 'QU_LOCKED' / 'QU_WRONG_PASSPHRASE').
 *   `unlock`: open the identity with a security key or passkey (keys.js): a
 *   tresor on this device, or - on a new device - the one at `relay`.
 *   The store's format is checked first (format.js): older data is migrated,
 *   data of a newer version is refused with `code` 'QU_FORMAT_NEWER'.
 *   A transport whose API has a `ready` promise (a server binding its port)
 *   is awaited, so a failure surfaces here and not later.
 * @returns {Promise<import('./qu-types.js').Qu>}
 */
export async function createPeer({ registry = defaultRegistry(), store = 'memory', identity = 'persisted', plugins = ['records', 'sync'], transports = [], netId, restore, passphrase, unlock } = {}) {
  const [storeName, storeOptions] = typeof store === 'object' && !Array.isArray(store) ? [null, store] : entry(store);
  const root = storeName ? await registry.create('store', storeName, storeOptions) : storeOptions;

  let qu = null;
  try {
    await checkFormat(root); // qu/format: migrate older data, refuse data of a newer version (format.js)
    if (restore) {
      await (await import('./device.js')).restoreInto(root, { ...restore, lockPassphrase: passphrase });
      identity = 'persisted';
    }
    if (identity === 'persisted' && unlock) {
      identity = (await (await import('./device.js')).unlockWithKey(root, unlock)) ?? 'persisted';
    } else if (identity === 'persisted' && passphrase == null && (await root.get('qu/vault'))) {
      // a key-locked device must not silently get a new identity
      if (await (await import('./device.js')).needsKey(root)) throw Object.assign(new Error('identity is locked: start with unlock (security key or passkey)'), { code: 'QU_LOCKED', unlock: 'key' });
    }
    if (identity === 'persisted' && (passphrase != null || (await root.get('qu/identity-locked')))) {
      identity = await (await import('./device.js')).loadIdentity(root, { passphrase });
    }
    if (identity === 'persisted') {
      identity = await root.get('qu/identity');
      if (!identity) {
        identity = await crypto.generateIdentity();
        await root.set('qu/identity', identity);
      }
    }
    qu = await createQu({ root, identity, registry, netId });
    qu.root = root;

    for (const [slot, list] of [['plugin', plugins], ['transport', transports]]) {
      for (const spec of list) {
        const [name, options] = entry(spec);
        const plugin = name ? await registry.create(slot, name, options) : options;
        const api = qu.use(plugin, name ?? plugin?.pluginName);
        if (slot === 'transport' && typeof api?.ready?.then === 'function') await api.ready;
      }
    }
    return qu;
  } catch (error) {
    if (qu) await qu.close();
    else await root?.close?.();
    throw error;
  }
}
