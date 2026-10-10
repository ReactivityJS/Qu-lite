/**
 * SIGNALS - ephemeral remote events (presence, typing, …). A signal is an
 * ordinary sealed envelope (path `_sig/<type>`, alias author, private, the
 * current epoch) that travels as net type `sig` instead of `rec` and is
 * NEVER stored - so heartbeats cost no storage and never show up in sync.
 *
 *   send:     seal -> route (`qu.route`: peers that subscribed the space)
 *   receive:  header -> not seen before (LRU) -> fresh (minute header and
 *             precise HLC within `maxAgeMs`) -> both signatures (keyring)
 *             -> member: open -> `qu.accept` (members rules)
 *             -> notify('qu.signal.<sid>.<type>', {author, value, at, sid})
 *   hub:      a mirror (`envelopes.forwardSynced`) forwards verified signals
 *             to its other subscribers without storing or reading them;
 *             ordinary peers never forward (no loops).
 *
 *   await qu.signal(space, 'typing', {path: 'chat'})
 *   qu.bus.on(`qu.signal.${space.id}.typing`, ({author, value}) => …)
 */
import { sealEnvelope, openEnvelope, peekEnvelope, verifyEnvelope, envelopeId } from './envelope.js';
import { envelopes } from './envelopes.js';

const PREFIX = '_sig/';

/** @param {{maxAgeMs?: number, maxFutureMs?: number, seenSize?: number}} [options] */
export function signals({ maxAgeMs = 60_000, maxFutureMs = 5 * 60_000, seenSize = 5000 } = {}) {
  return (qu) => {
    if (qu.signals) return qu.signals;
    const { bus, clock, identity } = qu;
    const env = envelopes()(qu);
    const peers = new Set();
    const seen = new Set();

    bus.on('net.peer.up', ({ peer }) => peers.add(peer));
    bus.on('net.peer.down', ({ peer }) => peers.delete(peer));

    const remember = (id) => {
      seen.add(id);
      if (seen.size > seenSize) seen.delete(seen.values().next().value);
    };

    async function route(bytes, header, except) {
      const { peers: targets } = await bus.run('qu.route', { sid: header.sid, shard: header.shard, peers: [...peers], except });
      for (const peer of targets) if (peer !== except) await bus.emit(`net.out.${peer}.sig`, { bytes });
    }

    /**
     * @param {import('./space.js').Space|string} spaceRef
     * @param {string} type - one path segment, e.g. 'presence', 'typing'
     * @param {*} value
     */
    async function send(spaceRef, type, value = null) {
      const space = typeof spaceRef === 'string' ? qu.space?.(spaceRef) : spaceRef;
      if (!space) throw new Error('signal: unknown space');
      const signer = await space.authorFor(identity);
      const { bytes, id } = await sealEnvelope(space, { path: PREFIX + type, hlc: clock.tick(), value }, signer);
      remember(id);
      await route(bytes, peekEnvelope(bytes));
    }

    bus.on('net.in.*.sig', async ({ bytes }, ctx) => {
      const from = ctx.topic.split('.')[2];
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch {
        return;
      }
      const now = Date.now();
      if (header.ts < now - maxAgeMs - 60_000 || header.ts > now + maxFutureMs) return bus.notify('qu.signal.dropped', { from, reason: 'stale' });
      const id = await envelopeId(bytes);
      if (seen.has(id)) return;
      remember(id);
      const writePub = env.keyring.get(header.sid, header.epoch);
      if (!writePub || !(await verifyEnvelope(bytes, writePub))) return bus.notify('qu.signal.dropped', { from, sid: header.sid, reason: 'unverified' });

      const space = qu.space?.(header.sid);
      if (space && space.hasEpoch(header.epoch)) {
        try {
          const record = await openEnvelope(space, bytes, { verify: false });
          const at = Number(record.hlc.slice(0, 13));
          if (!record.path.startsWith(PREFIX) || at < now - maxAgeMs || at > now + maxFutureMs) throw new Error('stale');
          const verdict = await bus.emit('qu.accept', record, { space, from, signal: true });
          if (verdict.stopped || verdict.defer) throw new Error(verdict.reason ?? 'not accepted');
          const type = record.path.slice(PREFIX.length);
          await bus.notify(`qu.signal.${header.sid}.${type}`, { sid: header.sid, type, author: record.author, value: record.value, at, from });
        } catch (error) {
          await bus.notify('qu.signal.dropped', { from, sid: header.sid, reason: error.message });
        }
      }
      if (env.forwardSynced) await route(bytes, header, from);
    });

    const api = { send };
    qu.signals = api;
    qu.signal = send;
    return api;
  };
}
