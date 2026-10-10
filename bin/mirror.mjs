#!/usr/bin/env node
/**
 * Qu Lite relay/mirror: an ordinary Qu peer built from the same registry as
 * a browser client - SQLite store, `sync({role: 'mirror'})` + the `mirror`
 * policy, WebSocket server transport - that stores every granted space's
 * sealed envelopes and serves them. It verifies signatures; it never reads.
 *
 *   node packages/lite/bin/mirror.mjs [--port 8787] [--host 0.0.0.0] [--db ./mirror.sqlite]
 *                                     [--allow sid1,sid2] [--static ./packages/lite/demo] [--quiet]
 *
 * Environment: QU_PORT / QU_HOST / QU_DB / QU_ALLOW / QU_STATIC.
 * Its identity and network id live in the database, so clients can resume
 * pending syncs across restarts.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPeer } from '../src/peer.js';
import { nodeRegistry } from '../src/node.js';

/**
 * @param {{port?: number, host?: string, db?: string, allow?: string[]|null, static?: string, log?: (line: string) => void}} [options]
 */
export async function startMirror({ port = 8787, host, db = ':memory:', allow = null, static: dir, log = console.log } = {}) {
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', { path: db }],
    plugins: [['sync', { role: 'mirror' }], ['mirror', { allow }]],
    transports: [['ws-server', { port, host, static: dir }]],
  });
  const spaces = await qu.mirror.ready;
  const server = await qu.transports['ws-server'].ready;

  qu.bus.on('net.peer.up', ({ peer }) => log(`peer up   ${peer}`));
  qu.bus.on('net.peer.down', ({ peer }) => log(`peer down ${peer}`));
  qu.bus.on('mirror.grant', ({ sid, changed }) => log(`grant     ${sid} ${changed.join(',')}`));
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
    },
  });
  const instance = await startMirror({
    port: Number(args.port),
    host: args.host,
    db: args.db,
    allow: args.allow ? args.allow.split(',') : null,
    static: args.static || undefined,
    log: args.quiet ? () => {} : console.log,
  });
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
