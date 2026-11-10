#!/usr/bin/env node
/**
 * A big first upload against a real relay with its default inbound rate
 * limit (200 frames/s, burst 400; 1 MiB/s, burst 4 MiB): how long until the
 * outbox is empty, how many frames the relay dropped, how often it closed
 * the link. Run: node bench/upload-rate.mjs [records] [valueBytes]
 * LIVE=1: connect first, then write (an import while online: live records).
 */
import { createRelay } from '../src/node.js';
import { createClient, Space } from '../src/index.js';

const N = Number(process.argv[2] ?? 2000);
const SIZE = Number(process.argv[3] ?? 200);
const relay = await createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
let dropped = 0;
let closed = 0;
relay.qu.bus.on('net.limited', (e) => {
  dropped++;
  if (e.closed) closed++;
});
// relay transport installed, but connected only once the outbox is full
const client = await createClient({ devtools: false, transports: [['relay', { WebSocketImpl: WebSocket, minDelayMs: 200 }]] });
const space = client.join(await Space.create(client.identity));
await client.watch({ space });
let connects = 0;
client.bus.on('net.peer.up', () => connects++);
const write = async () => {
  for (let i = 0; i < N; i++) await client.write(space, 'chat', { i, text: 'x'.repeat(SIZE) });
};
const connect = () => client.transports.relay.connect(`http://127.0.0.1:${relay.port}`);
let started = Date.now();
if (process.env.LIVE) {
  connect();
  while (!connects) await new Promise((r) => setTimeout(r, 20));
  started = Date.now();
  await write();
} else {
  await write();
  started = Date.now();
  connect();
}
let last = -1;
while (true) {
  const { outbox } = await client.syncStatus();
  if (outbox === 0) break;
  if (Date.now() - started > 180_000) {
    console.log('gave up after 180 s, outbox', outbox);
    break;
  }
  if (outbox !== last && process.env.VERBOSE) console.log(((Date.now() - started) / 1000).toFixed(1), 's outbox', outbox);
  last = outbox;
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`${N} records: ${((Date.now() - started) / 1000).toFixed(1)} s, relay dropped ${dropped} frames, closed the link ${closed}x, connects ${connects}`);
await client.close();
await relay.close();
