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
export async function createQu({ identity, bus = new EventBus(), root, clock = createClock(), registry = new Registry(), netId } = {}) {
  identity = identity ?? (await QuCrypto.generateKeypair());
  const storage = createMountRouter({ root, bus });

  // The NETWORK id is deliberately unrelated to the identity: relays and
  // peers route by it, and must not be able to recognise the person behind
  // it. Random per device, persisted (pending syncs refer to it), rotatable.
  const randomNetId = () => QuCrypto.toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
  netId = netId ?? (await storage.get('qu/net-id'));
  if (!netId) {
    netId = randomNetId();
    await storage.set('qu/net-id', netId);
  }

  const qu = {
    bus,
    storage,
    registry,
    clock,
    identity,
    /** @type {string} Network id used in `net.*` topics and the `hi` handshake - not derived from the identity. */
    peerId: netId,
    /** Picks a fresh network id for links opened from now on. */
    async rotateNetId() {
      qu.peerId = randomNetId();
      await storage.set('qu/net-id', qu.peerId);
      return qu.peerId;
    },
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
