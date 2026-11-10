#!/usr/bin/env node
/**
 * What does a connected but idle client cost? Two devices (anna, ben) share
 * GROUPS groups, both show presence (status tracked) for each, nobody writes.
 * Measures anna's bytes on the wire per frame type for SECONDS seconds over a
 * real WebSocket relay and extrapolates per hour and per 30 days (mobile).
 *
 *   node bench/idle-traffic.mjs [groups] [seconds]
 *   INTERVAL=<ms> status heartbeat (default 20000)
 */
import { createRelay } from '../src/node.js';
import { createClient } from '../src/index.js';

const GROUPS = Number(process.argv[2] ?? 10);
const SECONDS = Number(process.argv[3] ?? 60);
const interval = Number(process.env.INTERVAL ?? 20_000);
const relay = await createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
const url = `http://127.0.0.1:${relay.port}`;
const plugins = ['records', 'user', 'members', 'inbox', ['sync', { ackFrom: 'mirror' }], ['status', { interval }], 'compaction'];
const make = () => createClient({ url, devtools: false, plugins, relay: { WebSocketImpl: WebSocket } });
const anna = await make();
const ben = await make();

for (let g = 0; g < GROUPS; g++) {
  const group = await anna.createGroup();
  const theirs = await ben.acceptInvite(await (await anna.members(group)).invite());
  await anna.status(group);
  await ben.status(theirs);
}
await new Promise((r) => setTimeout(r, 3000)); // setup traffic settles

// anna's outgoing frames by type (encoded size), incoming by the link counters
const { encodeFrame } = await import('../src/net/frame.js');
const out = {};
anna.bus.on('net.out.*.*', (payload, ctx) => {
  const type = ctx.topic.split('.')[3];
  out[type] ??= { frames: 0, bytes: 0 };
  out[type].frames++;
  out[type].bytes += encodeFrame(type, payload).length;
}, { order: -1e9 });
const inn = {};
anna.bus.on('net.in.*.*', (payload, ctx) => {
  const type = ctx.topic.split('.')[3];
  inn[type] ??= { frames: 0, bytes: 0 };
  inn[type].frames++;
  inn[type].bytes += encodeFrame(type, payload).length;
}, { order: -1e9 });
const link = () => [...anna.net.links.values()][0].stats;
const start = { ...link() };
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const end = link();
const sent = end.sent - start.sent;
const received = end.received - start.received;
const perHour = ((sent + received) * 3600) / SECONDS;
console.log(`# anna: ${GROUPS} groups with presence, idle ${SECONDS} s, heartbeat ${interval / 1000} s`);
console.log(`sent ${sent} B, received ${received} B -> ${(perHour / 1024).toFixed(0)} KiB/hour, ${((perHour * 24 * 30) / 1048576).toFixed(0)} MiB per 30 days (always on)`);
const rows = {};
for (const [t, v] of Object.entries(out)) rows[`out ${t}`] = v;
for (const [t, v] of Object.entries(inn)) rows[`in  ${t}`] = v;
console.table(rows);
await Promise.all([anna.close(), ben.close()]);
await relay.close();
