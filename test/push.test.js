import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient, crypto, deliverOutbox, showPending, openFromNotification, memoryDriver } from '../src/index.js';
import { createRelay } from '../src/node.js';
import { until, settle } from './helpers.js';

const quiet = () => {};
const b64urlBytes = (t) => crypto.fromBase64(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(t.length / 4) * 4, '='));

/** A stand-in push service: records every push, checks the VAPID signature. */
async function pushService() {
  const got = [];
  let status = 201;
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const [, jwt, key] = auth.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    let valid = false;
    if (jwt) {
      const [h, p, s] = jwt.split('.');
      const pub = await globalThis.crypto.subtle.importKey('raw', b64urlBytes(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      valid = await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
      const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(p)));
      valid &&= claims.sub === 'mailto:test@example.org' && /^https?:\/\/127\.0\.0\.1:/.test(claims.aud);
    }
    got.push({ path: req.url, valid, urgency: req.headers.urgency, ttl: req.headers.ttl, length: req.headers['content-length'] });
    res.writeHead(status).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { got, base: `http://127.0.0.1:${server.address().port}`, setStatus: (s) => (status = s), close: () => new Promise((ok) => server.close(ok)) };
}

/** A browser-ish push subscription for createClient's push plugin. */
function fakeServiceWorker(endpoint) {
  const subscription = { endpoint, options: {}, unsubscribe: async () => true };
  const registration = { pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } };
  return { getRegistration: async () => registration, addEventListener() {}, removeEventListener() {}, registration };
}

test('push: a closed device is woken without payload, learns what happened from the relay; calls are urgent', async () => {
  const service = await pushService();
  const relay = await createRelay({ port: 0, log: quiet, push: { subject: 'mailto:test@example.org', minIntervalMs: 5000 } });
  const url = `http://127.0.0.1:${relay.port}`;
  // the push service must be https in reality; the test relay accepts http only through this switch
  const endpoint = `${service.base}/push/abc`;
  const sw = fakeServiceWorker(endpoint.replace('http:', 'https:'));
  const realFetch = globalThis.fetch;
  const viaHttp = (input, init) => realFetch(String(input).replace(`https://127.0.0.1:${new URL(service.base).port}`, service.base), init);

  const anna = await createClient({ url, devtools: false });
  const ben = await createClient({ url, devtools: false, extra: [['push', { serviceWorker: sw, Notification: null, location: null }]] });
  const family = await anna.createGroup();
  await ben.acceptInvite(await (await anna.members(family)).invite());
  await until(async () => (await relay.qu.mirror.spaces()).includes(family.id), 5000, 'grant');

  relay.qu.pushRelay; // installed
  const accepted = await ben.push.enable([family], { labels: { [family.id]: 'Familie' } });
  assert.deepEqual(accepted, [family.id]);
  // route the relay's pushes to the stand-in service
  const sent = [];
  relay.qu.bus.on('push.sent', (e) => sent.push(e));

  // ben connected: nothing is pushed (he gets the records live)
  await anna.write(family, 'chat', 'hallo');
  await settle(400);
  assert.equal(service.got.length, 0, 'connected devices are not pushed');

  // ben closes the app
  ben.transports.relay.disconnect();
  await until(() => !relay.qu.net.links.has(ben.peerId), 3000, 'ben gone');
  globalThis.fetch = viaHttp;
  try {
    await anna.write(family, 'chat', 'eins');
    await anna.write(family, 'chat', 'zwei');
    await anna.write(family, 'chat', 'drei');
    await anna.write(family, '_receipts/x', 'not a chat record', { key: (await anna.members(family)).me });
    await until(() => service.got.length >= 1, 3000, 'pushed');
    await settle(500);
    assert.equal(service.got.length, 1, 'throttled: three messages, one push (the rest would follow after minIntervalMs)');
    assert.equal(service.got[0].valid, true, 'VAPID signature valid');
    assert.equal(service.got[0].length, '0', 'no payload');

    // the service worker asks what it was about and shows it (labels stay on the device)
    const shown = [];
    const scope = { registration: { pushManager: sw.registration.pushManager, showNotification: async (title, options) => shown.push({ title, ...options }) } };
    const store = memoryDriver();
    await store.set('bg/relay', url);
    await store.set('push/labels', { [family.id]: 'Familie' });
    globalThis.fetch = realFetch;
    await showPending(scope, store);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].title, 'Familie');
    assert.equal(shown[0].body, '3 new messages', 'receipts did not count (shard filter)');
    assert.equal(shown[0].data.url, `/?qu-space=${family.id}`);
    await showPending(scope, store);
    assert.equal(shown[1].title, 'New activity', 'nothing pending: a generic notification (browsers demand one)');

    // a call: urgent at once, no throttle
    globalThis.fetch = viaHttp;
    const annaPush = (await import('../src/push.js')).push({ serviceWorker: null, Notification: null, location: null, relay: url })(anna);
    assert.equal(await annaPush.ring(family), 1);
    await until(() => service.got.length >= 2, 3000, 'ring pushed');
    assert.equal(service.got[1].urgency, 'high');
    globalThis.fetch = realFetch;
    await showPending(scope, store);
    assert.equal(shown[2].tag, `qu-call-${family.id}`);
    assert.equal(shown[2].requireInteraction, true);
    assert.equal(shown[2].data.url, `/?qu-call=${family.id}`);

    // tapping it focuses an open window (and tells the app) or opens one
    const messages = [];
    const opened = [];
    const clientsScope = { clients: { matchAll: async () => [], openWindow: async (u) => opened.push(u) } };
    await openFromNotification(clientsScope, { data: shown[2].data, close() {} });
    assert.deepEqual(opened, [`/?qu-call=${family.id}`]);
    const windowScope = { clients: { matchAll: async () => [{ focus: async () => 'focused', postMessage: (m) => messages.push(m) }] } };
    await openFromNotification(windowScope, { data: shown[2].data, close() {} });
    assert.deepEqual(messages, [{ type: 'qu-notification', sid: family.id, kind: 'call' }]);

    // a forged ring (no write key) is refused
    const res = await realFetch(`${url}/push/ring`, { method: 'POST', body: JSON.stringify({ sid: family.id, epoch: 0, at: Date.now(), kind: 'call', sig: crypto.toBase64(new Uint8Array(64)) }) });
    assert.equal(res.status, 403);
    // a subscription without membership is not accepted
    const forged = await (await realFetch(`${url}/push/subscribe`, { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/x', spaces: [{ sid: family.id, epoch: 0, sig: crypto.toBase64(new Uint8Array(64)) }] }) })).json();
    assert.deepEqual(forged.accepted, []);

    // the push service says the subscription is gone: dropped
    service.setStatus(410);
    globalThis.fetch = viaHttp;
    await annaPush.ring(family);
    await until(() => relay.qu.pushRelay.size() === 1, 3000, 'gone subscription dropped');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(sent.length >= 2);
  await anna.close();
  await ben.close();
  await relay.close();
  await service.close();
});

test('background sync: the service worker delivers the outbox straight from storage', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const store = memoryDriver();
  const sw = { getRegistration: async () => ({ sync: { register: async (tag) => registered.push(tag) } }) };
  const registered = [];
  const wake = { requests: 0, request: async () => (wake.requests++, { release: async () => {}, addEventListener() {} }) };
  const a = await createClient({ url, store, devtools: false, extra: [['background', { serviceWorker: sw, wakeLock: wake }]] });
  assert.equal(await a.background.ready, true, 'Background Sync available');
  const group = await a.createGroup();
  await until(async () => (await a.syncStatus()).outbox === 0, 5000, 'idle');
  a.transports.relay.disconnect();
  const progress = [];
  a.bus.on('qu.sync.progress', (p) => progress.push(p));
  await a.write(group, 'chat', 'offline 1');
  await a.write(group, 'chat', 'offline 2');
  await until(() => progress.at(-1)?.records === 2, 3000, 'progress reported');
  assert.ok(progress.at(-1).bytes > 300);
  assert.deepEqual(registered, ['qu-outbox'], 'one background sync registered');
  assert.equal(wake.requests, 0, 'no wake lock: Background Sync does the job');

  // the tab is closed; the browser wakes the worker when the network is back
  const ids = (await store.keys(`sync/out/${group.id}/`)).map((k) => k.split('/').at(-1));
  const result = await deliverOutbox(store);
  assert.deepEqual(result, { sent: 2, done: 2 });
  assert.deepEqual(await store.keys('sync/out/'), []);
  for (const id of ids) assert.ok(await relay.qu.storage.has(`rec/${group.id}/${id}`));
  await a.close();
  await relay.close();
});

test('background: without Background Sync the screen is kept on while the outbox fills a connected link', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const wake = { held: 0, request: async () => (wake.held++, { release: async () => void wake.held--, addEventListener() {} }) };
  const a = await createClient({ url, devtools: false, extra: [['background', { serviceWorker: null, wakeLock: wake, debounceMs: 0 }]] });
  assert.equal(await a.background.ready, false);
  const group = await a.createGroup();
  await until(async () => (await a.syncStatus()).outbox === 0, 5000, 'idle');
  // hold the acks back so the outbox stays non-empty for a moment
  relay.qu.bus.on('net.out.*.ack', (_, ctx) => ctx.stop());
  await a.write(group, 'chat', 'x');
  await until(() => a.background.awake, 3000, 'awake while uploading');
  assert.equal(wake.held, 1);
  await a.close();
  await relay.close();
});

test('background: Background Sync switched off (site setting) falls back to the wake lock', async () => {
  const relay = await createRelay({ port: 0, log: quiet });
  const url = `http://127.0.0.1:${relay.port}`;
  const sw = { getRegistration: async () => ({ sync: { register: async () => { throw new Error('Background Sync is disabled.'); } } }) };
  const wake = { held: 0, request: async () => (wake.held++, { release: async () => void wake.held--, addEventListener() {} }) };
  const a = await createClient({ url, devtools: false, extra: [['background', { serviceWorker: sw, wakeLock: wake, debounceMs: 0 }]] });
  const reasons = [];
  a.bus.on('qu.background.unavailable', ({ reason }) => reasons.push(reason));
  const group = await a.createGroup();
  relay.qu.bus.on('net.out.*.ack', (_, ctx) => ctx.stop());
  await a.write(group, 'chat', 'x');
  await until(() => a.background.backgroundSync === false && a.background.awake, 3000, 'fallback');
  assert.deepEqual(reasons, ['Background Sync is disabled.']);
  await a.close();
  await relay.close();
});
