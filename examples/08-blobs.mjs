/**
 * 08 - Attachments: chunked, encrypted, synced, fetched on demand.
 *
 *   node examples/08-blobs.mjs
 *
 * `blobs()` stores a file as ordinary records (manifest + chunks) in its own
 * shard of the space. The app links the returned ref in a message; a reader
 * fetches exactly that blob when it needs it. In a browser the plugin keeps
 * the screen awake and asks before the tab is closed while transfers run.
 */
import { createQu, records, sync, blobs, mirror, Space, connectInProcess } from '@qu/lite';

const until = async (check) => { while (!(await check())) await new Promise((r) => setTimeout(r, 10)); };

const relay = await createQu();
relay.use(sync({ role: 'mirror' }));
relay.use(mirror());

async function peer() {
  const qu = await createQu();
  qu.use(records());
  qu.use(sync({ ackFrom: 'mirror' }));              // an upload counts once a mirror stored it
  qu.use(blobs());                                    // chunkSize 64 KiB, maxBytes 64 MiB
  return qu;
}
const alice = await peer();
const bob = await peer();
const sa = alice.join(await Space.create(alice.identity));
const sb = bob.join(await Space.open(sa.invite));
await alice.watch({ space: sa });
await bob.watch({ space: sb, path: 'chat' });        // bob syncs messages only; blobs on demand

// Alice attaches a file while offline: it is stored locally and waits in the outbox.
const file = new Blob([new Uint8Array(300_000).map((_, i) => i % 251)], { type: 'application/octet-stream' });
const ref = await alice.blobs.put(sa, file, { name: 'measurements.bin' });
await alice.write(sa, 'chat', { text: 'here are the measurements', file: ref });
console.log('ref:', ref);
console.log('pending while offline:', alice.blobs.pending());

alice.bus.on('qu.blob.progress', ({ direction, done, total }) => done === total && console.log(`alice: ${direction}load complete (${done}/${total} records)`));
await connectInProcess(alice, relay).ready;          // in a browser: relayTransport / ws
await connectInProcess(bob, relay).ready;
await until(() => alice.blobs.pending().length === 0);

// Bob reads the message, then downloads the attachment (with progress).
await until(async () => (await bob.query({ space: sb, path: 'chat' })).length === 1);
const [message] = await bob.query({ space: sb, path: 'chat' });
bob.bus.on('qu.blob.progress', ({ done, total }) => console.log(`bob: ${done}/${total ?? '?'} chunks`));
const bytes = await bob.blobs.get(sb, message.value.file, { timeoutMs: 30_000 });
console.log('bob got', bytes.length, 'bytes of', message.value.file.name);
console.log('stored at bob:', await bob.blobs.has(sb, message.value.file));
// in a browser: URL.createObjectURL(new Blob([bytes], { type: ref.type }))

console.log('deleted records:', await alice.blobs.del(sa, ref));
