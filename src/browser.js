/**
 * Small browser entry (`@qu/lite/client`, served as dist/qu-client.js): the
 * presets and the kernel, nothing else statically. Every plugin, store and
 * transport named in `createClient()`/`createPeer()` is loaded on demand
 * from its own chunk - an app downloads only what it uses.
 *
 * The full barrel (`@qu/lite`, dist/qu-lite.js) stays available for apps that
 * wire plugins by hand (`qu.use(records())`).
 */
export { createClient, CLIENT_PLUGINS } from './client.js';
export { createPeer, defaultRegistry } from './peer.js';
export { createQu } from './qu.js';
export { Registry } from './registry.js';
export { Bus } from './bus.js';
export { Space } from './space.js';
export { memoryDriver } from './drivers/memory.js';
export { PROTOCOL_VERSION } from './net/link.js';
export { fetchPublic, publicLink } from './public.js';
