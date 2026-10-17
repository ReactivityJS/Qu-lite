/**
 * Start page of a relay (index.html): checks the connection from this
 * browser to the relay that serves it and shows how an app connects.
 * Unbundled on purpose - it imports the library exactly like an app would,
 * from the relay's `dist/qu-lite.js`.
 *
 * The relay's base URL is this page's directory, so the page works behind a
 * reverse proxy, also under a path prefix (https://example.org/qu/).
 */
import { createPeer, Space } from './dist/qu-lite.js';

const $ = (id) => document.getElementById(id);
const base = new URL('.', location.href).href.replace(/\/$/, '');
const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;

$('base').textContent = base;
$('endpoints').textContent = `${wsUrl} · ${base}/sse`;
$('snippet').textContent = `import { createPeer } from '${base}/dist/qu-lite.js';

// identity and data stay on the device (IndexedDB)
// relay: WebSocket, falls back to HTTPS + SSE on the same address
const qu = await createPeer({
  store: ['indexeddb', { name: 'my-app' }],
  plugins: ['records', 'user', 'members', 'inbox',
            ['sync', { ackFrom: 'mirror' }], 'status', 'compaction'],
  transports: [['relay', { url: '${base}' }]],
});
const group = await qu.createGroup();
await qu.write(group, 'chat', 'hallo');`;

fetch(`${base}/info`, { cache: 'no-store' })
  .then((r) => r.json())
  .then((info) => ($('info').textContent = `${info.name} ${info.version} · ${info.transports.join(' + ')} · läuft seit ${Math.round(info.uptime / 60)} min`))
  .catch(() => ($('info').textContent = 'nicht erreichbar'));

const preference = (() => {
  try {
    return localStorage.getItem('qu-start-transport') ?? 'auto';
  } catch {
    return 'auto';
  }
})();
$('transport').value = preference;

// A throwaway peer: memory only, nothing is kept in this browser.
const qu = await createPeer({
  plugins: ['records', ['sync', { ackFrom: 'mirror' }]],
  transports: [['relay', { url: base, minDelayMs: 300, prefer: preference === 'sse' ? 'sse' : 'ws' }]],
});

function render() {
  const [conn] = qu.transports.relay.status();
  $('conn').textContent = conn?.connected ? 'verbunden' : conn ? 'verbinde…' : 'getrennt';
  $('conn').className = `pill ${conn?.connected ? 'on' : 'off'}`;
  $('via').textContent = conn?.via ?? '–';
  $('relay').textContent = conn?.peer ?? '–';
}
for (const topic of ['net.peer.up', 'net.peer.down', 'net.connecting', 'net.relay.transport']) qu.bus.on(topic, () => queueMicrotask(render));
render();

$('transport').addEventListener('change', () => {
  try {
    localStorage.setItem('qu-start-transport', $('transport').value);
  } catch {}
  location.reload(); // the transport preference is read at start
});
$('reconnect').addEventListener('click', () => {
  qu.transports.relay.disconnect();
  qu.transports.relay.connect(base);
  render();
});

// Round trip: a record in a fresh space, acknowledged by the relay as a mirror.
$('storeTest').addEventListener('click', async () => {
  const out = $('store');
  out.className = 'muted';
  out.textContent = 'schreibe …';
  const started = performance.now();
  try {
    const space = qu.join(await Space.create(qu.identity));
    const record = await qu.write(space, 'test', { at: Date.now() });
    const deadline = Date.now() + 10_000;
    while ((await qu.syncState(space.id, record.id)) !== 'sent') {
      if (Date.now() > deadline) throw new Error('keine Bestätigung vom Relay innerhalb von 10 s');
      await new Promise((r) => setTimeout(r, 50));
    }
    out.textContent = `gespeichert und bestätigt in ${Math.round(performance.now() - started)} ms`;
    out.className = '';
    out.dataset.ok = 'true';
  } catch (error) {
    out.textContent = `fehlgeschlagen: ${error.message}`;
    out.dataset.ok = 'false';
  }
});
document.body.dataset.ready = 'true';
