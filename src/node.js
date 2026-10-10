/**
 * Node-only adapters for the peer registry (`@qu/lite/node`): the SQLite
 * store and the WebSocket server transport.
 */
import { defaultRegistry } from './peer.js';
import { sqliteDriver } from './drivers/sqlite.js';
import { wsServerTransport } from './net/ws-server.js';

/** @param {import('./registry.js').Registry} [registry] @returns {import('./registry.js').Registry} */
export function nodeRegistry(registry = defaultRegistry()) {
  return registry
    .register('store', 'sqlite', (options) => sqliteDriver(options))
    .register('transport', 'ws-server', (options) => wsServerTransport(options));
}

export { sqliteDriver } from './drivers/sqlite.js';
export { listenWs, wsServerTransport } from './net/ws-server.js';
export { createPeer, defaultRegistry } from './peer.js';
