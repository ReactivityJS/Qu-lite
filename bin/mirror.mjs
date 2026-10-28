#!/usr/bin/env node
/**
 * Qu Lite relay/mirror: an ordinary Qu peer built from the same registry as
 * a browser client - SQLite store, `sync({role: 'mirror'})` + the `mirror`
 * policy, WebSocket server transport - that stores every granted space's
 * sealed envelopes and serves them. It verifies signatures; it never reads.
 *
 *   node bin/mirror.mjs [--port 8787] [--host 0.0.0.0] [--db ./mirror.sqlite]
 *                                     [--allow sid1,sid2] [--static ./web] [--quiet]
 *                                     [--quota-records N] [--quota-bytes N] [--max-envelope N] [--rate frames/s]
 *                                     [--stats-token SECRET] [--max-spaces N]
 *
 * Environment: QU_PORT / QU_HOST / QU_DB / QU_ALLOW / QU_STATIC /
 * QU_QUOTA_RECORDS / QU_QUOTA_BYTES / QU_MAX_ENVELOPE / QU_RATE (0 = no rate limit) /
 * QU_STATS_TOKEN (enables /stats and /metrics for requests with this token) / QU_MAX_SPACES.
 * Every QU_X can also come from a file named by QU_X_FILE (Docker/Swarm
 * secrets: QU_STATS_TOKEN_FILE=/run/secrets/qu_stats_token); the file wins.
 * Its identity and network id live in the database, so clients can resume
 * pending syncs across restarts.
 *
 * With `--static ./web` (Docker: always) the same port also serves the
 * client start page (/), the demo (/demo.html) and the browser bundle
 * (/dist/qu-lite.js); /healthz and /info are always there. Put a reverse
 * proxy in front for TLS (docs/DEPLOY.md).
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPeer } from '../src/peer.js';
import { nodeRegistry } from '../src/node.js';

/**
 * @param {{port?: number, host?: string, db?: string, allow?: string[]|null, static?: string, log?: (line: string) => void,
 *   quota?: {records?: number, bytes?: number}|null, maxEnvelopeBytes?: number, rate?: number}} [options]
 *   `rate`: inbound frames per second and connection (burst 2x, bytes 1 MiB/s); 0 disables.
 *   `statsToken`: installs the stats plugin and serves /stats + /metrics to requests carrying it.
 *   `maxSpaces`: how many spaces this mirror accepts at most (null = unlimited).
 */
export async function startMirror({ port = 8787, host, db = ':memory:', allow = null, static: dir, log = console.log, quota = null, maxEnvelopeBytes, rate = 200, statsToken, maxSpaces = null } = {}) {
  const limiter = rate > 0 ? [['limits', { frames: { rate, burst: 2 * rate } }]] : [];
  const statistics = statsToken ? ['stats'] : [];
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', { path: db }],
    plugins: [...statistics, ...limiter, ['sync', { role: 'mirror' }], ['mirror', { allow, quota, maxSpaces, ...(maxEnvelopeBytes ? { maxEnvelopeBytes } : {}) }]],
    transports: [['ws-server', { port, host, static: dir, statsToken }]],
  });
  const spaces = await qu.mirror.ready;
  const server = await qu.transports['ws-server'].ready;

  qu.bus.on('net.peer.up', ({ peer }) => log(`peer up   ${peer}`));
  qu.bus.on('net.peer.down', ({ peer }) => log(`peer down ${peer}`));
  qu.bus.on('mirror.grant', ({ sid, changed }) => log(`grant     ${sid} ${changed.join(',')}`));
  qu.bus.on('mirror.quota', ({ sid }) => log(`quota     ${sid} full`));
  qu.bus.on('mirror.full', ({ spaces }) => log(`refused   new space: ${spaces} spaces (--max-spaces)`));
  qu.bus.on('net.limited', ({ peer, closed }) => closed && log(`limited   ${peer} (closed)`));
  qu.bus.on('sync.done', ({ peer, sid, sent, received }) => (sent || received) && log(`sync      ${sid} with ${peer}: sent ${sent}, received ${received}`));
  log(`qu-lite mirror ${qu.peerId} on ${dir ? 'http+' : ''}ws://${host ?? 'localhost'}:${server.port} (db ${db}, ${spaces.length} spaces${statsToken ? ', /stats + /metrics with token' : ''})`);

  return {
    qu,
    port: server.port,
    async close() {
      await server.close();
      qu.root.close();
    },
  };
}

/** A setting from QU_X_FILE (secrets) or QU_X. */
function env(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: args } = parseArgs({
    options: {
      port: { type: 'string', default: env('QU_PORT') ?? '8787' },
      host: { type: 'string', default: env('QU_HOST') ?? '0.0.0.0' },
      db: { type: 'string', default: env('QU_DB') ?? './mirror.sqlite' },
      allow: { type: 'string', default: env('QU_ALLOW') ?? '' },
      static: { type: 'string', default: env('QU_STATIC') ?? '' },
      quiet: { type: 'boolean', default: false },
      'quota-records': { type: 'string', default: env('QU_QUOTA_RECORDS') ?? '' },
      'quota-bytes': { type: 'string', default: env('QU_QUOTA_BYTES') ?? '' },
      'max-envelope': { type: 'string', default: env('QU_MAX_ENVELOPE') ?? '' },
      rate: { type: 'string', default: env('QU_RATE') ?? '200' },
      'stats-token': { type: 'string', default: env('QU_STATS_TOKEN') ?? '' },
      'max-spaces': { type: 'string', default: env('QU_MAX_SPACES') ?? '' },
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
    statsToken: args['stats-token'] || undefined,
    maxSpaces: args['max-spaces'] ? Number(args['max-spaces']) : null,
    log: args.quiet ? () => {} : console.log,
  });
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
