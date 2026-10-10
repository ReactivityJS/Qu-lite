/**
 * QU - the kernel: an EventBus, a mount router and a registry, nothing else.
 * Everything with behaviour (records, network bridges, later sync/status)
 * is a plugin installed with `qu.use(plugin)`, and plugins only talk to each
 * other through bus topics and the storage contract - never by importing
 * one another.
 */
import { EventBus } from '@qu/events';
import { QuCrypto } from '@qu/core';
import { createMountRouter } from './mount.js';
import { Registry } from './registry.js';
import { createClock } from './hlc.js';

/**
 * @param {{
 *   identity?: {publicKey: Uint8Array, privateKey: Uint8Array, xPublicKey: Uint8Array, xPrivateKey: Uint8Array},
 *   bus?: EventBus,
 *   root?: object,
 *   clock?: ReturnType<typeof createClock>,
 *   registry?: Registry,
 * }} [options]
 */
export async function createQu({ identity, bus = new EventBus(), root, clock = createClock(), registry = new Registry() } = {}) {
  identity = identity ?? (await QuCrypto.generateKeypair());
  const storage = createMountRouter({ root, bus });

  const qu = {
    bus,
    storage,
    registry,
    clock,
    identity,
    /** @type {string} Short public id used in `net.*` topics. */
    peerId: QuCrypto.toHex(identity.publicKey).slice(0, 16),
    /** @param {string} base @param {object} driver */
    mount: (base, driver) => storage.mount(base, driver),
    /** @param {string} base */
    unmount: (base) => storage.unmount(base),
    /**
     * Installs a plugin: `plugin(qu)` may add methods to `qu` and register
     * bus listeners. Returns whatever the plugin returns.
     * @template T
     * @param {(qu: object) => T} plugin
     * @returns {T}
     */
    use(plugin) {
      return plugin(qu);
    },
  };
  return qu;
}
