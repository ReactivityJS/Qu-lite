/**
 * ENVELOPES - the blind envelope layer every peer runs, browser client and
 * mirror alike. It never decrypts: it checks the public header and BOTH
 * signatures against the space's write public key (from the keyring),
 * dedupes, stores the sealed bytes plus the public sync index, routes live
 * records on, and reports the outcome. Reading is a separate plugin
 * (`records()`), which hooks into `qu.envelope.stored`.
 *
 *   ingest:  net.in.<peer>.rec | local write
 *            -> emit('qu.envelope.accept', {header, from})   ctx.stop() refuses (policy)
 *            -> dedupe -> keyring lookup -> verifyEnvelope
 *            -> store rec/ + sx/
 *            -> emit('qu.envelope.stored', {...})             a reader may ctx.stop()
 *                                                             (envelope removed again) or
 *                                                             set ctx.status
 *            -> emit('qu.write.stored') for local writes      (sync: outbox)
 *            -> run('qu.route') + emit('net.out.<peer>.rec')  unless fetched by a resync
 *            -> notify('qu.record.processed', {from, sid, id, status})
 *
 *   keyring: (sid, epoch) -> write public key. Members register their own
 *            spaces (`register()`); a mirror fills it from verified grants.
 *
 *   grants:  `register(space, {mirror: true})` spaces are announced - write
 *            PUBLIC keys only - to peers that said `hello {role: 'mirror'}`,
 *            never to ordinary peers. With `acceptGrants` (mirrors) offered
 *            grants are verified (space.js `verifyGrants`) into the keyring
 *            and reported as `qu.grant.accepted`; `qu.grant.offer` can veto.
 *
 * Storage: rec/<sid>/<id> (sealed bytes), sx/<sid>/<shard>/<ts>-<id> (sync index).
 */
import { peekEnvelope, verifyEnvelope, envelopeId } from './envelope.js';
import { verifyGrants } from './space.js';

const pad = (ms) => String(ms).padStart(13, '0');

/** Sync-index key for a record - derivable from the public header alone. */
export const sxKey = (header, id) => `sx/${header.sid}/${header.shard}/${pad(header.ts)}-${id}`;

/** @param {{acceptGrants?: boolean}} [options] */
export function envelopes({ acceptGrants = false } = {}) {
  return (qu) => {
    if (qu.envelopes) return qu.envelopes;
    const { bus, storage } = qu;
    const peers = new Set();
    const roles = new Map();
    /** @type {Map<string, Promise<object>>} id -> outcome of the ingest currently running for it. */
    const inFlight = new Map();
    /** @type {Map<string, Map<number, Uint8Array>>} */
    const keyring = new Map();
    /** @type {Map<string, {space: import('./space.js').Space, mirror: boolean}>} */
    const registered = new Map();

    const ring = {
      /** @param {string} sid @param {number} epoch @param {Uint8Array} writePub */
      set(sid, epoch, writePub) {
        if (!keyring.has(sid)) keyring.set(sid, new Map());
        keyring.get(sid).set(epoch, writePub);
      },
      get: (sid, epoch) => keyring.get(sid)?.get(epoch),
      epochs: (sid) => new Map(keyring.get(sid) ?? []),
      has: (sid) => keyring.has(sid),
      sids: () => [...keyring.keys()],
    };

    bus.on('net.peer.up', ({ peer }) => peers.add(peer));
    bus.on('net.peer.down', ({ peer }) => {
      peers.delete(peer);
      roles.delete(peer);
    });
    bus.on('net.in.*.hello', async ({ role }, ctx) => {
      const peer = ctx.topic.split('.')[2];
      roles.set(peer, role);
      if (role === 'mirror') for (const [sid, entry] of registered) if (entry.mirror) await announce(sid, [peer]);
    });
    bus.on('net.in.*.rec', ({ bytes, sync }, ctx) => ingest(bytes, { from: ctx.topic.split('.')[2], sync }));
    bus.on('net.in.*.grant', async ({ sid, grants }, ctx) => {
      if (!api.acceptGrants || typeof sid !== 'string' || !Array.isArray(grants)) return;
      const from = ctx.topic.split('.')[2];
      const offer = await bus.emit('qu.grant.offer', { sid, from });
      if (offer.stopped) return;
      const accepted = await verifyGrants(sid, grants, ring.epochs(sid));
      if (accepted.size === 0) return;
      const isNew = !ring.has(sid);
      for (const [epoch, writePub] of accepted) ring.set(sid, epoch, writePub);
      await bus.notify('qu.grant.accepted', { sid, from, isNew, keys: accepted });
    });

    /** Removes a sealed envelope and its sync-index entry. */
    async function remove(sid, id) {
      const bytes = await storage.get(`rec/${sid}/${id}`);
      if (bytes) await storage.remove(sxKey(peekEnvelope(bytes), id));
      await storage.remove(`rec/${sid}/${id}`);
    }

    /**
     * The one way an envelope enters this peer - from the network or from a
     * local write.
     * @param {Uint8Array} bytes
     * @param {{from?: string, sync?: boolean, local?: boolean}} [options]
     * @returns {Promise<{id?: string, sid?: string, status: string, reason?: string}>}
     */
    async function ingest(bytes, { from, sync = false, local = false } = {}) {
      const finish = async (outcome) => {
        await bus.notify('qu.record.processed', { from, ...outcome });
        return outcome;
      };
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch (error) {
        await bus.notify('qu.record.rejected', { from, reason: error.message });
        return finish({ status: 'rejected', reason: error.message });
      }
      const { sid } = header;
      const id = await envelopeId(bytes);
      // One ingest per id at a time: a second copy (live push + resync reply)
      // waits for the first, so "processed" always means "settled".
      while (inFlight.has(id)) await inFlight.get(id);
      let settle;
      inFlight.set(id, new Promise((resolve) => (settle = resolve)));
      try {
        const policy = await bus.emit('qu.envelope.accept', { header, id, from, local });
        if (policy.stopped) return finish({ sid, id, status: 'rejected', reason: 'policy' });
        if (await storage.has(`rec/${sid}/${id}`)) {
          await bus.notify('qu.record.duplicate', { from, space: sid, id });
          return finish({ sid, id, status: 'duplicate' });
        }
        // A member's own space may have rotated since it registered: refresh from the Space itself.
        const writePub = ring.get(sid, header.epoch) ?? registered.get(sid)?.space.writeKeys().get(header.epoch);
        if (writePub && !ring.get(sid, header.epoch)) ring.set(sid, header.epoch, writePub);
        if (!writePub) {
          await bus.notify('qu.record.unknown-space', { from, sid, epoch: header.epoch });
          return finish({ sid, id, status: 'unknown-space' });
        }
        if (!local && !(await verifyEnvelope(bytes, writePub))) {
          await bus.notify('qu.record.rejected', { from, space: sid, id, reason: 'signature invalid' });
          return finish({ sid, id, status: 'rejected', reason: 'signature invalid' });
        }
        await storage.set(`rec/${sid}/${id}`, bytes);
        await storage.set(sxKey(header, id), 1);

        const stored = await bus.emit('qu.envelope.stored', { sid, id, header, bytes, from, sync, local });
        if (stored.stopped) {
          await remove(sid, id);
          const reason = stored.reason ?? 'refused';
          await bus.notify('qu.record.rejected', { from, space: sid, id, reason });
          return finish({ sid, id, status: 'rejected', reason });
        }
        if (local) await bus.emit('qu.write.stored', { sid, id });
        if (!sync) {
          const { peers: targets } = await bus.run('qu.route', { sid, shard: header.shard, peers: [...peers], except: from });
          for (const peer of targets) if (peer !== from) await bus.emit(`net.out.${peer}.rec`, { bytes });
        }
        return finish({ sid, id, status: stored.status ?? 'stored' });
      } finally {
        inFlight.delete(id);
        settle();
      }
    }

    /**
     * Sends a registered space's grants to `targets` (default: every
     * connected mirror). Call again after `space.rotate()`/`acceptEpoch()`.
     * @param {string} sid
     * @param {string[]} [targets]
     */
    async function announce(sid, targets) {
      const entry = registered.get(sid);
      if (!entry) return;
      const grants = await entry.space.grants();
      for (const g of grants) ring.set(sid, g.epoch, g.writePub);
      const to = targets ?? [...peers].filter((p) => roles.get(p) === 'mirror');
      for (const peer of to) await bus.emit(`net.out.${peer}.grant`, { sid, grants });
    }

    /**
     * Makes a space's write keys known to this peer's keyring and (if
     * `mirror`) announces them to connected mirrors.
     * @param {import('./space.js').Space} space
     * @param {{mirror?: boolean}} [options]
     */
    async function register(space, { mirror = true } = {}) {
      registered.set(space.id, { space, mirror });
      for (const [epoch, writePub] of space.writeKeys()) ring.set(space.id, epoch, writePub);
      await announce(space.id, mirror ? undefined : []);
    }

    const api = { ingest, remove, register, announce, keyring: ring, acceptGrants, roles };
    qu.envelopes = api;
    qu.keyring = ring;
    return api;
  };
}
