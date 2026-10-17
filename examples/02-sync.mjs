/**
 * 02 - Two peers sync a space: live, offline, and on reconnect.
 *
 *   node examples/02-sync.mjs
 *
 * `sync()` reconciles exactly what an app watches (Negentropy set
 * reconciliation - the cost grows with the difference, not the history).
 * Local writes wait in a durable outbox until a peer acknowledged them.
 * `connectInProcess` links two peers in one process; over a network use
 * `connectWs` / `relayTransport` (see 03-mirror-websocket.mjs).
 */
import { createQu, records, sync, Space, connectInProcess } from '@qu/lite';

async function peer(name) {
  const qu = await createQu();
  qu.use(records());
  qu.use(sync());
  qu.name = name;
  return qu;
}
const until = async (check) => { while (!(await check())) await new Promise((r) => setTimeout(r, 10)); };
const texts = async (qu, space) => (await qu.query({ space, path: 'chat' })).map((r) => r.value);

const alice = await peer('alice');
const bob = await peer('bob');

// Both open the same space: `space.invite` = {secret, owner}. Keep it secret -
// whoever holds it can read and write. (Groups with roles: 04-groups.mjs.)
const sa = alice.join(await Space.create(alice.identity));
const sb = bob.join(await Space.open(sa.invite));
await alice.watch({ space: sa });                      // what this app mounts
await bob.watch({ space: sb, path: 'chat' });          // or narrower: one path's shard

bob.bus.on(`qu.record.${sb.id}`, (rec) => console.log('bob got:', rec.value));

// 1. live
let link = connectInProcess(alice, bob);
await link.ready;
await alice.write(sa, 'chat', 'hi bob');
await until(async () => (await texts(bob, sb)).length === 1);

// 2. offline: both write while disconnected - the outbox keeps it
await link.disconnect();
await alice.write(sa, 'chat', 'written offline by alice');
await bob.write(sb, 'chat', 'written offline by bob');
console.log('alice outbox:', await alice.syncStatus());   // { outbox: n, pending: n }

// 3. reconnect: one reconcile per side transfers only the difference
link = connectInProcess(alice, bob);
await link.ready;
await until(async () => (await texts(alice, sa)).length === 3 && (await texts(bob, sb)).length === 3);
console.log('alice sees:', await texts(alice, sa));
console.log('bob sees:  ', await texts(bob, sb));

// Manual full resync of a scope, e.g. after restoring a backup:
console.log('resync:', (await alice.resync({ space: sa })).map(({ sent, received }) => ({ sent, received })));
await until(async () => (await alice.syncStatus()).outbox === 0);
console.log('alice outbox after ack:', await alice.syncStatus());
await link.disconnect();
