/**
 * Qu Lite browser demo: one profile per `?name=` (own IndexedDB, own
 * identity), a relay on the same origin (`/ws`), a user node with public
 * and private fields, encrypted groups with members and roles, invites by
 * link or by pubkey (inbox), removing members (new epoch), a live event log
 * and the raw stored envelope.
 *
 *   ?name=alice      profile (default "default")
 *   &offline         start without connecting
 *   &relay=ws://…    another relay
 *   #g=<sid>         open a known group      #i=<invite>  accept an invite link
 */
import { createPeer, peekEnvelope, crypto } from '../src/index.js';

const params = new URLSearchParams(location.search);
const profile = params.get('name') || 'default';
const relayUrl = params.get('relay') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const $ = (id) => document.getElementById(id);
const short = (hex) => (hex ? `${hex.slice(0, 8)}…` : '–');
const el = (tag, text, attrs = {}) => Object.assign(document.createElement(tag), { textContent: text ?? '', ...attrs });
const toUrl = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (text) => JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));

const qu = await createPeer({
  store: ['indexeddb', { name: `qu-lite-demo-${profile}` }],
  plugins: ['records', 'user', 'members', 'inbox', ['sync', { ackFrom: 'mirror', releaseMs: 5000 }]],
  transports: [['ws', { connect: params.has('offline') ? [] : [relayUrl], minDelayMs: 300 }]],
});
globalThis.qu = qu; // for the console and the e2e test

// ---------------------------------------------------------------- event log
const lines = [];
const describe = (payload) => {
  const text = JSON.stringify(payload ?? null, (_k, v) => (v instanceof Uint8Array ? `<${v.length} B>` : v?.constructor?.name === 'Space' ? `<space ${v.id.slice(0, 8)}>` : v));
  return text && text.length > 160 ? `${text.slice(0, 157)}…` : text;
};
function renderLog() {
  const filter = $('filter').value.trim();
  $('log').textContent = lines.filter((l) => !filter || l.includes(filter)).slice(-300).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}
qu.bus.on('**', (payload, ctx) => {
  lines.push(`${new Date().toISOString().slice(11, 23)} ${ctx.topic} ${describe(payload)}`);
  if (lines.length > 1000) lines.splice(0, lines.length - 1000);
  queueMicrotask(renderLog);
});
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
qu.bus.on('net.peer.*', renderStatus);
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
  const node = await qu.user($('lookup').value.trim());
  const show = async () => ($('lookupResult').textContent = JSON.stringify(await node.fields(), null, 2));
  qu.bus.on(`qu.record.${node.space.id}`, show);
  await show();
});

// ---------------------------------------------------------------- groups
let space = null;
let manager = null;
const known = new Map((await qu.restoreGroups()).map((s) => [s.id, s]));

async function renderGroupList() {
  $('groups').replaceChildren(el('option', '– Gruppe wählen –', { value: '' }));
  for (const [sid, s] of known) {
    const title = (await qu.get(s, 'meta', 'title')) || `Gruppe ${short(sid)}`;
    $('groups').append(el('option', title, { value: sid, selected: sid === space?.id }));
  }
}

async function openGroup(target) {
  if (space?.id === target.id) return;
  space = target;
  known.set(space.id, space);
  manager = await qu.members(space);
  if (location.hash !== `#g=${space.id}`) history.replaceState(null, '', `#g=${space.id}`);
  $('sid').textContent = `sid ${short(space.id)}`;
  $('invite').value = '';
  qu.bus.on(`qu.record.${space.id}`, scheduleRender);
  qu.bus.on('qu.members.*', scheduleRender);
  await renderGroupList();
  await renderGroup();
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderGroup, 30);
}

async function renderGroup() {
  if (!space) return;
  const title = await qu.get(space, 'meta', 'title');
  if (document.activeElement !== $('title')) $('title').value = title ?? '';
  const people = manager.list();
  const names = Object.fromEntries(people.map((p) => [p.alias, p.name ? `${p.name} ✓` : `alias ${short(p.alias)}`]));
  const windowMs = Number($('window').value);
  const messages = await qu.query({ space, path: 'chat', from: windowMs ? Date.now() - windowMs : undefined });
  $('chat').replaceChildren(
    ...messages.map((m) => {
      const li = el('li', `${new Date(Number(m.hlc.slice(0, 13))).toLocaleTimeString()}  ${names[m.author] ?? `alias ${short(m.author)}`}: ${m.value}`);
      li.dataset.id = m.id;
      return li;
    })
  );

  $('epoch').textContent = `Epoche ${space.epoch}`;
  const myRole = manager.role();
  $('banner').textContent = myRole === 'removed' ? 'Du wurdest entfernt – neue Nachrichten sind für dich nicht mehr lesbar.' : '';
  $('members').replaceChildren(
    ...people.map((p) => {
      const li = el('li');
      li.append(el('span', `${names[p.alias]}${p.me ? ' (ich)' : ''} · ${p.role}`));
      if (!p.me && manager.isAdmin() && p.role !== 'removed' && p.role !== 'owner') {
        li.append(el('button', 'Entfernen', { className: 'secondary', onclick: () => manager.remove(p.alias).then(scheduleRender) }));
      }
      if (!p.me && manager.me === space.ownerId && p.role === 'member') {
        li.append(el('button', 'Admin', { className: 'secondary', onclick: () => manager.promote(p.alias, 'admin').then(scheduleRender) }));
      }
      return li;
    })
  );
}

$('groups').addEventListener('change', () => known.get($('groups').value) && openGroup(known.get($('groups').value)));
$('newGroup').addEventListener('click', async () => openGroup(await qu.createGroup()));
$('makeLink').addEventListener('click', async () => {
  if (!space) return;
  const invite = await manager.invite();
  $('invite').value = `${location.origin}${location.pathname}#i=${toUrl(invite)}`;
});
$('invitePubBtn').addEventListener('click', async () => {
  if (!space || !$('invitePub').value.trim()) return;
  await manager.invite($('invitePub').value.trim());
  $('invitePub').value = '';
});
$('send').addEventListener('click', async () => {
  if (!space || !$('msg').value) return;
  await qu.write(space, 'chat', $('msg').value);
  $('msg').value = '';
});
$('msg').addEventListener('keydown', (e) => e.key === 'Enter' && $('send').click());
$('saveTitle').addEventListener('click', async () => {
  if (!space) return;
  await qu.write(space, 'meta', $('title').value, { key: 'title' });
  renderGroupList();
});
$('window').addEventListener('change', renderGroup);
$('reveal').addEventListener('click', async () => space && manager.reveal({ name: await me.get('name') }));
$('chat').addEventListener('click', async (event) => {
  const id = event.target.closest('li')?.dataset.id;
  if (!id) return;
  const bytes = await qu.storage.get(`rec/${space.id}/${id}`);
  $('raw').textContent = `${JSON.stringify(peekEnvelope(bytes), null, 1)}\n${bytes.length} Bytes, so liegen sie lokal und beim Relay:\n${crypto.toHex(bytes).slice(0, 600)}…`;
});

// ---------------------------------------------------------------- inbox
const pending = new Map();
function renderInbox() {
  $('inbox').replaceChildren(
    ...[...pending.values()].map((msg) => {
      const li = el('li');
      li.append(el('span', `Einladung in eine Gruppe (${new Date(msg.at).toLocaleTimeString()})`));
      li.append(
        el('button', 'Annehmen', {
          onclick: async () => {
            pending.delete(msg.id);
            await qu.storage.set(`demo/accepted/${msg.id}`, 1);
            renderInbox();
            await openGroup(await qu.acceptInvite(msg.payload));
          },
        })
      );
      return li;
    })
  );
}
const onMessage = async (msg) => {
  if (msg.payload?.type !== 'invite' || (await qu.storage.has(`demo/accepted/${msg.id}`))) return;
  pending.set(msg.id, msg);
  renderInbox();
};
qu.bus.on('qu.inbox.message', onMessage);
for (const msg of await qu.inbox.messages()) await onMessage(msg);

// ---------------------------------------------------------------- start
async function fromHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('i')) await openGroup(await qu.acceptInvite(fromUrl(hash.get('i'))));
  else if (hash.get('g') && known.has(hash.get('g'))) await openGroup(known.get(hash.get('g')));
}
window.addEventListener('hashchange', fromHash);
await fromHash();
if (!space && known.size) await openGroup([...known.values()][0]);
await renderGroupList();
renderStatus();
document.body.dataset.ready = 'true';
