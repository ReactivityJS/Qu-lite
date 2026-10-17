/**
 * 03 - A mirror over WebSocket, persistent clients, reload from disk (Node).
 *
 *   node examples/03-mirror-websocket.mjs
 *
 * A mirror/relay is an ordinary peer built by the same `createPeer()` - it
 * stores and forwards sealed envelopes and verifies their signatures, but
 * holds no space key and never reads anything. Clients keep their identity,
 * data and outbox in SQLite (browser: 'indexeddb'), so a restart loses nothing.
 * In production run `npx qu-lite-mirror` or `docker compose up` instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer, Space } from '@qu/lite';
import { nodeRegistry } from '@qu/lite/node';

const dir = mkdtempSync(join(tmpdir(), 'qu-lite-example-'));
const until = async (check) => { while (!(await check())) await new Promise((r) => setTimeout(r, 20)); };

// The mirror: SQLite + mirror policy + one HTTP port for WebSocket (and SSE).
const mirror = await createPeer({
  registry: nodeRegistry(),
  store: ['sqlite', { path: join(dir, 'mirror.sqlite') }],
  plugins: [['limits', { frames: { rate: 200, burst: 400 } }], ['sync', { role: 'mirror' }], ['mirror', { quota: { records: 10_000 } }]],
  transports: [['ws-server', { port: 0 }]],                     // 0 = any free port
});
const { port } = await mirror.transports['ws-server'].ready;
const url = `ws://localhost:${port}`;
console.log('mirror listening on', url);

// A client; `ackFrom: 'mirror'` keeps the outbox until a MIRROR stored a write.
const client = (name) =>
  createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', { path: join(dir, `${name}.sqlite`) }],     // identity: 'persisted' (default)
    plugins: ['records', ['sync', { ackFrom: 'mirror' }]],
    transports: [['ws', { connect: [url] }]],                     // reconnects with backoff
  });

let alice = await client('alice');
const bob = await client('bob');
const sa = alice.join(await Space.create(alice.identity));        // write keys are announced to mirrors
const sb = bob.join(await Space.open(sa.invite));
await alice.watch({ space: sa });
await bob.watch({ space: sb });

await alice.write(sa, 'notes', 'stored at the mirror, sealed');
await until(async () => (await alice.syncStatus()).outbox === 0);
console.log('mirror holds', await mirror.mirror.count(sa.id), 'envelope(s) of', sa.id.slice(0, 12), '- and no key');
await until(async () => (await bob.query({ space: sb, path: 'notes' })).length === 1);
console.log('bob got it through the mirror');

// "Reload": close alice and start again from the same database.
const aliceId = alice.identity.publicKey.join();
alice.transports.ws.disconnect();
alice.root.close();
alice = await client('alice');
console.log('same identity after reload:', alice.identity.publicKey.join() === aliceId);
const again = alice.join(await Space.open(sa.invite));            // apps keep the invite (members() does it for you)
console.log('notes after reload:', (await alice.query({ space: again, path: 'notes' })).map((r) => r.value));

for (const qu of [alice, bob]) {
  qu.transports.ws.disconnect();
  qu.root.close();
}
await mirror.transports['ws-server'].close();
mirror.root.close();
rmSync(dir, { recursive: true, force: true });
