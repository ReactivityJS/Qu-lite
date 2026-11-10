/**
 * RELAY TRANSPORT - "connect me to this relay, whatever gets through":
 * WebSocket first; if it cannot be established `wsAttempts` times in a row,
 * fall back to HTTPS + SSE on the same origin, and try WebSocket again
 * every `retryWsMs` (a network that blocked it may not block it forever).
 *
 *   qu.use(relayTransport({ url: 'https://relay.example' }))   // -> wss://…/ws, https://…/sse
 *   qu.use(relayTransport({ url: 'https://example.org/qu' }))   // behind a proxy prefix: wss://…/qu/ws
 *   qu.use(relayTransport({ url, isolate: true }))               // one connection per space
 *
 * `isolate`: every space this peer joins (records.join) gets its own
 * connection with its own random network id, carrying only that space
 * (scoped link, link.js) - the relay can't tell which spaces belong to one
 * device from the protocol. The shared connection carries everything else
 * (other users' nodes, inbox drops). IP address and timing still connect the
 * connections; hiding those needs a proxy/Tor in front.
 *
 * SEVERAL RELAYS: `url: [a, b]` keeps a connection to each (each with its
 * own WebSocket -> SSE fallback; with `isolate`, one per space and relay).
 * Writes go to every connected relay; a record counts as delivered once any
 * relay stored it (`ackFrom: 'mirror'`), and a relay that was down gets what
 * it missed from the reconcile when it is back. One relay going away
 * therefore changes nothing for the app.
 *
 * `qu.transports.relay` has connect()/disconnect()/status() like the
 * single-transport plugins, plus `via` ('ws' | 'sse') of the first shared
 * connection and `urls`.
 */
import { connectWs } from './ws.js';
import { connectSse } from './sse.js';
import { netOf } from './link.js';

const randomNetId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{url?: string|string[], wsPath?: string, ssePath?: string, wsAttempts?: number, retryWsMs?: number, minDelayMs?: number, maxDelayMs?: number, prefer?: 'ws'|'sse', isolate?: boolean, WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch}} [options]
 */
export function relayTransport({ url, wsPath = '/ws', ssePath = '/sse', wsAttempts = 3, retryWsMs = 5 * 60_000, prefer = 'ws', isolate = false, ...connectOptions } = {}) {
  return (qu) => {
    const net = netOf(qu);
    /** @type {string[]} relay origins */
    let bases = [];
    /** @type {Map<string, ReturnType<typeof channel>>} origin -> shared connection */
    const shared = new Map();
    /** @type {Map<string, ReturnType<typeof channel>>} `${origin} ${sid}` -> that space's own connection */
    const isolated = new Map();

    /** Endpoints under the url's path, so a relay behind a reverse-proxy prefix works as well. */
    const endpoints = (url) => {
      const u = new URL(url);
      const secure = u.protocol === 'https:' || u.protocol === 'wss:';
      const base = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
      return { ws: `${secure ? 'wss' : 'ws'}://${base}${wsPath}`, sse: `${secure ? 'https' : 'http'}://${base}${ssePath}` };
    };

    /** One connection with its own WebSocket -> SSE fallback. */
    function channel(base, linkOptions = {}) {
      let current = null; // {via, conn}
      let retryTimer = null;
      const use = (via) => {
        current?.conn.close();
        const target = endpoints(base);
        const options = { ...connectOptions, ...linkOptions };
        const conn =
          via === 'ws'
            ? connectWs(qu, target.ws, { ...options, onConnecting: (attempt) => attempt >= wsAttempts && queueMicrotask(() => current?.conn === conn && use('sse')) })
            : connectSse(qu, target.sse, options);
        current = { via, conn };
        qu.bus.notify('net.relay.transport', { url: base, via, scoped: Boolean(linkOptions.scope) });
        clearTimeout(retryTimer);
        if (via === 'sse' && retryWsMs > 0) {
          retryTimer = setTimeout(() => current && use('ws'), retryWsMs);
          retryTimer.unref?.();
        }
      };
      use(prefer);
      return {
        get via() {
          return current?.via ?? null;
        },
        status: () => ({ url: base, via: current?.via, connected: current?.conn.connected, peer: current?.conn.peer, scope: linkOptions.scope ? [...linkOptions.scope] : null }),
        close() {
          clearTimeout(retryTimer);
          current?.conn.close();
          current = null;
        },
      };
    }

    const isolateOn = (base, sid) => {
      const key = `${base} ${sid}`;
      if (!isolated.has(key)) isolated.set(key, channel(base, { localId: randomNetId(), scope: [sid] }));
    };
    function isolateSpace(sid) {
      net.isolated.add(sid); // synchronously: before the space announces its grants
      for (const base of bases) isolateOn(base, sid);
    }
    if (isolate) {
      net.exclusive = true; // every link says exactly what it wants (sync hello `only`)
      qu.bus.on('qu.space.joined', ({ space }) => isolateSpace(space));
      qu.bus.on('qu.space.left', ({ space }) => {
        for (const [key, c] of isolated) {
          if (!key.endsWith(` ${space}`)) continue;
          c.close();
          isolated.delete(key);
        }
        net.isolated.delete(space);
      });
      for (const sid of qu.records?.joined?.() ?? []) isolateSpace(sid);
    }

    const api = {
      /** @param {string|string[]} origins - http(s):// or ws(s):// origin(s) of the relay(s); replaces the current ones */
      connect(origins) {
        api.disconnect();
        bases = [...new Set([origins].flat().filter(Boolean))];
        for (const base of bases) {
          shared.set(base, channel(base));
          if (isolate) for (const sid of net.isolated) isolateOn(base, sid);
        }
      },
      disconnect() {
        for (const c of shared.values()) c.close();
        shared.clear();
        for (const c of isolated.values()) c.close();
        isolated.clear();
        bases = [];
      },
      status: () => [...[...shared.values()].map((c) => c.status()), ...[...isolated.values()].map((c) => c.status())],
      get urls() {
        return [...bases];
      },
      get via() {
        return shared.values().next().value?.via ?? null;
      },
      close() {
        api.disconnect();
      },
    };
    if (url) api.connect(url);
    qu.transports = { ...qu.transports, relay: api };
    return api;
  };
}
