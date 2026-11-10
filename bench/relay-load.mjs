#!/usr/bin/env node
/**
 * Relay load during a reconnect storm: a mirror on a SQLite file holds
 * SPACES spaces x RECORDS records; CLIENTS devices that already hold all of
 * it reconnect at the same moment (as after a relay restart). Reports how
 * often the mirror loaded a sync index, the time spent in those loads, the
 * longest event-loop stall, and the time until every device is in sync.
 * Then one record changes per space and the storm repeats.
 *
 *   node bench/relay-load.mjs [clients] [records] [spaces]
 *   DIGEST=0 / PULL=0 switch those paths off.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQu, records, sync, Space, connectInProcess, memoryDriver } from '../src/index.js';
import { sqliteDriver } from '../src/node.js';

const CLIENTS = Number(process.argv[2] ?? 20);
const RECORDS = Number(process.argv[3] ?? 20_000);
const SPACES = Number(process.argv[4] ?? 1);
const options = { releaseMs: 0, timeoutMs: 60_000, retryMs: 0, digest: process.env.DIGEST !== '0', pull: process.env.PULL !== '0' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function peer(root, extra = {}) {
  const qu = await createQu({ root });
  qu.use(records());
  qu.use(sync({ ...options, ...extra }));
  return qu;
}

/** Counts the mirror's sync-index loads (`sync.index` events). */
function indexMeter(qu) {
  const m = { loads: 0, items: 0, ms: 0, hits: 0 };
  qu.bus.on('sync.index', ({ items, ms, cached }) => {
    if (cached) return void m.hits++;
    m.loads++;
    m.items += items;
    m.ms += ms;
  });
  return m;
}

const dir = mkdtempSync(join(tmpdir(), 'qu-relay-load-'));
const mirror = await peer(sqliteDriver({ path: join(dir, 'mirror.sqlite') }), { role: 'mirror' });
const meter = indexMeter(mirror);

// one writer fills the spaces and uploads them in-process (no rate limit)
const seed = await peer(memoryDriver(), { ackFrom: 'mirror' });
const invites = [];
const seeded = [];
for (let s = 0; s < SPACES; s++) {
  const space = await Space.create(seed.identity);
  invites.push(space.invite);
  await mirror.watch({ space: mirror.join(await Space.open(space.invite)) });
  const mine = seed.join(space);
  seeded.push(mine);
  for (let i = 0; i < RECORDS; i++) await seed.write(mine, 'chat', i);
}
let link = connectInProcess(seed, mirror);
await link.ready;
while ((await seed.syncStatus()).outbox) await pause(100);
await link.disconnect();

// CLIENTS devices with a copy of everything (cloned stores, own network ids)
const snapshot = await seed.storage.range('');
const devices = [];
for (let c = 0; c < CLIENTS; c++) {
  const root = memoryDriver();
  for (const { key, value } of snapshot) if (key !== 'qu/net-id') await root.set(key, value);
  const qu = await peer(root, { ackFrom: 'mirror' });
  const joined = [];
  for (const invite of invites) joined.push(qu.join(await Space.open(invite)));
  for (const space of joined) qu.watch({ space });
  devices.push({ qu, joined });
}
console.log(`# ${CLIENTS} devices, ${SPACES} space(s) x ${RECORDS} records, mirror on SQLite; digest ${options.digest}, pull ${options.pull}`);

async function storm(name) {
  Object.assign(meter, { loads: 0, items: 0, ms: 0, hits: 0 });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const started = performance.now();
  const links = devices.map(({ qu }) => connectInProcess(qu, mirror));
  await Promise.all(links.map((l) => l.ready));
  for (const { qu } of devices) while ((await qu.syncStatus()).pending || (await qu.syncStatus()).outbox) await pause(20);
  const total = performance.now() - started;
  lag.disable();
  console.log(
    `${name.padEnd(36)} ${(total / 1000).toFixed(2)} s | mirror index loads ${meter.loads} (${meter.items} items, ${meter.ms.toFixed(0)} ms), cache hits ${meter.hits} | longest stall ${(lag.max / 1e6).toFixed(0)} ms`
  );
  await Promise.all(links.map((l) => l.disconnect()));
}

await storm('reconnect, nothing changed');
// one new record per space on the mirror (from the seed), then everyone reconnects
for (const mine of seeded) await seed.write(mine, 'chat', 'new');
link = connectInProcess(seed, mirror);
await link.ready;
while ((await seed.syncStatus()).outbox) await pause(50);
await link.disconnect();
await storm('reconnect, 1 new record per space');

await Promise.all([...devices.map(({ qu }) => qu.close()), seed.close(), mirror.close()]);
rmSync(dir, { recursive: true, force: true });
