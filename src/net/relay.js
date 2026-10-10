/**
 * RELAY TRANSPORT - "connect me to this relay, whatever gets through":
 * WebSocket first; if it cannot be established `wsAttempts` times in a row,
 * fall back to HTTPS + SSE on the same origin, and try WebSocket again
 * every `retryWsMs` (a network that blocked it may not block it forever).
 *
 *   qu.use(relayTransport({ url: 'https://relay.example' }))   // -> wss://…/ws, https://…/sse
 *
 * `qu.transports.relay` has connect()/disconnect()/status() like the
 * single-transport plugins, plus `via` ('ws' | 'sse').
 */
import { connectWs } from './ws.js';
import { connectSse } from './sse.js';

/**
 * @param {{url?: string, wsPath?: string, ssePath?: string, wsAttempts?: number, retryWsMs?: number, minDelayMs?: number, maxDelayMs?: number, prefer?: 'ws'|'sse', WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch}} [options]
 */
export function relayTransport({ url, wsPath = '/ws', ssePath = '/sse', wsAttempts = 3, retryWsMs = 5 * 60_000, prefer = 'ws', ...connectOptions } = {}) {
  return (qu) => {
    let current = null; // {via, conn}
    let base = null;
    let failures = 0;
    let retryTimer = null;
    const endpoints = (origin) => {
      const u = new URL(origin);
      const secure = u.protocol === 'https:' || u.protocol === 'wss:';
      const host = u.host;
      return { ws: `${secure ? 'wss' : 'ws'}://${host}${wsPath}`, sse: `${secure ? 'https' : 'http'}://${host}${ssePath}` };
    };

    const offUp = qu.bus.on('net.peer.up', ({ via }) => {
      if (via === 'ws' && current?.via === 'ws') failures = 0;
    });
    const offConnecting = qu.bus.on('net.connecting', ({ url: target, attempt, via }) => {
      if (current?.via !== 'ws' || via === 'sse' || target !== endpoints(base).ws) return;
      // `attempt` counts consecutive failures of this WebSocket connection
      failures = attempt;
      if (failures >= wsAttempts) use('sse');
    });

    function use(via) {
      current?.conn.close();
      const target = endpoints(base);
      current = { via, conn: via === 'ws' ? connectWs(qu, target.ws, connectOptions) : connectSse(qu, target.sse, connectOptions) };
      qu.bus.notify('net.relay.transport', { url: base, via });
      clearTimeout(retryTimer);
      if (via === 'sse' && retryWsMs > 0) {
        retryTimer = setTimeout(() => base && use('ws'), retryWsMs);
        retryTimer.unref?.();
      }
    }

    const api = {
      /** @param {string} origin - http(s):// or ws(s):// origin of the relay */
      connect(origin) {
        base = origin;
        failures = 0;
        use(prefer);
      },
      disconnect() {
        clearTimeout(retryTimer);
        current?.conn.close();
        current = null;
      },
      status: () => (current ? [{ url: base, via: current.via, connected: current.conn.connected, peer: current.conn.peer }] : []),
      get via() {
        return current?.via ?? null;
      },
      close() {
        api.disconnect();
        offUp();
        offConnecting();
      },
    };
    if (url) api.connect(url);
    qu.transports = { ...qu.transports, relay: api };
    return api;
  };
}
