/**
 * MIRROR - a POLICY on top of the same envelope layer every peer runs
 * (envelopes.js): it stores and serves sealed envelopes of spaces it cannot
 * read. There is no mirror-specific receive/store path - only:
 *
 *   - accept grants (`acceptGrants`, space.js `verifyGrants`): epoch 0 is
 *     self-certifying through the sid (groups also certify their owner),
 *     admin lists must be signed by the owner, later epochs by the owner or
 *     an admin - so a removed member cannot announce the next epoch;
 *   - persist every accepted grant under `mirror/grants/<sid>` and
 *     re-verify the whole chain into the keyring on start;
 *   - watch every granted space whole (with `sync({role: 'mirror'})`);
 *   - forward records it pulled via resync live to its subscribers (hub);
 *   - optional `allow` list: other sids are refused for grants and records.
 *
 * Install next to `sync({role: 'mirror'})`, without `records()`.
 */
import * as crypto from './crypto.js';
import { envelopes } from './envelopes.js';

/** @param {{allow?: string[]|null}} [options] */
export function mirror({ allow = null } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const env = envelopes()(qu);
    env.acceptGrants = true;
    env.forwardSynced = true; // a hub: what it pulls from one peer is new for its other subscribers
    const allowed = (sid) => !allow || allow.includes(sid);

    const watchSpace = (sid) => (typeof qu.watch === 'function' ? qu.watch({ space: { sid } }) : undefined);

    bus.on('qu.grant.offer', ({ sid }, ctx) => {
      if (!allowed(sid)) ctx.stop();
    });
    bus.on('qu.envelope.accept', ({ header }, ctx) => {
      if (!allowed(header.sid)) ctx.stop();
    });
    bus.on('qu.grant.accepted', async ({ sid, isNew, changed, accepted, from }) => {
      const stored = (await storage.get(`mirror/grants/${sid}`)) ?? [];
      await storage.set(`mirror/grants/${sid}`, [...stored, ...accepted]);
      await bus.notify('mirror.grant', { sid, changed, from });
      if (isNew) await watchSpace(sid);
    });

    /** Re-verifies every stored grant chain into the keyring and watches those spaces. */
    const ready = (async () => {
      const sids = [];
      for (const key of await storage.keys('mirror/grants/')) {
        const sid = key.split('/')[2];
        const { changed } = await env.keyring.accept(sid, await storage.get(key));
        if (changed.length) sids.push(sid);
      }
      for (const sid of sids) await watchSpace(sid);
      return sids;
    })();

    const api = {
      ready,
      /** @returns {string[]} sids this mirror serves. */
      spaces: async () => (await ready, env.keyring.sids()),
      /** @param {string} sid @returns {Promise<number>} stored envelope count. */
      count: async (sid) => (await storage.keys(`rec/${sid}/`)).length,
      /** @param {string} sid @returns {Promise<Map<number, string>>} epoch -> write key (hex). */
      writeKeys: async (sid) => new Map([...env.keyring.epochs(sid)].map(([e, k]) => [e, crypto.toHex(k)])),
      /** @param {string} sid @returns {Promise<string[]>} current admins (hex) */
      admins: async (sid) => (env.keyring.state(sid)?.admins.list ?? []).map((a) => crypto.toHex(a)),
    };
    qu.mirror = api;
    return api;
  };
}
