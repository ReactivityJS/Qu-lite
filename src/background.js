/**
 * BACKGROUND - what is still on its way to the relay, and getting it there
 * even when the page is closed:
 *
 *   qu.use(background())                      // or createClient({ extra: ['background'] })
 *   await qu.background.progress()            // {records, bytes} still in the outbox
 *   qu.bus.on('qu.sync.progress', ({records, bytes}) => ...)   // on every change
 *
 * 1. BACKGROUND SYNC (Chrome, Edge, Samsung Internet): while the outbox is
 *    not empty, a one-off sync (`qu-outbox`) is registered with the service
 *    worker. When the network is there - also after the tab was closed - the
 *    browser wakes the worker, which posts the sealed envelopes straight
 *    from IndexedDB to the relay (`POST /q/in`, sw.js) and clears what the
 *    relay stored. Needs a service worker that installs `quServiceWorker()`.
 * 2. FALLBACK WAKE LOCK (Safari, Firefox, no service worker): the screen is
 *    kept on while the outbox is not empty and a relay is connected
 *    (awake.js) - a phone that sleeps would stop the upload.
 *
 * The relay's HTTP origin is stored (`bg/relay`) for the service worker.
 */
import { awakeOf } from './awake.js';
import { httpOrigin } from './net/http.js';

export const OUTBOX_TAG = 'qu-outbox';

/**
 * @param {{serviceWorker?: object|null, wakeLock?: object|null, relay?: string, tag?: string, debounceMs?: number}} [options]
 *   `serviceWorker`: `navigator.serviceWorker` (tests inject one); `relay`: origin for the worker
 *   (default: the relay transport's first url).
 */
export function background({ serviceWorker = globalThis.navigator?.serviceWorker ?? null, wakeLock, relay, tag = OUTBOX_TAG, debounceMs = 100 } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const awake = awakeOf(qu, wakeLock === undefined ? {} : { wakeLock });
    let registration = null;
    let timer = null;
    let last = { records: -1, bytes: -1 };
    let registered = false;

    /** @returns {Promise<{records: number, bytes: number}>} what the outbox still holds */
    const sizes = new Map(); // outbox key -> envelope size: each one is read once, not on every update
    async function progress() {
      const keys = await storage.keys('sync/out/');
      const present = new Set(keys);
      for (const key of sizes.keys()) if (!present.has(key)) sizes.delete(key);
      let bytes = 0;
      for (const key of keys) {
        if (!sizes.has(key)) {
          const [, , sid, id] = key.split('/');
          sizes.set(key, (await storage.get(`rec/${sid}/${id}`))?.length ?? 0);
        }
        bytes += sizes.get(key);
      }
      return { records: keys.length, bytes };
    }

    async function update() {
      timer = null;
      if (qu.closed) return;
      await rememberRelay();
      const now = await progress();
      if (now.records !== last.records || now.bytes !== last.bytes) {
        last = now;
        await bus.notify('qu.sync.progress', now);
      }
      if (now.records === 0) registered = false;
      else if (api.backgroundSync && !registered) {
        registered = true;
        try {
          await registration.sync.register(tag);
        } catch (error) {
          // the API exists but is switched off (site setting, headless, policy): fall back to the wake lock
          registered = false;
          api.backgroundSync = false;
          await bus.notify('qu.background.unavailable', { reason: error?.message ?? String(error) });
        }
      }
      await awake.set('outbox', now.records > 0 && api.backgroundSync !== true);
    }
    const schedule = () => {
      if (!timer && !qu.closed) timer = setTimeout(() => update().catch((error) => bus.error(error, 'background')), debounceMs);
    };
    qu.onClose?.(() => clearTimeout(timer));
    for (const topic of ['qu.record.acked', 'net.peer.up', 'net.peer.down']) bus.on(topic, schedule);
    // a local write: measure once it is committed (the write set flushes after this hook)
    bus.on('qu.write.stored', ({ ws }) => (ws?.after ? ws.after(schedule) : schedule()));

    // the worker's target; transports are installed after plugins, so looked up on use
    let origin = null;
    async function rememberRelay() {
      const next = relay ?? qu.transports?.relay?.urls?.[0];
      if (!next || httpOrigin(next) === origin) return;
      origin = httpOrigin(next);
      await storage.set('bg/relay', origin);
    }

    // read the url while connected - a disconnect clears the transport's list
    bus.on('net.peer.up', () => rememberRelay().catch((error) => bus.error(error, 'background.relay')));

    const ready = (async () => {
      await Promise.resolve(); // let createPeer() install the transports first
      registration = (await serviceWorker?.getRegistration?.().catch(() => null)) ?? null;
      api.backgroundSync = Boolean(registration?.sync?.register);
      await update();
      return api.backgroundSync;
    })();

    const api = {
      progress,
      ready,
      /** true: Background Sync delivers the outbox; false: wake lock fallback; null: not known yet */
      backgroundSync: null,
      get awake() {
        return awake.held;
      },
    };
    qu.background = api;
    return api;
  };
}
