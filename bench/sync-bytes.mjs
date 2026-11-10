#!/usr/bin/env node
/**
 * Bytes on the wire per frame type for the common sync situations between a
 * client (ackFrom: 'mirror') and a mirror, over the production link code
 * (in-process byte channel). Run: node bench/sync-bytes.mjs [spaces] [records]
 * Compare: PULL=0 / DIGEST=0 switch the direct download / the digest pre-check off.
 *
 *   initial      client wrote everything offline, connects for the first time
 *   reconnect    nothing changed on either side
 *   offline+10   10 new local records per space, then reconnect
 *   fresh        a second device with no data joins all spaces
 */
import { createQu, createClock, records, sync, Space, connectInProcess, encodeFrame } from '../src/index.js';

const SPACES = Number(process.argv[2] ?? 20);
const RECORDS = Number(process.argv[3] ?? 200);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 300_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timeout');
    await settle(10);
  }
}

const time = { now: 1_759_999_980_000 };
async function peer(options = {}) {
  const qu = await createQu({ clock: createClock({ now: () => time.now }) });
  qu.use(records());
  qu.use(sync({ releaseMs: 0, timeoutMs: 10_000, retryMs: Number(process.env.RETRY ?? 0), pull: process.env.PULL !== '0', digest: process.env.DIGEST !== '0', ...options }));
  return qu;
}

/** Counts encoded frame bytes per type leaving `qu`. */
function meter(qu) {
  const by = {};
  qu.bus.on(
    'net.out.*.*',
    (payload, ctx) => {
      const type = ctx.topic.split('.')[3];
      const size = encodeFrame(type, payload).length;
      by[type] ??= { frames: 0, bytes: 0 };
      by[type].frames++;
      by[type].bytes += size;
    },
    { order: -1e9 }
  );
  // session outcomes show up as pseudo frame types (no bytes)
  qu.bus.on('sync.error', ({ error }) => {
    const key = `(sync.error ${error})`;
    by[key] ??= { frames: 0, bytes: 0 };
    by[key].frames++;
  });
  return {
    take() {
      const out = { ...by };
      for (const k of Object.keys(by)) delete by[k];
      return out;
    },
  };
}

function report(name, a, b) {
  const rows = {};
  for (const [side, data] of [['client', a], ['mirror', b]]) for (const [type, v] of Object.entries(data)) rows[`${side} ${type}`] = v;
  const total = Object.values(rows).reduce((s, v) => s + v.bytes, 0);
  const frames = Object.values(rows).reduce((s, v) => s + v.frames, 0);
  console.log(`\n## ${name}: ${(total / 1024).toFixed(1)} KiB in ${frames} frames`);
  console.table(rows);
  return total;
}

const mirror = await peer({ role: 'mirror' });
const client = await peer({ ackFrom: 'mirror' });
const mm = meter(mirror);
const cm = meter(client);

const secrets = [];
const spaces = [];
let payload = 0;
for (let s = 0; s < SPACES; s++) {
  const secret = (await Space.create()).invite;
  secrets.push(secret);
  const sm = mirror.join(await Space.open(secret));
  await mirror.watch({ space: sm });
  const sc = client.join(await Space.open(secret));
  spaces.push(sc);
  for (let i = 0; i < RECORDS; i++) {
    if (i % 20 === 0) time.now += 60_000;
    const { id } = await client.write(sc, 'chat', { text: `message ${i} in space ${s}`, n: i });
    payload += (await client.storage.get(`rec/${sc.id}/${id}`)).length;
  }
}
for (const sc of spaces) await client.watch({ space: sc });
mm.take();
cm.take();
console.log(`# ${SPACES} spaces x ${RECORDS} records, envelopes ${(payload / 1024).toFixed(1)} KiB`);

const done = () => until(async () => { const s = await client.syncStatus(); if (process.env.DEBUG) console.log(s); return s.outbox === 0 && s.pending === 0; });

let link = connectInProcess(client, mirror);
await link.ready;
await done();
await settle(100);
report('initial upload', cm.take(), mm.take());
await link.disconnect();

link = connectInProcess(client, mirror);
await link.ready;
await done();
await settle(100);
report('reconnect, nothing changed', cm.take(), mm.take());
await link.disconnect();

for (const sc of spaces) for (let i = 0; i < 10; i++) await client.write(sc, 'chat', { text: `offline ${i}` });
link = connectInProcess(client, mirror);
await link.ready;
await done();
await settle(100);
report('reconnect after 10 offline writes per space', cm.take(), mm.take());
await link.disconnect();

const fresh = await peer({ ackFrom: 'mirror' });
const fm = meter(fresh);
const freshSpaces = [];
for (const secret of secrets) freshSpaces.push(fresh.join(await Space.open(secret)));
link = connectInProcess(fresh, mirror);
await link.ready;
await Promise.all(freshSpaces.map((space) => fresh.watch({ space })));
await until(async () => (await fresh.storage.keys('rec/')).length >= SPACES * (RECORDS + 10));
await settle(100);
report('fresh device downloads everything', fm.take(), mm.take());
await Promise.all([client.close(), mirror.close(), fresh.close()]);
