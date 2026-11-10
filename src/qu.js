/**
 * QU - the kernel: a Bus, a mount router and a registry, nothing else.
 * Everything with behaviour (records, network bridges, later sync/status)
 * is a plugin installed with `qu.use(plugin)`, and plugins only talk to each
 * other through bus topics and the storage contract - never by importing
 * one another.
 *
 * LIFECYCLE - a kernel can be shut down again (`qu.close()`): tests, hot
 * reloads, single-page apps that mount and unmount a peer, a relay doing a
 * graceful shutdown. Plugins register what has to be undone with
 * `qu.onClose(fn)` (run in reverse order), and timers through
 * `qu.timers.interval/timeout`, which are unref'd on Node (they never keep a
 * process alive) and cleared on close. A plugin API with a `close()` method
 * is closed automatically. `qu.closed` tells a late callback that the kernel
 * is gone. Events: `qu.closing` (before), `qu.closed` (after).
 *
 * INSTALLED PLUGINS - `qu.use(plugin, name?)` remembers the plugin under its
 * name (the registry name, `plugin.pluginName`, or none) in `qu.plugins`,
 * so a plugin can check an optional neighbour with `qu.has('sync')` instead
 * of probing for methods.
 */
import { Bus } from './bus.js';
import * as crypto from './crypto.js';
import { createMountRouter } from './mount.js';
import { Registry } from './registry.js';
import { createClock } from './hlc.js';

/**
 * @param {{
 *   identity?: {publicKey: Uint8Array, privateKey: Uint8Array, xPublicKey: Uint8Array, xPrivateKey: Uint8Array},
 *   bus?: Bus,
 *   root?: object,
 *   clock?: ReturnType<typeof createClock>,
 *   registry?: Registry,
 *   netId?: string,
 * }} [options]
 */
export async function createQu({ identity, bus = new Bus(), root, clock = createClock(), registry = new Registry(), netId } = {}) {
  identity = identity ?? (await crypto.generateIdentity());
  const storage = createMountRouter({ root, bus });

  // The NETWORK id is deliberately unrelated to the identity: relays and
  // peers route by it, and must not be able to recognise the person behind
  // it. Random per device, persisted (pending syncs refer to it), rotatable.
  const randomNetId = () => crypto.toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
  netId = netId ?? (await storage.get('qu/net-id'));
  if (!netId) {
    netId = randomNetId();
    await storage.set('qu/net-id', netId);
  }

  /** @type {Array<() => *>} undone in reverse order by close() */
  const disposers = [];
  let closing = null;

  const unregister = (fn) => {
    const at = disposers.lastIndexOf(fn);
    if (at !== -1) disposers.splice(at, 1);
  };
  /** Registers a timer handle so close() clears it; unref'd where the runtime supports it. */
  const track = (handle, clear) => {
    handle?.unref?.();
    const dispose = () => clear(handle);
    disposers.push(dispose);
    return () => {
      clear(handle);
      unregister(dispose);
    };
  };

  const qu = {
    bus,
    storage,
    registry,
    clock,
    identity,
    /** @type {string} Network id used in `net.*` topics and the `hi` handshake - not derived from the identity. */
    peerId: netId,
    /** @type {Map<string, *>} installed plugins: name -> what the plugin returned */
    plugins: new Map(),
    /** True once close() started - late callbacks should do nothing then. */
    get closed() {
      return closing !== null;
    },
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
     * bus listeners. Returns whatever the plugin returns; if that has a
     * `close()`, `qu.close()` calls it.
     * @template T
     * @param {(qu: object) => T} plugin
     * @param {string} [name] - defaults to `plugin.pluginName`
     * @returns {T}
     */
    use(plugin, name = plugin?.pluginName) {
      if (typeof plugin !== 'function') throw new TypeError(`qu.use: a plugin is a function (qu) => api, got ${typeof plugin}`);
      if (closing) throw new Error('qu.use: this Qu is closed');
      const api = plugin(qu);
      if (name) qu.plugins.set(name, api);
      if (api && typeof api === 'object' && api !== qu && typeof api.close === 'function') qu.onClose(() => api.close());
      return api;
    },
    /** @param {string} name @returns {boolean} whether a plugin of that name is installed */
    has: (name) => qu.plugins.has(name),
    /**
     * Registers cleanup for `close()` (reverse order of registration).
     * @param {() => *} fn
     * @returns {() => void} unregister
     */
    onClose(fn) {
      disposers.push(fn);
      return () => unregister(fn);
    },
    /** Timers owned by this Qu: cleared on close, never keep Node alive. Each returns a cancel function. */
    timers: {
      /** @param {() => *} fn @param {number} ms @returns {() => void} */
      interval: (fn, ms) => track(setInterval(fn, ms), clearInterval),
      /** @param {() => *} fn @param {number} ms @returns {() => void} */
      timeout: (fn, ms) => {
        let cancel = null;
        cancel = track(
          setTimeout(() => {
            cancel?.();
            fn();
          }, ms),
          clearTimeout
        );
        return cancel;
      },
    },
    /**
     * Shuts the kernel down: `qu.closing`, every registered disposer in
     * reverse order (errors go to `bus.error`, nothing is thrown), the root
     * store's `close()` (unless `keepStore`), then `qu.closed`.
     * Idempotent - a second call returns the same promise.
     * @param {{keepStore?: boolean}} [options]
     * @returns {Promise<void>}
     */
    close({ keepStore = false } = {}) {
      closing ??= (async () => {
        await bus.notify('qu.closing', {});
        while (disposers.length) {
          const fn = disposers.pop();
          try {
            await fn();
          } catch (error) {
            bus.error(error, 'qu.close');
          }
        }
        if (!keepStore && typeof root?.close === 'function') {
          try {
            await root.close();
          } catch (error) {
            bus.error(error, 'qu.close');
          }
        }
        await bus.notify('qu.closed', {});
      })();
      return closing;
    },
  };
  return qu;
}
