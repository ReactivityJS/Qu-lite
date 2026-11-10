#!/usr/bin/env node
/**
 * Qu Lite relay/mirror CLI - a thin wrapper around `createRelay()`
 * (src/server.js): an ordinary Qu peer built from the same registry as a
 * browser client - SQLite store, `sync({role: 'mirror'})` + the `mirror`
 * policy, HTTP server transport - that stores every granted space's sealed
 * envelopes and serves them. It verifies signatures; it never reads.
 *
 *   node bin/mirror.mjs [--port 8787] [--host 0.0.0.0] [--db ./mirror.sqlite]
 *                       [--allow sid1,sid2] [--static ./web] [--quiet] [--log-format text|json]
 *                       [--quota-records N] [--quota-bytes N] [--max-envelope N] [--rate frames/s]
 *                       [--stats-token SECRET] [--max-spaces N] [--max-connections N] [--repl]
 *                       [--push mailto:ops@example.org]
 *
 * Environment: QU_PORT / QU_HOST / QU_DB / QU_ALLOW / QU_STATIC /
 * QU_QUOTA_RECORDS / QU_QUOTA_BYTES / QU_MAX_ENVELOPE / QU_RATE (0 = no rate limit) /
 * QU_STATS_TOKEN (enables /stats and /metrics for requests with this token) / QU_MAX_SPACES /
 * QU_MAX_CONNECTIONS / QU_LOG_FORMAT / QU_PUSH (contact for Web Push; enables push, push-relay.js).
 * Every QU_X can also come from a file named by QU_X_FILE (Docker/Swarm
 * secrets: QU_STATS_TOKEN_FILE=/run/secrets/qu_stats_token); the file wins.
 * Its identity and network id live in the database, so clients can resume
 * pending syncs across restarts.
 *
 * `--repl` opens an interactive console next to the running relay with
 * `qu` (the peer) and `dev` (= qu.dev, the same inspection API as in the
 * browser console): `dev.links()`, `dev.trace('net.**')`, `dev.ls('mirror/')`.
 *
 * With `--static ./web` (Docker: always) the same port also serves the
 * client start page (/), the demo (/demo.html) and the browser bundle
 * (/dist/qu-lite.js); /healthz, /readyz and /info are always there. Put a
 * reverse proxy in front for TLS (docs/DEPLOY.md).
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../src/server.js';

/**
 * Kept for existing callers (tests, scripts): same options as `createRelay()`.
 * @param {Parameters<typeof createRelay>[0]} [options]
 */
export async function startMirror(options = {}) {
  return createRelay(options);
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
      'log-format': { type: 'string', default: env('QU_LOG_FORMAT') ?? 'text' },
      'quota-records': { type: 'string', default: env('QU_QUOTA_RECORDS') ?? '' },
      'quota-bytes': { type: 'string', default: env('QU_QUOTA_BYTES') ?? '' },
      'max-envelope': { type: 'string', default: env('QU_MAX_ENVELOPE') ?? '' },
      rate: { type: 'string', default: env('QU_RATE') ?? '200' },
      'stats-token': { type: 'string', default: env('QU_STATS_TOKEN') ?? '' },
      'max-spaces': { type: 'string', default: env('QU_MAX_SPACES') ?? '' },
      'max-connections': { type: 'string', default: env('QU_MAX_CONNECTIONS') ?? '' },
      repl: { type: 'boolean', default: false },
      push: { type: 'string', default: env('QU_PUSH') ?? '' },
    },
  });
  const relay = await createRelay({
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
    maxConnections: args['max-connections'] ? Number(args['max-connections']) : undefined,
    logFormat: args['log-format'] === 'json' ? 'json' : 'text',
    log: args.quiet ? () => {} : console.log,
    handleSignals: true,
    push: args.push ? { subject: args.push } : null,
  });
  if (args.repl) {
    const { start } = await import('node:repl');
    const repl = start({ prompt: 'qu> ' });
    Object.assign(repl.context, { qu: relay.qu, dev: relay.qu.dev, relay });
    console.log('qu, dev and relay are available - try dev.help()');
    repl.on('exit', async () => {
      await relay.close();
      process.exit(0);
    });
  }
}
