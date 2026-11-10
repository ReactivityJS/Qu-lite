#!/usr/bin/env node
/**
 * A fast uploader against a relay that processes slowly (2 ms per record):
 * how many frames the relay works on at once, its peak heap, whether it
 * paused reading. Run: node bench/inbound-load.mjs [records] [valueBytes]
 * UNBOUNDED=1 restores the old behaviour (no inflight limit, no pause).
 */
import { createRelay } from '../src/node.js';
import { createClient, Space } from '../src/index.js';

const N = Number(process.argv[2] ?? 1200);
const SIZE = Number(process.argv[3] ?? 8000);
let running = 0;
let most = 0;
const slowIngest = (qu) => {
  qu.bus.on(
    'net.in.*.rec',
    async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
    },
    { order: -1 }
  );
};
const relay = await createRelay({ port: 0, host: '127.0.0.1', log: () => {}, rate: 0, extra: [slowIngest] });
if (process.env.UNBOUNDED) (await import('../src/net/link.js')).netOf(relay.qu).maxInflight = Infinity;
let paused = 0;
relay.qu.bus.on('net.paused', () => paused++);
let heap = 0;
const sample = setInterval(() => (heap = Math.max(heap, process.memoryUsage().heapUsed)), 5);
const client = await createClient({ devtools: false, transports: [['relay', { WebSocketImpl: WebSocket, minDelayMs: 50 }]] });
const space = client.join(await Space.create(client.identity));
await client.watch({ space });
for (let i = 0; i < N; i++) await client.write(space, 'chat', { i, text: 'x'.repeat(SIZE) });
const base = process.memoryUsage().heapUsed;
heap = base;
const started = Date.now();
client.transports.relay.connect(`http://127.0.0.1:${relay.port}`);
while ((await client.syncStatus()).outbox) await new Promise((r) => setTimeout(r, 20));
clearInterval(sample);
console.log(
  `${process.env.UNBOUNDED ? 'unbounded' : 'bounded  '}: ${N} records in ${((Date.now() - started) / 1000).toFixed(1)} s | at once on the relay: ${most} | heap peak +${((heap - base) / 1048576).toFixed(0)} MiB | paused ${paused}x`
);
await client.close();
await relay.close();
