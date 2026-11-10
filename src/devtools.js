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

const SECRET_KEYS = new Set(['qu/identity']);
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
      async stats() {
        if (!qu.stats) return "stats plugin not installed (plugins: [..., 'stats'])";
        return qu.stats.report();
      },
      listeners: (topic) => qu.bus.listenerCount(topic),
      emit: (topic, payload) => qu.bus.emit(topic, payload),
      close() {
        for (const stop of [...traces.values()]) stop();
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
