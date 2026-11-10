/**
 * The Node-only registry entries (`sqlite` store, `http-server`/`ws-server`
 * transport) on top of the default registry. Kept apart from node.js so the
 * relay preset (server.js) can use it without an import cycle.
 */
import { defaultRegistry } from './peer.js';

/** @param {import('./registry.js').Registry} [registry] @returns {import('./registry.js').Registry} */
export function nodeRegistry(registry = defaultRegistry()) {
  return registry
    .register('store', 'sqlite', async (options) => (await import('./drivers/sqlite.js')).sqliteDriver(options))
    .register('transport', 'http-server', async (options) => (await import('./net/ws-server.js')).httpServerTransport(options))
    .register('transport', 'ws-server', async (options) => (await import('./net/ws-server.js')).httpServerTransport(options));
}
