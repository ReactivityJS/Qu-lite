/**
 * STATS - operating figures of a peer, for a relay's dashboard or a client's
 * "network" panel: traffic in/out (total, per open connection, current
 * throughput), connections, record outcomes, sync activity, storage.
 * Optional: nothing in the core needs it, and without it nothing is counted
 * beyond the two additions per frame every link does anyway (link.js).
 *
 *   qu.use(stats())
 *   qu.stats.snapshot()        // sync, cheap: traffic, peers, connections, counters
 *   await qu.stats.storage()   // async, scans key names: spaces, records, bytes, outbox
 *   await qu.stats.report()    // both
 *   await qu.stats.prometheus() // the report in Prometheus text format (relay: /metrics)
 *   qu.bus.on('qu.stats', (snapshot) => ...)   // every `emitMs`, if set (a live UI)
 *
 * Traffic comes from the link counters (`qu.net.links`, final values in
 * `net.peer.down`), so it is exact and costs nothing per frame here.
 * Throughput is the change over the last `windowMs`, sampled every
 * `sampleMs` (one timer, unref'd). Everything else is counted from bus
 * events (`qu.record.processed`, `sync.done`, `net.limited`, ...).
 *
 * Privacy: per-peer figures name only network ids (random per device or
 * per connection, never identities) and contain no space ids. A relay
 * exposes the report only with a token (ws-server.js `statsToken`).
 */
import { netOf } from './net/link.js';

const ZERO = () => ({ sent: 0, received: 0, framesOut: 0, framesIn: 0 });

/**
 * @param {{windowMs?: number, sampleMs?: number, emitMs?: number, storageCacheMs?: number}} [options]
 *   `emitMs`: notify `qu.stats` with a snapshot this often (0: never).
 *   `storageCacheMs`: `storage()` results are reused this long (scrapes stay cheap).
 */
export function stats({ windowMs = 10_000, sampleMs = 1000, emitMs = 0, storageCacheMs = 5000 } = {}) {
  return (qu) => {
    if (qu.stats) return qu.stats;
    const { bus, storage } = qu;
    const net = netOf(qu);
    const started = Date.now();
    const closed = ZERO(); // counters of links that are gone
    const connections = { total: 0, peak: 0 };
    const records = { local: {}, remote: {} };
    const counters = { reconciles: 0, syncErrors: 0, staleRetired: 0, rateLimited: 0, quotaRefused: 0, refusedByPeer: 0 };
    /** @type {Array<{t: number, in: number, out: number, peers: Map<string, {in: number, out: number}>}>} */
    const samples = [];

    bus.on('net.peer.up', () => {
      connections.total++;
      connections.peak = Math.max(connections.peak, net.links.size);
    });
    bus.on('net.peer.down', ({ stats: final }) => {
      if (!final) return;
      for (const k of Object.keys(closed)) closed[k] += final[k] ?? 0;
    });
    bus.on('qu.record.processed', ({ from, status }) => {
      const bucket = from ? records.remote : records.local;
      bucket[status] = (bucket[status] ?? 0) + 1;
    });
    bus.on('sync.done', () => counters.reconciles++);
    bus.on('sync.error', () => counters.syncErrors++);
    bus.on('sync.stale', ({ retired }) => (counters.staleRetired += retired ?? 0));
    bus.on('net.limited', () => counters.rateLimited++);
    bus.on('mirror.quota', () => counters.quotaRefused++);
    bus.on('qu.record.refused', () => counters.refusedByPeer++);

    /** Totals over closed and open links. */
    function totals() {
      const t = { ...closed };
      for (const { stats: s } of net.links.values()) for (const k of Object.keys(t)) t[k] += s[k];
      return t;
    }

    function sample() {
      const t = totals();
      const peers = new Map([...net.links].map(([peer, { stats: s }]) => [peer, { in: s.received, out: s.sent }]));
      samples.push({ t: Date.now(), in: t.received, out: t.sent, peers });
      const keep = Math.max(2, Math.ceil(windowMs / sampleMs) + 1);
      while (samples.length > keep) samples.shift();
    }
    sample();
    const sampler = setInterval(sample, sampleMs);
    sampler.unref?.();

    /** Bytes per second between the oldest sample in the window and now. */
    const rate = (now, value, oldest) => (oldest && now > oldest.t ? Math.max(0, Math.round(((value - oldest.value) * 1000) / (now - oldest.t))) : 0);

    /**
     * Traffic, connections and counters - synchronous, no storage access.
     * @returns {object}
     */
    function snapshot() {
      const now = Date.now();
      const t = totals();
      const first = samples[0];
      const peers = [...net.links].map(([peer, { via, since, stats: s }]) => {
        // the oldest sample that already knew this link (a younger link: its start, counters 0)
        const seen = samples.find((x) => x.peers.has(peer));
        const base = seen ? { t: seen.t, ...seen.peers.get(peer) } : { t: since, in: 0, out: 0 };
        return {
          peer,
          via,
          since,
          bytesIn: s.received,
          bytesOut: s.sent,
          framesIn: s.framesIn,
          framesOut: s.framesOut,
          inBps: rate(now, s.received, { t: base.t, value: base.in }),
          outBps: rate(now, s.sent, { t: base.t, value: base.out }),
        };
      });
      return {
        at: now,
        uptime: Math.round((now - started) / 1000),
        connections: { open: net.links.size, total: connections.total, peak: connections.peak },
        traffic: {
          bytesIn: t.received,
          bytesOut: t.sent,
          framesIn: t.framesIn,
          framesOut: t.framesOut,
          inBps: rate(now, t.received, first && { t: first.t, value: first.in }),
          outBps: rate(now, t.sent, first && { t: first.t, value: first.out }),
        },
        peers,
        records: { local: { ...records.local }, remote: { ...records.remote } },
        counters: { ...counters },
      };
    }

    let cached = null;
    /**
     * What this peer stores. A mirror reports its kept usage per space; any
     * other peer counts envelope keys per space it knows (no values read).
     * @returns {Promise<{spaces: number, records: number, bytes: number|null, outbox: number|null, pending: number|null, driverBytes: number|null, quota: number|null}>}
     */
    async function storageReport() {
      if (cached && Date.now() - cached.at < storageCacheMs) return cached.value;
      const sids = qu.mirror ? await qu.mirror.spaces() : (qu.keyring?.sids?.() ?? []);
      let count = 0;
      let bytes = qu.mirror ? 0 : null;
      for (const sid of sids) {
        if (qu.mirror) {
          const u = await qu.mirror.usage(sid);
          count += u.records;
          bytes += u.bytes;
        } else count += (await storage.keys(`rec/${sid}/`)).length;
      }
      const sync = typeof qu.syncStatus === 'function' ? await qu.syncStatus() : null;
      let driverBytes = (await qu.root?.size?.().catch(() => null)) ?? null;
      let quota = null;
      // a browser: what the origin uses of its storage (IndexedDB and everything else)
      const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => null);
      if (estimate) {
        driverBytes ??= estimate.usage ?? null;
        quota = estimate.quota ?? null;
      }
      const value = { spaces: sids.length, records: count, bytes, outbox: sync?.outbox ?? null, pending: sync?.pending ?? null, driverBytes, quota };
      cached = { at: Date.now(), value };
      return value;
    }

    const report = async () => ({ ...snapshot(), storage: await storageReport() });

    /** @returns {Promise<string>} the report in Prometheus text exposition format */
    async function prometheus() {
      const r = await report();
      const lines = [];
      const metric = (name, type, help, samples) => {
        lines.push(`# HELP qu_lite_${name} ${help}`, `# TYPE qu_lite_${name} ${type}`);
        for (const [labels, value] of samples) if (value !== null && value !== undefined) lines.push(`qu_lite_${name}${labels} ${value}`);
      };
      const one = (value) => [['', value]];
      metric('uptime_seconds', 'gauge', 'Seconds since the stats plugin started.', one(r.uptime));
      metric('received_bytes_total', 'counter', 'Bytes received over all links.', one(r.traffic.bytesIn));
      metric('sent_bytes_total', 'counter', 'Bytes sent over all links.', one(r.traffic.bytesOut));
      metric('received_frames_total', 'counter', 'Frames received over all links.', one(r.traffic.framesIn));
      metric('sent_frames_total', 'counter', 'Frames sent over all links.', one(r.traffic.framesOut));
      metric('receive_bytes_per_second', 'gauge', `Receive throughput over the last ${windowMs / 1000} s.`, one(r.traffic.inBps));
      metric('send_bytes_per_second', 'gauge', `Send throughput over the last ${windowMs / 1000} s.`, one(r.traffic.outBps));
      metric('connections', 'gauge', 'Open connections.', one(r.connections.open));
      metric('connections_total', 'counter', 'Connections opened.', one(r.connections.total));
      metric('connections_peak', 'gauge', 'Most connections open at once.', one(r.connections.peak));
      const processed = [];
      for (const [origin, by] of Object.entries(r.records)) for (const [status, n] of Object.entries(by)) processed.push([`{origin="${origin}",status="${status}"}`, n]);
      metric('records_processed_total', 'counter', 'Envelopes processed, by origin (local write / remote) and outcome.', processed);
      metric('reconciles_total', 'counter', 'Completed reconcile sessions.', one(r.counters.reconciles));
      metric('sync_errors_total', 'counter', 'Failed reconcile sessions.', one(r.counters.syncErrors));
      metric('rate_limited_total', 'counter', 'Frames dropped by rate limits.', one(r.counters.rateLimited));
      metric('quota_refused_total', 'counter', 'Envelopes refused because a space quota was full.', one(r.counters.quotaRefused));
      metric('stale_retired_total', 'counter', 'Old records a stale device retired instead of pushing.', one(r.counters.staleRetired));
      metric('spaces', 'gauge', 'Spaces stored.', one(r.storage.spaces));
      metric('records', 'gauge', 'Envelopes stored.', one(r.storage.records));
      metric('records_bytes', 'gauge', 'Bytes of stored envelopes (mirror).', one(r.storage.bytes));
      metric('storage_bytes', 'gauge', 'Bytes the store uses (database file / browser estimate).', one(r.storage.driverBytes));
      metric('outbox', 'gauge', 'Local writes not yet acknowledged.', one(r.storage.outbox));
      metric('pending_reconciles', 'gauge', 'Reconciles not yet completed.', one(r.storage.pending));
      return `${lines.join('\n')}\n`;
    }

    if (emitMs > 0) {
      const emitter = setInterval(() => bus.notify('qu.stats', snapshot()), emitMs);
      emitter.unref?.();
    }

    const api = { snapshot, storage: storageReport, report, prometheus };
    qu.stats = api;
    return api;
  };
}
