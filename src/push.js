/**
 * PUSH (client side) - be woken when the app is closed: new messages in the
 * groups you choose, and calls.
 *
 *   qu.use(push())                         // or createClient({ extra: ['push'] })
 *   // from a click (browsers ask for permission only then):
 *   await qu.push.enable([family, team], { labels: { [family.id]: 'Familie' }, paths: ['chat'] })
 *   await qu.push.ring(family)             // a call: wakes the other members' devices now
 *   qu.push.opened                         // {sid, kind} when the app was opened from a notification
 *   qu.bus.on('qu.push.open', ({sid, kind}) => showCall(sid))   // ... or tapped while open
 *
 * Needs a service worker that runs `quServiceWorker()` (sw.js) and a relay
 * with push (`createRelay({ push: {...} })`, push-relay.js). The push itself
 * carries nothing; the worker asks the relay which groups had what, and
 * shows "Familie - 3 new messages" or "Call - Familie" (labels stay on this
 * device). Tapping opens the app with `?qu-space=<sid>` / `?qu-call=<sid>`.
 *
 * iOS: only for web apps added to the home screen (16.4+). Browsers require
 * a visible notification for every push - this is for things worth one.
 */
import * as crypto from './crypto.js';
import { httpOrigin } from './net/http.js';

const enc = new TextEncoder();
/** What a member signs with the epoch write key to subscribe / to ring (checked by push-relay.js). */
export const pushMessage = (sid, endpoint) => enc.encode(`qu-lite/push\n${sid}\n${endpoint}`);
export const ringMessage = (sid, at, kind) => enc.encode(`qu-lite/ring\n${sid}\n${at}\n${kind}`);
const b64urlToBytes = (text) => crypto.fromBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='));

/**
 * @param {{serviceWorker?: object|null, relay?: string, Notification?: object|null, location?: {search: string}|null, fetch?: typeof fetch}} [options]
 */
export function push({ serviceWorker = globalThis.navigator?.serviceWorker ?? null, relay, Notification: N = globalThis.Notification ?? null, location = globalThis.location ?? null, fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return (qu) => {
    const { bus, storage, identity } = qu;
    const base = () => {
      const url = relay ?? qu.transports?.relay?.urls?.[0];
      if (!url) throw new Error('push: no relay url');
      return httpOrigin(url);
    };
    async function post(path, body) {
      const res = await fetchImpl(`${base()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`push: ${path} ${res.status} ${await res.text().catch(() => '')}`.trim());
      return res.json();
    }
    const registration = async () => {
      const reg = await serviceWorker?.getRegistration?.();
      if (!reg?.pushManager) throw new Error('push: no service worker with push (register one that runs quServiceWorker())');
      return reg;
    };
    const writeSig = async (space, message) => crypto.toBase64(await crypto.sign(message, space.epochKeys(space.epoch).writePriv));

    /** What the app was opened for (from the URL a notification opened). */
    let opened = null;
    try {
      const q = new URLSearchParams(location?.search ?? '');
      if (q.get('qu-call')) opened = { sid: q.get('qu-call'), kind: 'call' };
      else if (q.get('qu-space')) opened = { sid: q.get('qu-space'), kind: 'message' };
    } catch {}
    // a notification tapped while the app is open (sw.js posts it)
    const onMessage = (event) => {
      const data = event?.data;
      if (data?.type === 'qu-notification' && typeof data.sid === 'string') bus.notify('qu.push.open', { sid: data.sid, kind: data.kind });
    };
    serviceWorker?.addEventListener?.('message', onMessage);
    qu.onClose?.(() => serviceWorker?.removeEventListener?.('message', onMessage));

    const api = {
      opened,
      /** @returns {boolean} this browser can do push (service worker API + PushManager) */
      supported: () => Boolean(serviceWorker && (globalThis.PushManager || globalThis.window === undefined)),

      /**
       * Subscribes this device for the given spaces. Call from a user gesture.
       * @param {Array<import('./space.js').Space>} spaces
       * @param {{labels?: Record<string, string>, paths?: string[]|null}} [options]
       *   `labels`: names shown in notifications (stay on the device). `paths`: only records
       *   under these first path segments wake (default ['chat']; null = every record).
       * @returns {Promise<string[]>} sids the relay accepted
       */
      async enable(spaces, { labels = {}, paths = ['chat'] } = {}) {
        if (N?.permission === 'denied') throw new Error('push: notifications are blocked for this site');
        if (N && N.permission !== 'granted' && (await N.requestPermission()) !== 'granted') throw new Error('push: permission not granted');
        const reg = await registration();
        const { key } = await (await fetchImpl(`${base()}/push/key`)).json();
        let sub = await reg.pushManager.getSubscription();
        if (sub && sub.options?.applicationServerKey && crypto.toBase64(new Uint8Array(sub.options.applicationServerKey)) !== crypto.toBase64(b64urlToBytes(key))) {
          await sub.unsubscribe(); // another relay's key (relay moved): resubscribe
          sub = null;
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
        const endpoint = sub.endpoint;
        const list = [];
        for (const space of spaces) {
          list.push({
            sid: space.id,
            epoch: space.epoch,
            sig: await writeSig(space, pushMessage(space.id, endpoint)),
            author: crypto.toHex((await space.authorFor(identity)).publicKey),
            ...(paths ? { shards: await Promise.all(paths.map(async (p) => crypto.toHex(await space.shardOf(p)))) } : {}),
          });
        }
        const { accepted } = await post('/push/subscribe', { endpoint, peer: qu.peerId, spaces: list });
        await storage.set('push/labels', { ...((await storage.get('push/labels')) ?? {}), ...labels });
        await storage.set('push/endpoint', endpoint);
        await storage.set('bg/relay', base());
        return accepted;
      },

      /** Stops push for these spaces (all, without argument) on this device. */
      async disable(spaces) {
        const endpoint = await storage.get('push/endpoint');
        if (!endpoint) return;
        await post('/push/unsubscribe', { endpoint, ...(spaces ? { sids: spaces.map((s) => s.id) } : {}) });
        if (!spaces) {
          await storage.remove('push/endpoint');
          const reg = await serviceWorker?.getRegistration?.();
          await (await reg?.pushManager?.getSubscription())?.unsubscribe();
        }
      },

      /** Updates notification labels (local only). */
      async labels(map) {
        await storage.set('push/labels', { ...((await storage.get('push/labels')) ?? {}), ...map });
      },

      /**
       * Wakes the other members' devices that are not connected - for a call
       * (`kind: 'call'`, at once, urgent) or an important message.
       * @returns {Promise<number>} devices woken
       */
      async ring(space, { kind = 'call' } = {}) {
        const at = Date.now();
        const { woken } = await post('/push/ring', { sid: space.id, epoch: space.epoch, at, kind, sig: await writeSig(space, ringMessage(space.id, at, kind)), peer: qu.peerId });
        return woken;
      },
    };
    qu.push = api;
    return api;
  };
}
