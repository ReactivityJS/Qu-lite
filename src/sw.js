/**
 * SERVICE WORKER - what runs while the app is closed. No peer, no link: it
 * reads the app's IndexedDB directly and talks plain HTTP to the relay
 * (public.js, push-relay.js). The relay origin comes from the store
 * (`bg/relay`, written by background.js / push.js).
 *
 *   // sw.js of the app (served from the app's origin, classic script):
 *   importScripts('https://relay.example/dist/qu-sw.js');
 *   quServiceWorker({ db: 'qu-lite', open: '/' });
 *
 *   // or as an ES module worker / with a bundler:
 *   import { quServiceWorker } from '@qu/lite/sw';
 *
 * Events:
 *   sync 'qu-outbox'     -> deliverOutbox(): POST the sealed outbox to /q/in,
 *                           clear what the relay stored (Background Sync, background.js)
 *   push                 -> showPending(): ask /push/pending what woke it, show one
 *                           notification per group (a call: urgent, stays until tapped)
 *   notificationclick    -> focus the app (it gets {type: 'qu-notification', sid, kind}
 *                           as a message, push.js -> 'qu.push.open') or open
 *                           `open?qu-space=<sid>` / `open?qu-call=<sid>`
 *
 * The browser demands a visible notification for every push; if the relay
 * cannot be asked, a generic one is shown. Texts are replaceable (`texts`).
 */
import { indexedDbDriver } from './drivers/indexeddb.js';
import { packEnvelopes } from './net/http.js';
import { OUTBOX_TAG } from './background.js';

const DONE = new Set(['stored', 'duplicate', 'gone']);
const BATCH = 256;

export const DEFAULT_TEXTS = {
  call: (label) => ({ title: label, body: 'Incoming call - tap to answer' }),
  message: (label, count) => ({ title: label, body: count === 1 ? '1 new message' : `${count} new messages` }),
  fallback: () => ({ title: 'New activity', body: '' }),
};

/**
 * Sends what waits in the outbox and clears what the relay stored.
 * @param {object} storage - a driver on the app's database
 * @param {{fetch?: typeof fetch, relay?: string}} [options]
 * @returns {Promise<{sent: number, done: number}>} throws if the relay cannot be reached (the browser retries)
 */
export async function deliverOutbox(storage, { fetch: fetchImpl = (...a) => globalThis.fetch(...a), relay } = {}) {
  const origin = relay ?? (await storage.get('bg/relay'));
  if (!origin) return { sent: 0, done: 0 };
  const keys = await storage.keys('sync/out/');
  let sent = 0;
  let done = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = [];
    for (const key of keys.slice(i, i + BATCH)) {
      const [, , sid, id] = key.split('/');
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes) batch.push({ key, bytes });
    }
    if (!batch.length) continue;
    const res = await fetchImpl(`${origin}/q/in`, { method: 'POST', body: packEnvelopes(batch.map((b) => b.bytes)) });
    if (!res.ok) throw new Error(`qu-sw: relay answered ${res.status}`);
    const { results } = await res.json();
    sent += batch.length;
    for (let j = 0; j < batch.length; j++) {
      if (!DONE.has(results?.[j]?.status)) continue; // refused (quota, unknown space yet): the app shows it
      await storage.remove(batch[j].key);
      done++;
    }
  }
  return { sent, done };
}

/**
 * Asks the relay what woke this device and shows it.
 * @param {object} scope - the worker global (`self`)
 * @param {object} storage
 * @param {{texts?: object, open?: string, icon?: string, badge?: string, fetch?: typeof fetch}} [options]
 * @returns {Promise<number>} notifications shown
 */
export async function showPending(scope, storage, { texts = DEFAULT_TEXTS, open = '/', icon, badge, fetch: fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const t = { ...DEFAULT_TEXTS, ...texts };
  const extra = { ...(icon ? { icon } : {}), ...(badge ? { badge } : {}) };
  let spaces = [];
  try {
    const origin = await storage.get('bg/relay');
    const endpoint = (await scope.registration.pushManager.getSubscription())?.endpoint;
    if (origin && endpoint) {
      const res = await fetchImpl(`${origin}/push/pending`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint }) });
      if (res.ok) spaces = (await res.json()).spaces ?? [];
    }
  } catch {} // offline again, relay down: the generic notification below
  const labels = (await storage.get('push/labels').catch(() => null)) ?? {};
  const url = (param, sid) => `${open}${open.includes('?') ? '&' : '?'}${param}=${sid}`;
  for (const { sid, count, kind } of spaces) {
    const label = labels[sid] ?? sid.slice(0, 8);
    if (kind === 'call') {
      const { title, body } = t.call(label);
      await scope.registration.showNotification(title, { body, tag: `qu-call-${sid}`, renotify: true, requireInteraction: true, data: { sid, kind, url: url('qu-call', sid) }, ...extra });
    } else {
      const { title, body } = t.message(label, count);
      await scope.registration.showNotification(title, { body, tag: `qu-${sid}`, renotify: true, data: { sid, kind: 'message', url: url('qu-space', sid) }, ...extra });
    }
  }
  if (!spaces.length) {
    const { title, body } = t.fallback();
    await scope.registration.showNotification(title, { body, tag: 'qu', data: { url: open }, ...extra });
  }
  return Math.max(1, spaces.length);
}

/** Focuses an open window of the app (and tells it) or opens one. */
export async function openFromNotification(scope, notification) {
  const data = notification?.data ?? {};
  notification?.close?.();
  const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => 'focus' in c);
  if (client) {
    client.postMessage({ type: 'qu-notification', sid: data.sid, kind: data.kind });
    return client.focus();
  }
  return scope.clients.openWindow?.(data.url ?? '/');
}

/**
 * Installs the handlers on a service worker global.
 * @param {{scope?: object, db?: string, store?: string, open?: string, icon?: string, badge?: string, texts?: object}} [options]
 *   `db`: the app's database name (`createClient({ name })`, default 'qu-lite').
 */
export function quServiceWorker({ scope = globalThis.self, db = 'qu-lite', store = 'kv', open = '/', icon, badge, texts } = {}) {
  let storage = null;
  const driver = () => (storage ??= indexedDbDriver({ name: db, store }));
  scope.addEventListener('sync', (event) => {
    if (event.tag === OUTBOX_TAG) event.waitUntil(deliverOutbox(driver()));
  });
  scope.addEventListener('push', (event) => {
    event.waitUntil(showPending(scope, driver(), { open, icon, badge, texts }));
  });
  scope.addEventListener('notificationclick', (event) => {
    event.waitUntil(openFromNotification(scope, event.notification));
  });
  return { deliverOutbox: () => deliverOutbox(driver()), showPending: () => showPending(scope, driver(), { open, icon, badge, texts }) };
}
