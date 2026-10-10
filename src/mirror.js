/**
 * MIRROR - a POLICY on top of the same envelope layer every peer runs
 * (envelopes.js): it stores and serves sealed envelopes of spaces it cannot
 * read. There is no mirror-specific receive/store path - only:
 *
 *   - accept grants (`acceptGrants`): epoch 0's write key must hash to the
 *     sid (group spaces and user nodes are both self-certifying), later
 *     epochs must be signed by the previous one;
 *   - persist verified write keys under `mirror/grant/<sid>/<epoch>` and
 *     load them into the keyring on start;
 *   - watch every granted space whole (with `sync({role: 'mirror'})`);
 *   - optional `allow` list: other sids are refused for grants and records.
 *
 * Install next to `sync({role: 'mirror'})`, without `records()`.
 */
import { QuCrypto } from '@qu/core';
import { envelopes } from './envelopes.js';

/** @param {{allow?: string[]|null}} [options] */
export function mirror({ allow = null } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const env = envelopes()(qu);
    env.acceptGrants = true;
    const allowed = (sid) => !allow || allow.includes(sid);

    const watchSpace = (sid) => (typeof qu.watch === 'function' ? qu.watch({ space: { sid } }) : undefined);

    bus.on('qu.grant.offer', ({ sid }, ctx) => {
      if (!allowed(sid)) ctx.stop();
    });
    bus.on('qu.envelope.accept', ({ header }, ctx) => {
      if (!allowed(header.sid)) ctx.stop();
    });
    bus.on('qu.grant.accepted', async ({ sid, isNew, keys, from }) => {
      for (const [epoch, writePub] of keys) await storage.set(`mirror/grant/${sid}/${epoch}`, writePub);
      await bus.notify('mirror.grant', { sid, epochs: [...keys.keys()], from });
      if (isNew) await watchSpace(sid);
    });

    /** Restores the keyring and watches for every space granted before a restart. */
    const ready = (async () => {
      const sids = new Set();
      for (const key of await storage.keys('mirror/grant/')) {
        const [, , sid, epoch] = key.split('/');
        env.keyring.set(sid, Number(epoch), await storage.get(key));
        sids.add(sid);
      }
      for (const sid of sids) await watchSpace(sid);
      return [...sids];
    })();

    const api = {
      ready,
      /** @returns {string[]} sids this mirror serves. */
      spaces: async () => (await ready, env.keyring.sids()),
      /** @param {string} sid @returns {Promise<number>} stored envelope count. */
      count: async (sid) => (await storage.keys(`rec/${sid}/`)).length,
      /** @param {string} sid @returns {Promise<Map<number, string>>} epoch -> write key (hex). */
      writeKeys: async (sid) => new Map([...env.keyring.epochs(sid)].map(([e, k]) => [e, QuCrypto.toHex(k)])),
    };
    qu.mirror = api;
    return api;
  };
}
