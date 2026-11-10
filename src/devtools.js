/**
 * DEVTOOLS - one inspection API for every peer, in the browser's dev
 * console and in a relay's REPL (`qu-lite-mirror --repl`): `qu.dev`.
 *
 *   qu.use(devtools())            // browser: also window.qu (option `global`)
 *   qu.dev.help()                 // lists every command
 *   qu.dev.info()                 // who am I, plugins, mounts, links
 *   qu.dev.links()                // open connections as a table
 *   qu.dev.trace('net.**')        // log bus traffic matching a pattern; returns stop()
 *   qu.dev.ls('rec/')             // storage keys under a prefix
 *
 * Read-mostly by design: nothing here changes data except `emit()` (an
 * explicit bus call). `ls()`/`get()`/`dump()` never show the identity's
 * private keys (`qu/identity` is masked) - a dump is meant to be pasted
 * into a bug report.
 *
 * Tracing can survive a reload: `trace(pattern, {persist: true})` stores the
 * pattern in localStorage (`qu:trace`), and `?qu-trace=<pattern>` in the
 * page URL starts it too - handy for problems that happen during start.
 *
 * Optional plugin: nothing in the core imports it.
 */
import { toHex } from './crypto.js';
import { netOf } from './net/link.js';

/** What each frame type carries - for `qu.dev.traffic()` (kept here, not in every client's link code). */
export const FRAME_TYPES = Object.freeze({
  hi: 'link handshake',
  hello: 'sync handshake: role, subscriptions, features',
  grant: 'space access grants (a relay stores only granted spaces)',
  sub: 'subscribe to a space (partial sync)',
  unsub: 'unsubscribe',
  rec: 'one record (sealed envelope)',
  recs: 'several records in one frame',
  ack: 'records stored by the receiver',
  nack: 'record refused (quota, size)',
  neg: 'reconcile request (Negentropy)',
  negr: 'reconcile answer',
  negend: 'reconcile finished',
  negerr: 'reconcile declined (busy)',
  want: 'ids the initiator asks for',
  wantmiss: 'ids the responder does not have',
  digest: 'fingerprint check before a reconcile',
  digestr: 'fingerprint answer',
  pull: 'direct download request (empty scope)',
  pullend: 'direct download finished',
  sig: 'ephemeral signal: presence heartbeat, typing, WebRTC signaling',
  grantsum: 'fingerprints of the grants a peer holds (asks which a mirror lacks)',
  grantneed: 'spaces whose grants the mirror lacks',
  other: 'any other type',
});

/** Rough per-frame cost below our frame bytes: WebSocket header + TLS record + share of TCP/IP headers. */
const WIRE_OVERHEAD = 60;
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

const SECRET_KEYS = new Set(['qu/identity', 'qu/identity-locked']);
const TRACE_KEY = 'qu:trace';

/** Payloads made readable for the console: bytes as `<N bytes>`, long arrays shortened. */
function brief(value, depth = 0) {
  if (value instanceof Uint8Array) return value.length <= 8 ? `<${toHex(value)}>` : `<${value.length} bytes>`;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.length > 10 ? [...value.slice(0, 10).map((v) => brief(v, depth + 1)), `… +${value.length - 10}`] : value.map((v) => brief(v, depth + 1));
  if (value.constructor && value.constructor !== Object) return `[${value.constructor.name}]`;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'function' ? '[fn]' : brief(v, depth + 1);
  return out;
}

const sizeOf = (value) => {
  if (value instanceof Uint8Array) return value.length;
  try {
    return JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? `x`.repeat(v.length) : v))?.length ?? 0;
  } catch {
    return 0;
  }
};

const storageGet = (key) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const storageSet = (key, value) => {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {}
};

/**
 * @param {{global?: string|false, log?: (...args: any[]) => void, table?: (rows: any) => void}} [options]
 *   `global`: name under which the peer is put on `globalThis` (browser default 'qu', Node default none).
 */
export function devtools({ global = typeof window !== 'undefined' ? 'qu' : false, log = console.log, table = console.table ?? console.log } = {}) {
  const plugin = (qu) => {
    const traces = new Map(); // pattern -> stop
    const watchers = new Set(); // watchTraffic stops
    let exposedAs = null;
    const started = Date.now();
    const browser = typeof window !== 'undefined';

    const print = (rows) => {
      table(rows);
      return rows;
    };

    function trace(pattern = '**', { persist = false, filter = null } = {}) {
      traces.get(pattern)?.();
      const t0 = performance.now?.() ?? Date.now();
      const off = qu.bus.on(
        pattern,
        (payload, ctx) => {
          if (filter && !filter(ctx.topic, payload)) return;
          const ms = ((performance.now?.() ?? Date.now()) - t0).toFixed(0).padStart(6);
          if (browser) log(`%c${ms}ms %c${ctx.topic}`, 'color:#888', 'color:#06c;font-weight:600', brief(payload));
          else log(`${ms}ms ${ctx.topic}`, brief(payload));
        },
        { order: -1_000_000 } // before everyone: see the payload as it arrived
      );
      const stop = () => {
        off();
        traces.delete(pattern);
        if (persist) storageSet(TRACE_KEY, null);
      };
      traces.set(pattern, stop);
      if (persist) storageSet(TRACE_KEY, pattern);
      return stop;
    }

    const dev = {
      help() {
        const rows = {
          'info()': 'peer id, public key, plugins, mounts, link count',
          'links()': 'open connections (peer, transport, bytes, frames)',
          'transports()': 'status of every client transport (url, connected, via)',
          'trace(pattern, {persist, filter})': "log bus events, e.g. trace('net.**'), trace('qu.record.**'); returns stop()",
          'untrace()': 'stop all traces (and the persisted one)',
          'spaces()': 'joined spaces (records plugin)',
          'pending()': 'outbox and pending reconciles (sync plugin)',
          'ls(prefix, limit)': "storage keys under a prefix, e.g. ls('rec/'), ls('sync/out/')",
          'get(key)': 'one stored value (identity masked)',
          'dump(prefix)': 'stored values under a prefix as plain JSON (for bug reports)',
          'stats()': 'operating figures (stats plugin)',
          'memory()': 'what the caches hold: decrypted records, field indexes, sync index (RAM only)',
          'traffic()': 'bytes and frames in/out per message type since start (or reset), with a per-hour rate',
          'watchTraffic(seconds)': 'log the traffic of every interval live, per type; returns stop()',
          'resetTraffic()': 'start counting traffic from zero',
          'listeners(topic)': 'how many handlers a topic reaches',
          'emit(topic, payload)': 'fire a bus event by hand (bus.emit)',
        };
        print(Object.entries(rows).map(([command, does]) => ({ command: `qu.dev.${command}`, does })));
        return undefined;
      },
      info() {
        const net = netOf(qu);
        return {
          peerId: qu.peerId,
          publicKey: qu.identity?.publicKey ? toHex(qu.identity.publicKey) : null,
          plugins: [...qu.plugins.keys()],
          mounts: qu.storage.mounts(),
          links: net.links.size,
          uptime: Math.round((Date.now() - started) / 1000),
          closed: qu.closed,
        };
      },
      links() {
        return print(
          [...netOf(qu).links].map(([peer, l]) => ({
            peer,
            via: l.via,
            since: new Date(l.since).toISOString(),
            protocol: l.version ?? 1,
            sent: l.stats.sent,
            received: l.stats.received,
            framesOut: l.stats.framesOut,
            framesIn: l.stats.framesIn,
            scope: netOf(qu).scopes.get(peer)?.size ?? 'shared',
            inQueue: l.inbound?.().queued ?? 0,
            outQueue: l.backlog?.() ?? 0,
          }))
        );
      },
      transports() {
        const rows = [];
        for (const [name, t] of Object.entries(qu.transports ?? {})) {
          const list = typeof t.status === 'function' ? t.status() : [];
          for (const s of list) rows.push({ transport: name, ...s, scope: s.scope ? s.scope.length : undefined });
        }
        return print(rows);
      },
      trace,
      untrace() {
        for (const stop of [...traces.values()]) stop();
        storageSet(TRACE_KEY, null);
      },
      spaces() {
        return print((qu.records?.joined?.() ?? []).map((sid) => ({ sid })));
      },
      async pending() {
        if (typeof qu.syncStatus !== 'function') return 'sync plugin not installed';
        return qu.syncStatus();
      },
      async ls(prefix = '', limit = 50) {
        const rows = await qu.storage.range(prefix, { limit });
        return print(rows.map(({ key, value }) => ({ key, bytes: SECRET_KEYS.has(key) ? '(masked)' : sizeOf(value) })));
      },
      async get(key) {
        if (SECRET_KEYS.has(key)) return '(masked: private keys)';
        return qu.storage.get(key);
      },
      async dump(prefix = '', limit = 500) {
        const out = {};
        for (const { key, value } of await qu.storage.range(prefix, { limit })) {
          out[key] = SECRET_KEYS.has(key) ? '(masked)' : JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? `hex:${toHex(v)}` : v)));
        }
        return out;
      },
      /** What the caches hold right now (all in RAM; nothing of it is stored or sent). */
      memory() {
        const r = qu.records?.memory?.();
        const s = qu.sync?.memory?.();
        const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
        const rows = {
          'records cache': r ? `${r.cache.records} / ${r.cache.maxRecords} records, ${kb(r.cache.bytes)} / ${kb(r.cache.maxBytes)}` : '-',
          'field indexes': r ? `${r.fields.indexes} indexes, ${r.fields.entries} / ${r.fields.maxEntries} entries (~${kb(r.fields.entries * 200)})` : '-',
          'sync index cache': s ? `${s.indexCache.scopes} scopes, ${s.indexCache.items} / ${s.indexCache.maxItems} items (~${kb(s.indexCache.items * 300)})` : '-',
        };
        const heap = globalThis.performance?.memory?.usedJSHeapSize ?? globalThis.process?.memoryUsage?.().heapUsed;
        if (heap) rows['JS heap (whole page/process)'] = kb(heap);
        print(rows);
        return { records: r ?? null, sync: s ?? null, heap: heap ?? null };
      },
      async stats() {
        if (!qu.stats) return "stats plugin not installed (plugins: [..., 'stats'])";
        return qu.stats.report();
      },
      listeners: (topic) => qu.bus.listenerCount(topic),
      traffic() {
        const net = netOf(qu);
        const seconds = Math.max(1, (Date.now() - net.trafficSince) / 1000);
        const rows = [...net.traffic]
          .map(([type, r]) => ({
            type,
            out: kb(r.bytesOut),
            in: kb(r.bytesIn),
            framesOut: r.framesOut,
            framesIn: r.framesIn,
            perHour: kb(Math.round(((r.bytesOut + r.bytesIn) * 3600) / seconds)),
            total: r.bytesOut + r.bytesIn,
            what: FRAME_TYPES[type] ?? '',
          }))
          .sort((a, b) => b.total - a.total);
        const sum = rows.reduce((t, r) => t + r.total, 0);
        const frames = [...net.traffic.values()].reduce((t, r) => t + r.framesIn + r.framesOut, 0);
        for (const r of rows) r.share = sum ? `${Math.round((r.total / sum) * 100)} %` : '-';
        log(
          `[qu-lite] traffic since ${new Date(net.trafficSince).toLocaleTimeString()} (${Math.round(seconds)} s): ${kb(sum)} in ${frames} frames ` +
            `≈ ${kb(Math.round((sum * 3600) / seconds))}/hour; on the wire roughly +${kb(frames * WIRE_OVERHEAD)} (WebSocket/TLS/TCP)`
        );
        print(rows.map(({ total, ...r }) => r));
        return { since: net.trafficSince, seconds: Math.round(seconds), bytes: sum, frames, wireEstimate: sum + frames * WIRE_OVERHEAD, byType: Object.fromEntries(net.traffic) };
      },
      resetTraffic() {
        const net = netOf(qu);
        net.traffic.clear();
        net.trafficSince = Date.now();
      },
      watchTraffic(seconds = 10) {
        const net = netOf(qu);
        let last = new Map([...net.traffic].map(([t, r]) => [t, { ...r }]));
        const stop = qu.timers.interval(() => {
          const parts = [];
          let total = 0;
          for (const [type, r] of net.traffic) {
            const before = last.get(type) ?? { bytesIn: 0, bytesOut: 0 };
            const delta = r.bytesIn - before.bytesIn + (r.bytesOut - before.bytesOut);
            if (delta) parts.push([type, delta]);
            total += delta;
          }
          last = new Map([...net.traffic].map(([t, r]) => [t, { ...r }]));
          parts.sort((a, b) => b[1] - a[1]);
          log(`[qu-lite] last ${seconds} s: ${kb(total)} (${kb(Math.round(total / seconds))}/s)${parts.length ? ' - ' + parts.map(([t, d]) => `${t} ${kb(d)}`).join(', ') : ''}`);
        }, seconds * 1000);
        watchers.add(stop);
        return () => {
          stop();
          watchers.delete(stop);
        };
      },
      emit: (topic, payload) => qu.bus.emit(topic, payload),
      close() {
        for (const stop of [...traces.values()]) stop();
        for (const stop of watchers) stop();
        if (exposedAs && globalThis[exposedAs] === qu) delete globalThis[exposedAs];
      },
    };
    qu.dev = dev;

    // trace from the start: ?qu-trace=<pattern> or a persisted pattern
    const fromUrl = (() => {
      try {
        return new URL(globalThis.location?.href ?? '').searchParams.get('qu-trace');
      } catch {
        return null;
      }
    })();
    const persisted = storageGet(TRACE_KEY);
    if (fromUrl) trace(fromUrl);
    else if (persisted) trace(persisted, { persist: true });

    if (global) {
      if (globalThis[global] && globalThis[global] !== qu) log(`[qu-lite] globalThis.${global} is taken - this peer is globalThis.${global}_${qu.peerId.slice(0, 4)}`);
      const name = globalThis[global] && globalThis[global] !== qu ? `${global}_${qu.peerId.slice(0, 4)}` : global;
      globalThis[name] = qu;
      exposedAs = name;
      if (browser) log(`%c[qu-lite]%c peer ${qu.peerId} is window.${name} - try ${name}.dev.help()`, 'color:#06c;font-weight:700', 'color:inherit');
    }
    return dev;
  };
  plugin.pluginName = 'devtools';
  return plugin;
}
