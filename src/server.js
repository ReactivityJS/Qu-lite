/**
 * RELAY PRESET (Node) - a relay/mirror in one call, the counterpart of
 * `createClient()`. It is an ordinary Qu peer built from the same registry
 * as a browser client: SQLite store, `sync({role: 'mirror'})` + the `mirror`
 * policy, the HTTP server transport (WebSocket + HTTPS/SSE, /healthz,
 * /readyz, /info, optional /stats + /metrics, optional static files). It
 * verifies signatures; it never reads.
 *
 *   import { createRelay } from '@qu/lite/node';
 *   const relay = await createRelay({ port: 8787, db: './mirror.sqlite' });
 *   relay.qu.dev.links();          // same inspection API as in the browser
 *   await relay.close();           // graceful: readiness 503, 1001 to clients, store closed
 *
 * Extra plugins (`extra`) run inside the relay like in any peer - e.g. a
 * plugin that listens to `mirror.grant` and reports to monitoring.
 *
 * Logs: `log` gets one line per event; `logFormat: 'json'` makes every line
 * one JSON object ({time, event, ...fields}) for log collectors.
 */
import { createPeer } from './peer.js';
import { nodeRegistry } from './node-registry.js';

/** Events the relay logs, with the fields that go into the line. */
const LOGGED = {
  'net.peer.up': ({ peer, via }) => ({ peer, via }),
  'net.peer.down': ({ peer, via, stats }) => ({ peer, via, sent: stats?.sent, received: stats?.received }),
  'net.refused': ({ via, reason }) => ({ via, reason }),
  'net.slow': ({ via, peer, buffered }) => ({ via, peer, buffered }),
  'net.limited': ({ peer, closed }) => (closed ? { peer, closed } : null),
  'net.error': ({ via, reason, peer }) => ({ via, reason, peer }),
  'mirror.grant': ({ sid, changed }) => ({ sid, changed: changed?.join(',') }),
  'mirror.quota': ({ sid }) => ({ sid }),
  'mirror.full': ({ spaces }) => ({ spaces }),
  'sync.done': ({ peer, sid, sent, received }) => (sent || received ? { peer, sid, sent, received } : null),
  'bus.error': ({ topic, error }) => ({ topic, error: error?.message ?? String(error) }),
};

const formatText = (event, fields) =>
  `${event.padEnd(14)} ${Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`;
const formatJson = (event, fields) => JSON.stringify({ time: new Date().toISOString(), event, ...fields });

/**
 * @param {{
 *   port?: number, host?: string, db?: string, allow?: string[]|null, static?: string,
 *   quota?: {records?: number, bytes?: number}|null, maxEnvelopeBytes?: number, maxSpaces?: number|null,
 *   rate?: number, statsToken?: string, maxConnections?: number, maxBufferedBytes?: number,
 *   log?: (line: string) => void, logFormat?: 'text'|'json', extra?: Array<string|[string, object]|Function>,
 *   devtools?: boolean, handleSignals?: boolean,
 * }} [options]
 *   `rate`: inbound frames per second and connection (burst 2x, bytes 1 MiB/s); 0 disables.
 *   `statsToken`: installs the stats plugin and serves /stats + /metrics to requests carrying it.
 *   `handleSignals`: close gracefully on SIGINT/SIGTERM and exit.
 * @returns {Promise<{qu: object, port: number, spaces: string[], close: () => Promise<void>}>}
 */
export async function createRelay({
  port = 8787,
  host,
  db = ':memory:',
  allow = null,
  static: dir,
  quota = null,
  maxEnvelopeBytes,
  maxSpaces = null,
  rate = 200,
  statsToken,
  maxConnections,
  maxBufferedBytes,
  log = console.log,
  logFormat = 'text',
  extra = [],
  devtools = true,
  handleSignals = false,
} = {}) {
  const limiter = rate > 0 ? [['limits', { frames: { rate, burst: 2 * rate } }]] : [];
  const statistics = statsToken ? ['stats'] : [];
  const tools = devtools ? [['devtools', { global: false }]] : [];
  let mirrorReady = false;
  const qu = await createPeer({
    registry: nodeRegistry(),
    store: ['sqlite', { path: db }],
    plugins: [
      ...statistics,
      ...limiter,
      ['sync', { role: 'mirror' }],
      ['mirror', { allow, quota, maxSpaces, ...(maxEnvelopeBytes ? { maxEnvelopeBytes } : {}) }],
      ...tools,
      ...extra,
    ],
    transports: [['ws-server', { port, host, static: dir, statsToken, maxConnections, maxBufferedBytes, ready: () => mirrorReady }]],
  });
  const spaces = await qu.mirror.ready;
  mirrorReady = true;
  const server = await qu.transports['ws-server'].ready;

  const format = logFormat === 'json' ? formatJson : formatText;
  for (const [topic, pick] of Object.entries(LOGGED)) {
    qu.bus.on(topic, (payload) => {
      const fields = pick(payload ?? {});
      if (fields) log(format(topic, fields));
    });
  }
  const url = `${dir ? 'http+' : ''}ws://${host ?? 'localhost'}:${server.port}`;
  log(
    logFormat === 'json'
      ? formatJson('relay.start', { peer: qu.peerId, url, db, spaces: spaces.length, stats: Boolean(statsToken) })
      : `qu-lite mirror ${qu.peerId} on ${url} (db ${db}, ${spaces.length} spaces${statsToken ? ', /stats + /metrics with token' : ''})`
  );

  const relay = {
    qu,
    port: server.port,
    spaces,
    /** Graceful shutdown: readiness 503, clients get "going away", plugins and the store are closed. */
    close: () => qu.close(),
  };
  if (handleSignals) {
    const stop = async (signal) => {
      log(format('relay.stop', { signal }));
      await relay.close();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  return relay;
}
