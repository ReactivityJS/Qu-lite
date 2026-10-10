/**
 * MIRROR - stores and serves sealed envelopes for spaces it cannot read.
 * Install INSTEAD of `records()`, next to `sync({role: 'mirror'})`.
 *
 *   grant  `net.in.<peer>.grant {sid, grants}` - epoch 0's write key must
 *          hash to the sid (self-certifying), later epochs must be signed by
 *          the previous one (space.js `verifyGrants`). Verified keys are
 *          persisted under `mirror/grant/<sid>/<epoch>` and the space is
 *          watched (whole space) from then on.
 *   rec    header only: known space + epoch, outer signature valid, not a
 *          duplicate -> store `rec/` + `sx/`, ack via `qu.record.processed`,
 *          route live to subscribed peers.
 *
 * `allow` (optional) restricts which sids are accepted at all.
 */
import { QuCrypto } from '@qu/core';
import { peekEnvelope, verifyOuter, envelopeId } from './envelope.js';
import { verifyGrants } from './space.js';
import { sxKey } from './records.js';

/** @param {{allow?: string[]|null}} [options] */
export function mirror({ allow = null } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const peers = new Set();
    /** @type {Map<string, Map<number, Uint8Array>>} */
    const grants = new Map();
    const inFlight = new Set();
    const allowed = (sid) => !allow || allow.includes(sid);

    bus.on('net.peer.up', ({ peer }) => peers.add(peer));
    bus.on('net.peer.down', ({ peer }) => peers.delete(peer));

    async function keysFor(sid) {
      if (!grants.has(sid)) {
        const known = new Map();
        for (const key of await storage.keys(`mirror/grant/${sid}/`)) known.set(Number(key.split('/').pop()), await storage.get(key));
        grants.set(sid, known);
      }
      return grants.get(sid);
    }

    async function watchSpace(sid) {
      if (typeof qu.watch === 'function') await qu.watch({ space: { sid } });
    }

    /** Restores watches for every space granted before a restart. */
    const ready = (async () => {
      const sids = new Set((await storage.keys('mirror/grant/')).map((k) => k.split('/')[2]));
      for (const sid of sids) await watchSpace(sid);
      return [...sids];
    })();

    bus.on('net.in.*.grant', async ({ sid, grants: offered }, ctx) => {
      if (typeof sid !== 'string' || !allowed(sid) || !Array.isArray(offered)) return;
      await ready;
      const known = await keysFor(sid);
      const isNew = known.size === 0;
      const accepted = await verifyGrants(sid, offered, known);
      for (const [epoch, writePub] of accepted) {
        known.set(epoch, writePub);
        await storage.set(`mirror/grant/${sid}/${epoch}`, writePub);
      }
      if (accepted.size) await bus.notify('mirror.grant', { sid, epochs: [...accepted.keys()], from: ctx.topic.split('.')[2] });
      if (isNew && known.size) await watchSpace(sid);
    });

    bus.on('net.in.*.rec', async ({ bytes, sync }, ctx) => {
      const from = ctx.topic.split('.')[2];
      const done = (status, extra) => bus.notify('qu.record.processed', { from, status, ...extra });
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch {
        return done('rejected');
      }
      const id = await envelopeId(bytes);
      const writePub = allowed(header.sid) ? (await keysFor(header.sid)).get(header.epoch) : undefined;
      if (!writePub) return done('unknown-space', { sid: header.sid, id });
      if (inFlight.has(id) || (await storage.has(`rec/${header.sid}/${id}`))) return done('duplicate', { sid: header.sid, id });
      inFlight.add(id);
      try {
        if (!(await verifyOuter(bytes, writePub))) {
          await bus.notify('mirror.rejected', { from, sid: header.sid, reason: 'outer signature invalid' });
          return done('rejected', { sid: header.sid, id });
        }
        await storage.set(`rec/${header.sid}/${id}`, bytes);
        await storage.set(sxKey(header, id), 1);
        await bus.notify('mirror.stored', { from, sid: header.sid, id, size: bytes.length });
        if (!sync) {
          const { peers: targets } = await bus.run('qu.route', { sid: header.sid, shard: header.shard, peers: [...peers], except: from });
          for (const peer of targets) if (peer !== from) await bus.emit(`net.out.${peer}.rec`, { bytes });
        }
        return done('stored', { sid: header.sid, id });
      } finally {
        inFlight.delete(id);
      }
    });

    const api = {
      ready,
      /** @returns {Promise<string[]>} sids this mirror serves. */
      spaces: async () => [...new Set((await storage.keys('mirror/grant/')).map((k) => k.split('/')[2]))],
      /** @param {string} sid @returns {Promise<number>} stored envelope count. */
      count: async (sid) => (await storage.keys(`rec/${sid}/`)).length,
      writeKeys: async (sid) => new Map([...(await keysFor(sid))].map(([e, k]) => [e, QuCrypto.toHex(k)])),
    };
    qu.mirror = api;
    return api;
  };
}
