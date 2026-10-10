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
 */
import * as crypto from './crypto.js';
import { createQu } from './qu.js';
import { Registry } from './registry.js';
import { memoryDriver } from './drivers/memory.js';
import { indexedDbDriver } from './drivers/indexeddb.js';
import { records } from './records.js';
import { sync } from './sync/sync.js';
import { mirror } from './mirror.js';
import { user } from './user.js';
import { members } from './members.js';
import { inbox } from './inbox.js';
import { signals } from './signals.js';
import { status } from './status.js';
import { compaction } from './compaction.js';
import { rtc } from './net/webrtc.js';
import { topology } from './net/topology.js';
import { wsTransport } from './net/ws.js';
import { sseTransport } from './net/sse.js';
import { relayTransport } from './net/relay.js';

/** @returns {Registry} stores, plugins and transports usable in any environment. */
export function defaultRegistry() {
  return new Registry()
    .register('store', 'memory', () => memoryDriver())
    .register('store', 'indexeddb', (options) => indexedDbDriver(options))
    .register('plugin', 'records', (options) => records(options))
    .register('plugin', 'sync', (options) => sync(options))
    .register('plugin', 'mirror', (options) => mirror(options))
    .register('plugin', 'user', (options) => user(options))
    .register('plugin', 'members', (options) => members(options))
    .register('plugin', 'inbox', (options) => inbox(options))
    .register('plugin', 'signals', (options) => signals(options))
    .register('plugin', 'status', (options) => status(options))
    .register('plugin', 'compaction', (options) => compaction(options))
    .register('transport', 'webrtc', (options) => rtc(options))
    .register('plugin', 'topology', (options) => topology(options))
    .register('transport', 'ws', (options) => wsTransport(options))
    .register('transport', 'sse', (options) => sseTransport(options))
    .register('transport', 'relay', (options) => relayTransport(options));
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
 * }} [options]
 *   `identity: 'persisted'` (default) loads the identity from the store or
 *   creates and saves one - so a reload keeps who you are.
 */
export async function createPeer({ registry = defaultRegistry(), store = 'memory', identity = 'persisted', plugins = ['records', 'sync'], transports = [], netId } = {}) {
  const [storeName, storeOptions] = typeof store === 'object' && !Array.isArray(store) ? [null, store] : entry(store);
  const root = storeName ? await registry.create('store', storeName, storeOptions) : storeOptions;

  if (identity === 'persisted') {
    identity = await root.get('qu/identity');
    if (!identity) {
      identity = await crypto.generateIdentity();
      await root.set('qu/identity', identity);
    }
  }
  const qu = await createQu({ root, identity, registry, netId });
  qu.root = root;

  for (const [slot, list] of [['plugin', plugins], ['transport', transports]]) {
    for (const spec of list) {
      const [name, options] = entry(spec);
      qu.use(name ? await registry.create(slot, name, options) : options);
    }
  }
  return qu;
}
