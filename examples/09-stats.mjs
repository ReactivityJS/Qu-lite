/**
 * 09 - Operating figures: traffic per connection, throughput, storage.
 *
 *   node examples/09-stats.mjs
 *
 * `stats()` is optional and costs nothing per frame: links count bytes and
 * frames anyway, the plugin only reads those counters and bus events. A
 * relay serves the same report as /stats (JSON) and /metrics (Prometheus)
 * when started with `--stats-token` (see docs/DEPLOY.md).
 */
import { createQu, records, sync, mirror, stats, Space, connectInProcess } from '@qu/lite';

const relay = await createQu();
relay.use(stats());
relay.use(sync({ role: 'mirror' }));
relay.use(mirror());

const alice = await createQu();
alice.use(stats({ windowMs: 5000, emitMs: 1000 }));   // throughput over 5 s, a `qu.stats` event every second
alice.use(records());
alice.use(sync({ ackFrom: 'mirror' }));
const space = alice.join(await Space.create(alice.identity));
await alice.watch({ space });
await connectInProcess(alice, relay).ready;

for (let i = 0; i < 50; i++) await alice.write(space, 'chat', `message ${i} ${'·'.repeat(500)}`);
while ((await alice.syncStatus()).outbox) await new Promise((r) => setTimeout(r, 20));

const { traffic, connections, peers, records: processed } = alice.stats.snapshot();
console.log('alice traffic:', traffic);
console.log('connections:', connections);
console.log('per peer:', peers.map(({ peer, via, bytesIn, bytesOut, outBps }) => ({ peer, via, bytesIn, bytesOut, outBps })));
console.log('local writes:', processed.local);
console.log('alice storage:', await alice.stats.storage());
console.log('relay storage:', await relay.stats.storage());
console.log('relay /metrics (excerpt):');
console.log((await relay.stats.prometheus()).split('\n').filter((l) => /^qu_lite_(received_bytes_total|connections|records|records_bytes) /.test(l)).join('\n'));
