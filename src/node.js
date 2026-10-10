/**
 * Node-only adapters for the peer registry (`@qu/lite/node`): the SQLite
 * store and the WebSocket server transport.
 */
import { defaultRegistry } from './peer.js';
import { sqliteDriver } from './drivers/sqlite.js';
import { httpServerTransport } from './net/ws-server.js';

/** @param {import('./registry.js').Registry} [registry] @returns {import('./registry.js').Registry} */
export function nodeRegistry(registry = defaultRegistry()) {
  return registry
    .register('store', 'sqlite', (options) => sqliteDriver(options))
    .register('transport', 'http-server', (options) => httpServerTransport(options))
    .register('transport', 'ws-server', (options) => httpServerTransport(options));
}

export { sqliteDriver } from './drivers/sqlite.js';
export { listenWs, listenHttp, wsServerTransport, httpServerTransport } from './net/ws-server.js';
export { createPeer, defaultRegistry } from './peer.js';
