#!/usr/bin/env node
/**
 * Qu Lite relay/mirror: an ordinary Qu peer built from the same registry as
 * a browser client - SQLite store, `sync({role: 'mirror'})` + the `mirror`
 * policy, WebSocket server transport - that stores every granted space's
 * sealed envelopes and serves them. It verifies signatures; it never reads.
 *
 *   node bin/mirror.mjs [--port 8787] [--host 0.0.0.0] [--db ./mirror.sqlite]
 *                                     [--allow sid1,sid2] [--static ./demo] [--quiet]
 *                                     [--quota-records N] [--quota-bytes N] [--max-envelope N] [--rate frames/s]
 *
 * Environment: QU_PORT / QU_HOST / QU_DB / QU_ALLOW / QU_STATIC /
 * QU_QUOTA_RECORDS / QU_QUOTA_BYTES / QU_MAX_ENVELOPE / QU_RATE (0 = no rate limit).
 * Its identity and network id live in the database, so clients can resume
 * pending syncs across restarts.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPeer } from '../src/peer.js';
import { nodeRegistry } from '../src/node.js';

/**
 * @param {{port?: number, host?: string, db?: string, allow?: string[]|null, static?: string, log?: (line: string) => void,
 *   quota?: {records?: number, bytes?: number}|null, maxEnvelopeBytes?: number, rate?: number}} [options]
 *   `rate`: inbound frames per second and connection (burst 2x, bytes 1 MiB/s); 0 disables.
 */
export async function startMirror({ port = 8787, host, db = ':memory:', allow = null, static: dir, log = console.log, quota = null, maxEnvelopeBytes, rate = 200 } = {}) {
  const limiter = rate > 0 ? [['limits', { frames: { rate, burst: 2 * rate } }]] : [];
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', { path: db }],
    plugins: [...limiter, ['sync', { role: 'mirror' }], ['mirror', { allow, quota, ...(maxEnvelopeBytes ? { maxEnvelopeBytes } : {}) }]],
    transports: [['ws-server', { port, host, static: dir }]],
  });
  const spaces = await qu.mirror.ready;
  const server = await qu.transports['ws-server'].ready;

  qu.bus.on('net.peer.up', ({ peer }) => log(`peer up   ${peer}`));
  qu.bus.on('net.peer.down', ({ peer }) => log(`peer down ${peer}`));
  qu.bus.on('mirror.grant', ({ sid, changed }) => log(`grant     ${sid} ${changed.join(',')}`));
  qu.bus.on('mirror.quota', ({ sid }) => log(`quota     ${sid} full`));
  qu.bus.on('net.limited', ({ peer, closed }) => closed && log(`limited   ${peer} (closed)`));
  qu.bus.on('sync.done', ({ peer, sid, sent, received }) => (sent || received) && log(`sync      ${sid} with ${peer}: sent ${sent}, received ${received}`));
  log(`qu-lite mirror ${qu.peerId} on ${dir ? 'http+' : ''}ws://${host ?? 'localhost'}:${server.port} (db ${db}, ${spaces.length} spaces)`);

  return {
    qu,
    port: server.port,
    async close() {
      await server.close();
      qu.root.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: args } = parseArgs({
    options: {
      port: { type: 'string', default: process.env.QU_PORT ?? '8787' },
      host: { type: 'string', default: process.env.QU_HOST ?? '0.0.0.0' },
      db: { type: 'string', default: process.env.QU_DB ?? './mirror.sqlite' },
      allow: { type: 'string', default: process.env.QU_ALLOW ?? '' },
      static: { type: 'string', default: process.env.QU_STATIC ?? '' },
      quiet: { type: 'boolean', default: false },
      'quota-records': { type: 'string', default: process.env.QU_QUOTA_RECORDS ?? '' },
      'quota-bytes': { type: 'string', default: process.env.QU_QUOTA_BYTES ?? '' },
      'max-envelope': { type: 'string', default: process.env.QU_MAX_ENVELOPE ?? '' },
      rate: { type: 'string', default: process.env.QU_RATE ?? '200' },
    },
  });
  const instance = await startMirror({
    port: Number(args.port),
    host: args.host,
    db: args.db,
    allow: args.allow ? args.allow.split(',') : null,
    static: args.static || undefined,
    quota:
      args['quota-records'] || args['quota-bytes']
        ? { ...(args['quota-records'] ? { records: Number(args['quota-records']) } : {}), ...(args['quota-bytes'] ? { bytes: Number(args['quota-bytes']) } : {}) }
        : null,
    maxEnvelopeBytes: args['max-envelope'] ? Number(args['max-envelope']) : undefined,
    rate: Number(args.rate),
    log: args.quiet ? () => {} : console.log,
  });
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
