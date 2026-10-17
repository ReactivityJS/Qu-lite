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
 * `qu.transports.relay` has connect()/disconnect()/status() like the
 * single-transport plugins, plus `via` ('ws' | 'sse') of the shared connection.
 */
import { connectWs } from './ws.js';
import { connectSse } from './sse.js';
import { netOf } from './link.js';

const randomNetId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{url?: string, wsPath?: string, ssePath?: string, wsAttempts?: number, retryWsMs?: number, minDelayMs?: number, maxDelayMs?: number, prefer?: 'ws'|'sse', isolate?: boolean, WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch}} [options]
 */
export function relayTransport({ url, wsPath = '/ws', ssePath = '/sse', wsAttempts = 3, retryWsMs = 5 * 60_000, prefer = 'ws', isolate = false, ...connectOptions } = {}) {
  return (qu) => {
    const net = netOf(qu);
    let base = null;
    let shared = null;
    /** @type {Map<string, ReturnType<typeof channel>>} sid -> its own connection */
    const isolated = new Map();

    /** Endpoints under the url's path, so a relay behind a reverse-proxy prefix works as well. */
    const endpoints = (url) => {
      const u = new URL(url);
      const secure = u.protocol === 'https:' || u.protocol === 'wss:';
      const base = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
      return { ws: `${secure ? 'wss' : 'ws'}://${base}${wsPath}`, sse: `${secure ? 'https' : 'http'}://${base}${ssePath}` };
    };

    /** One connection with its own WebSocket -> SSE fallback. */
    function channel(linkOptions = {}) {
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

    function isolateSpace(sid) {
      net.isolated.add(sid); // synchronously: before the space announces its grants
      if (base && !isolated.has(sid)) isolated.set(sid, channel({ localId: randomNetId(), scope: [sid] }));
    }
    if (isolate) {
      net.exclusive = true; // every link says exactly what it wants (sync hello `only`)
      qu.bus.on('qu.space.joined', ({ space }) => isolateSpace(space));
      qu.bus.on('qu.space.left', ({ space }) => {
        isolated.get(space)?.close();
        isolated.delete(space);
        net.isolated.delete(space);
      });
      for (const sid of qu.records?.joined?.() ?? []) isolateSpace(sid);
    }

    const api = {
      /** @param {string} origin - http(s):// or ws(s):// origin of the relay */
      connect(origin) {
        base = origin;
        shared?.close();
        shared = channel();
        for (const sid of net.isolated) if (isolate && !isolated.has(sid)) isolated.set(sid, channel({ localId: randomNetId(), scope: [sid] }));
      },
      disconnect() {
        shared?.close();
        shared = null;
        for (const c of isolated.values()) c.close();
        isolated.clear();
      },
      status: () => (shared ? [shared.status(), ...[...isolated.values()].map((c) => c.status())] : []),
      get via() {
        return shared?.via ?? null;
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
