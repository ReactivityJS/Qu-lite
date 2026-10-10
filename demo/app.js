/**
 * Qu Lite browser demo: one profile per `?name=` (own IndexedDB, own
 * identity), a relay on the same origin (`/ws`), a user node with public and
 * private fields, an encrypted group (secret only in the URL #hash) with
 * chat + title, live network/sync event log and the raw stored envelope.
 *
 *   ?name=alice      profile (default "default")
 *   &offline         start without connecting
 *   &relay=ws://…    another relay
 */
import { QuCrypto } from '@qu/core';
import { createPeer, Space, peekEnvelope } from '../src/index.js';

const params = new URLSearchParams(location.search);
const profile = params.get('name') || 'default';
const relayUrl = params.get('relay') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const short = (hex) => (hex ? `${hex.slice(0, 8)}…` : '–');

const qu = await createPeer({
  store: ['indexeddb', { name: `qu-lite-demo-${profile}` }],
  plugins: ['records', 'user', ['sync', { ackFrom: 'mirror', releaseMs: 5000 }]],
  transports: [['ws', { connect: params.has('offline') ? [] : [relayUrl], minDelayMs: 300 }]],
});
globalThis.qu = qu; // for the console and the e2e test

// ---------------------------------------------------------------- event log
const lines = [];
const describe = (payload) => {
  const text = JSON.stringify(payload ?? null, (_k, v) => (v instanceof Uint8Array ? `<${v.length} B>` : v instanceof Map ? Object.fromEntries(v) : v));
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};
function renderLog() {
  const filter = $('filter').value.trim();
  $('log').textContent = lines.filter((l) => !filter || l.includes(filter)).slice(-300).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}
// Tap emit() and notify() so every topic is logged with its name (wildcard
// listeners only see the topic for emit()).
const record = (topic, payload) => {
  lines.push(`${new Date().toISOString().slice(11, 23)} ${topic} ${describe(payload)}`);
  if (lines.length > 1000) lines.splice(0, lines.length - 1000);
  queueMicrotask(renderLog);
};
for (const method of ['emit', 'notify']) {
  const original = qu.bus[method].bind(qu.bus);
  qu.bus[method] = (topic, payload, ...rest) => {
    record(topic, payload);
    return original(topic, payload, ...rest);
  };
}
$('filter').addEventListener('input', renderLog);

// ---------------------------------------------------------------- status bar
$('profile').textContent = profile;
$('netid').textContent = qu.peerId;
async function renderStatus() {
  const [conn] = qu.transports.ws.status();
  $('conn').textContent = conn?.connected ? 'verbunden' : conn ? 'verbinde…' : 'getrennt';
  $('conn').className = `pill ${conn?.connected ? 'on' : 'off'}`;
  $('relay').textContent = conn?.peer ?? '–';
  $('toggle').textContent = conn ? 'Trennen' : 'Verbinden';
  const { outbox, pending } = await qu.syncStatus();
  $('outbox').textContent = outbox;
  $('pending').textContent = pending;
}
setInterval(renderStatus, 500);
for (const topic of ['net.peer.up', 'net.peer.down']) qu.bus.on(topic, renderStatus);
$('toggle').addEventListener('click', () => {
  if (qu.transports.ws.status().length) qu.transports.ws.disconnect();
  else qu.transports.ws.connect(relayUrl);
  renderStatus();
});

// ---------------------------------------------------------------- user node
const me = await qu.me();
$('mypub').textContent = me.id;
$('name').value = (await me.get('name')) ?? '';
$('note').value = (await me.getPrivate('note')) ?? '';
$('saveName').addEventListener('click', () => me.set('name', $('name').value));
$('saveNote').addEventListener('click', () => me.set('note', $('note').value, { visibility: 'private' }));
$('doLookup').addEventListener('click', async () => {
  const pub = $('lookup').value.trim();
  const node = await qu.user(pub);
  const show = async () => ($('lookupResult').textContent = JSON.stringify(await node.fields(), null, 2));
  qu.bus.on(`qu.record.${node.space.id}`, show);
  await show();
});

// ---------------------------------------------------------------- group
let space = null;
let currentSecret = null;
const revealMessage = (sid, alias) => enc.encode(`qu-lite/reveal\n${sid}\n${alias}`);

async function openGroup(secretHex) {
  if (currentSecret === secretHex) return;
  currentSecret = secretHex;
  space = qu.join(await Space.open(QuCrypto.fromHex(secretHex)));
  $('sid').textContent = `sid ${short(space.id)}`;
  $('invite').value = `${location.origin}${location.pathname}#s=${secretHex}`;
  qu.bus.on(`qu.record.${space.id}`, scheduleRender);
  if ((await me.getPrivate('lastGroup')) !== secretHex) await me.set('lastGroup', secretHex, { visibility: 'private' });
  await renderGroup();
  await qu.watch({ space });
  await renderGroup();
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderGroup, 30);
}

/** alias (hex) -> display name, only for verified reveals. */
async function revealedNames() {
  const names = {};
  for (const r of await qu.query({ space, path: '_reveal' })) {
    const { identity, name, proof } = r.value ?? {};
    if (r.key !== r.author || !identity || !proof) continue;
    const ok = await QuCrypto.verify(revealMessage(space.id, r.author), QuCrypto.fromBase64(proof), QuCrypto.fromHex(identity)).catch(() => false);
    if (ok) names[r.author] = `${name || short(identity)} ✓`;
  }
  return names;
}

async function renderGroup() {
  if (!space) return;
  const title = await qu.get(space, 'meta', 'title');
  if (document.activeElement !== $('title')) $('title').value = title ?? '';
  const windowMs = Number($('window').value);
  const messages = await qu.query({ space, path: 'chat', from: windowMs ? Date.now() - windowMs : undefined });
  const names = await revealedNames();
  $('chat').replaceChildren(
    ...messages.map((m) => {
      const li = document.createElement('li');
      li.dataset.id = m.id;
      li.textContent = `${new Date(Number(m.hlc.slice(0, 13))).toLocaleTimeString()}  ${names[m.author] ?? `alias ${short(m.author)}`}: ${m.value}`;
      return li;
    })
  );
}

$('newGroup').addEventListener('click', async () => {
  const fresh = await Space.create();
  location.hash = `s=${QuCrypto.toHex(fresh.secret)}`;
});
window.addEventListener('hashchange', () => {
  const secret = new URLSearchParams(location.hash.slice(1)).get('s');
  if (secret) openGroup(secret);
});
$('send').addEventListener('click', async () => {
  if (!space || !$('msg').value) return;
  await qu.write(space, 'chat', $('msg').value);
  $('msg').value = '';
});
$('msg').addEventListener('keydown', (e) => e.key === 'Enter' && $('send').click());
$('saveTitle').addEventListener('click', () => space && qu.write(space, 'meta', $('title').value, { key: 'title' }));
$('window').addEventListener('change', renderGroup);
$('reveal').addEventListener('click', async () => {
  if (!space) return;
  const alias = QuCrypto.toHex((await space.authorFor(qu.identity)).publicKey);
  const proof = QuCrypto.toBase64(await QuCrypto.sign(revealMessage(space.id, alias), qu.identity.privateKey));
  await qu.write(space, '_reveal', { identity: me.id, name: await me.get('name'), proof }, { key: alias });
});
$('chat').addEventListener('click', async (event) => {
  const id = event.target.closest('li')?.dataset.id;
  if (!id) return;
  const bytes = await qu.storage.get(`rec/${space.id}/${id}`);
  const hex = QuCrypto.toHex(bytes);
  $('raw').textContent = `${JSON.stringify(peekEnvelope(bytes), null, 1)}\n${bytes.length} Bytes, so liegen sie lokal und beim Relay:\n${hex.slice(0, 600)}…`;
});

const initial = new URLSearchParams(location.hash.slice(1)).get('s') ?? (await me.getPrivate('lastGroup'));
if (initial) {
  if (!location.hash) location.hash = `s=${initial}`;
  await openGroup(initial);
}
renderStatus();
document.body.dataset.ready = 'true';
