#!/usr/bin/env node
/**
 * Qu Lite mirror: an always-on peer that stores every granted space's
 * sealed envelopes in SQLite and serves them over WebSocket. It never holds
 * a space key - it can verify, not read.
 *
 *   node packages/lite/bin/mirror.mjs [--port 8787] [--host 0.0.0.0] [--db ./mirror.sqlite] [--allow sid1,sid2]
 *
 * Environment variables QU_PORT / QU_HOST / QU_DB / QU_ALLOW override the defaults.
 * The mirror's identity is kept in the database, so its peer id (which
 * clients use to resume pending syncs) survives restarts.
 */
import { parseArgs } from 'node:util';
import { QuCrypto } from '@qu/core';
import { createQu, sync, mirror } from '../src/index.js';
import { sqliteDriver } from '../src/drivers/sqlite.js';
import { listenWs } from '../src/net/ws-server.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.QU_PORT ?? '8787' },
    host: { type: 'string', default: process.env.QU_HOST ?? '0.0.0.0' },
    db: { type: 'string', default: process.env.QU_DB ?? './mirror.sqlite' },
    allow: { type: 'string', default: process.env.QU_ALLOW ?? '' },
    quiet: { type: 'boolean', default: false },
  },
});

export async function startMirror({ port = 8787, host, db = ':memory:', allow = null, log = console.log } = {}) {
  const root = sqliteDriver({ path: db });
  let identity = await root.get('mirror/identity');
  if (!identity) {
    identity = await QuCrypto.generateKeypair();
    await root.set('mirror/identity', identity);
  }
  const qu = await createQu({ root, identity });
  qu.use(sync({ role: 'mirror' }));
  qu.use(mirror({ allow }));
  const spaces = await qu.mirror.ready;
  const server = await listenWs(qu, { port, host });

  qu.bus.on('net.peer.up', ({ peer }) => log(`peer up   ${peer}`));
  qu.bus.on('net.peer.down', ({ peer }) => log(`peer down ${peer}`));
  qu.bus.on('mirror.grant', ({ sid, epochs }) => log(`grant     ${sid} epochs ${epochs.join(',')}`));
  qu.bus.on('sync.done', ({ peer, sid, sent, received }) => (sent || received) && log(`sync      ${sid} with ${peer}: sent ${sent}, received ${received}`));
  log(`qu-lite mirror ${qu.peerId} listening on ws://${host ?? 'localhost'}:${server.port} (db ${db}, ${spaces.length} spaces)`);

  return {
    qu,
    port: server.port,
    async close() {
      await server.close();
      root.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const instance = await startMirror({
    port: Number(args.port),
    host: args.host,
    db: args.db,
    allow: args.allow ? args.allow.split(',') : null,
    log: args.quiet ? () => {} : console.log,
  });
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
