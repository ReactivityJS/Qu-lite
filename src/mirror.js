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
 *   - forward records it pulled via resync live to its subscribers (hub),
 *     and ephemeral signals (signals.js) without storing them;
 *   - optional `allow` list: other sids are refused for grants and records;
 *   - expire drop lists past the horizon (gc.js) every `expireEveryMs` -
 *     applying them is the shared envelope layer's job;
 *   - QUOTAS per space (`quota: {records, bytes}`) and a size limit per
 *     envelope (`maxEnvelopeBytes`): usage lives in `mirror/usage/<sid>`,
 *     updated in the same atomic write set as the envelope (and its drops).
 *     Refused envelopes are nack'ed to the sender (its outbox keeps them);
 *     drop lists are always accepted - they free space.
 *   - PUBLIC READS and offline delivery over plain HTTP (public.js): public
 *     records indexed by path, served with the grants to verify them;
 *   - OPEN SPACES (members.js `open`): the PUBLIC moderation records under
 *     `_mod` are applied blind - a banned alias's new envelopes are refused
 *     ('banned'), and in an open space every author except owner and admins
 *     gets a rate limit for fresh writes (`openRate`, records/s; 'rate' -
 *     the sender's outbox keeps the record and retries). State per space in
 *     `mirror/mod/<sid>`, written with the record that changed it.
 *   - at most `maxSpaces` spaces: a space's grant is self-certifying, so
 *     anyone can create new ones - without this limit per-space quotas
 *     don't bound the mirror's storage (`mirror.full` when refused).
 *
 * Install next to `sync({role: 'mirror'})`, without `records()`.
 */
import * as crypto from './crypto.js';
import { envelopes } from './envelopes.js';
import { signals } from './signals.js';
import { readPublic } from './envelope.js';
import { GC_TYPE } from './gc.js';
import { publicRelay } from './public-relay.js';
import { parseHlc } from './hlc.js';

/**
 * @param {{allow?: string[]|null, expireEveryMs?: number, quota?: {records?: number, bytes?: number}|null, maxEnvelopeBytes?: number, maxSpaces?: number|null, openRate?: {rate: number, burst: number}|null}} [options]
 */
export function mirror({ allow = null, expireEveryMs = 6 * 60 * 60 * 1000, quota = null, maxEnvelopeBytes = 256 * 1024, maxSpaces = null, openRate = { rate: 0.2, burst: 20 } } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    const env = envelopes()(qu);
    env.acceptGrants = true;
    env.forwardSynced = true; // a hub: what it pulls from one peer is new for its other subscribers
    signals()(qu); // forwards verified ephemeral signals, never stores them
    const allowed = (sid) => !allow || allow.includes(sid);

    publicRelay(qu, env, { allowed }); // GET /q/<sid>/<path> (public reads), POST /q/in (offline delivery)

    const watchSpace = (sid) => (typeof qu.watch === 'function' ? qu.watch({ space: { sid } }) : undefined);

    bus.on('qu.grant.offer', async ({ sid }, ctx) => {
      if (!allowed(sid)) return ctx.stop();
      // a new space beyond the limit (known spaces keep receiving epoch/admin updates)
      if (maxSpaces !== null && !env.keyring.state(sid) && env.keyring.sids().length >= maxSpaces) {
        ctx.stop();
        await bus.notify('mirror.full', { sid, spaces: env.keyring.sids().length });
      }
    });
    const usageKey = (sid) => `mirror/usage/${sid}`;
    /** Stored usage of a space; built by one scan if missing (older database). */
    async function usage(sid) {
      const stored = await storage.get(usageKey(sid));
      if (stored) return stored;
      const counted = { records: 0, bytes: 0 };
      for (const key of await storage.keys(`rec/${sid}/`)) {
        counted.records++;
        counted.bytes += (await storage.get(key))?.length ?? 0;
      }
      await storage.set(usageKey(sid), counted);
      return counted;
    }

    bus.on('qu.envelope.accept', async ({ header, id, bytes }, ctx) => {
      if (!allowed(header.sid)) return ctx.stop();
      const size = bytes?.length ?? 0;
      if (size > maxEnvelopeBytes) {
        ctx.reason = 'too large';
        return ctx.stop();
      }
      if (!quota || (await storage.has(`rec/${header.sid}/${id}`))) return; // a duplicate costs nothing
      const u = await usage(header.sid);
      const over = (quota.records !== undefined && u.records + 1 > quota.records) || (quota.bytes !== undefined && u.bytes + size > quota.bytes);
      if (over && readPublic(bytes)?.t !== GC_TYPE) {
        ctx.reason = 'quota';
        await bus.notify('mirror.quota', { sid: header.sid, usage: u });
        ctx.stop();
      }
    });
    // --- open spaces: moderation records, applied blind ------------------------
    const mods = new Map(); // sid -> {open, openHlc, bans: {alias: {ban, hlc}}}
    async function modOf(sid) {
      if (!mods.has(sid)) mods.set(sid, (await storage.get(`mirror/mod/${sid}`)) ?? { open: false, openHlc: '', bans: {} });
      return mods.get(sid);
    }
    const hexOf = (key) => (key ? crypto.toHex(key) : null);
    bus.on('qu.envelope.stored', async ({ sid, header, bytes, ws }) => {
      if (header.visibility !== 'public') return;
      const inner = readPublic(bytes);
      if (inner?.p !== '_mod' || typeof inner.k !== 'string' || typeof inner.h !== 'string' || !/^\d{13}-[0-9a-f]{4}$/.test(inner.h)) return;
      const state = env.keyring.state(sid);
      const owner = hexOf(state?.owner);
      const admin = header.author === owner || (state?.admins.list ?? []).some((a) => hexOf(a) === header.author);
      const mod = await modOf(sid);
      if (inner.k === 'open' && header.author === owner && inner.h >= mod.openHlc) {
        mod.open = inner.v?.open === true && !inner.d;
        mod.openHlc = inner.h;
      } else if (inner.k.startsWith('ban:') && admin) {
        const alias = inner.k.slice(4);
        if ((mod.bans[alias]?.hlc ?? '') > inner.h) return;
        mod.bans[alias] = { ban: inner.v?.ban === true && !inner.d, hlc: inner.h };
      } else return;
      ws.set(`mirror/mod/${sid}`, mod);
    });
    const buckets = new Map();
    function overRate(key, t) {
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= 50_000) buckets.clear(); // bounded; a reset only forgives
        buckets.set(key, (b = { tokens: openRate.burst, at: t }));
      }
      b.tokens = Math.min(openRate.burst, b.tokens + ((t - b.at) / 1000) * openRate.rate);
      b.at = t;
      if (b.tokens < 1) return true;
      b.tokens -= 1;
      return false;
    }
    bus.on('qu.envelope.accept', async ({ header, id, bytes }, ctx) => {
      const mod = mods.get(header.sid) ?? (await modOf(header.sid));
      const ban = mod.bans[header.author];
      if (!ban?.ban && !mod.open) return;
      if (readPublic(bytes)?.t === GC_TYPE) return; // drop lists free space
      if (await storage.has(`rec/${header.sid}/${id}`)) return;
      // written after the ban (minute resolution; the members check the exact time)
      if (ban?.ban && header.ts > parseHlc(ban.hlc).ms) {
        ctx.reason = 'banned';
        return ctx.stop();
      }
      if (!mod.open || !openRate) return;
      const state = env.keyring.state(header.sid);
      if (header.author === hexOf(state?.owner) || (state?.admins.list ?? []).some((a) => hexOf(a) === header.author)) return;
      const t = Date.now();
      if (header.ts < t - 10 * 60_000) return; // backlog from a member's sync, not a fresh write
      if (overRate(`${header.sid}/${header.author}`, t)) {
        ctx.reason = 'rate';
        ctx.stop();
      }
    });

    // usage moves with the envelope's own write set: + the envelope, - what its drop list removed
    bus.on('qu.envelope.stored', ({ sid, bytes, ws }) => {
      ws.locked(async () => {
        const u = { ...(await usage(sid)) };
        u.records++;
        u.bytes += bytes.length;
        for (const target of ws.dropped ?? []) {
          const held = await storage.get(`rec/${sid}/${target}`);
          if (!held) continue;
          u.records--;
          u.bytes -= held.length;
        }
        ws.set(usageKey(sid), u);
      });
    });
    bus.on('qu.gc.expired', ({ sid, count, bytes }) =>
      env.exclusive(sid, async () => {
        const u = await usage(sid);
        await storage.set(usageKey(sid), { records: Math.max(0, u.records - count), bytes: Math.max(0, u.bytes - bytes) });
      })
    );
    // Records that arrive before their grant (unknown space or epoch) are dropped
    // unacked. Remember who sent them, so they can be fetched once the grant is
    // here - also from members whose grant came second (two clients reconnecting
    // to a fresh mirror: only the first grant is new). Bounded: a peer that never
    // sends a grant costs at most one entry per space, all dropped when it leaves.
    const early = new Map(); // sid -> Set<peer>
    const EARLY_SPACES = 4096;
    bus.on('qu.record.unknown-space', ({ from, sid }) => {
      if (!from || typeof sid !== 'string') return;
      let set = early.get(sid);
      if (!set) {
        if (early.size >= EARLY_SPACES) return;
        early.set(sid, (set = new Set()));
      }
      if (set.size < 64) set.add(from);
    });
    bus.on('net.peer.down', ({ peer }) => {
      for (const [sid, set] of early) if (set.delete(peer) && !set.size) early.delete(sid);
    });
    bus.on('qu.grant.accepted', async ({ sid, isNew, changed, accepted, from }) => {
      const stored = (await storage.get(`mirror/grants/${sid}`)) ?? [];
      await storage.set(`mirror/grants/${sid}`, [...stored, ...accepted]);
      await bus.notify('mirror.grant', { sid, changed, from });
      if (isNew) await watchSpace(sid);
      // a mirror doesn't reconcile with clients on its own, so fetch what was refused now
      const peers = new Set(early.get(sid));
      early.delete(sid);
      if (isNew && from) peers.add(from);
      if (typeof qu.resync === 'function') for (const peer of peers) qu.resync({ space: { sid }, peer }).catch(() => {});
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

    /** Expires drop lists past the horizon in every served space. @returns {Promise<number>} */
    async function expire() {
      let count = 0;
      for (const sid of env.keyring.sids()) count += await env.expire(sid, qu.clock.now());
      return count;
    }
    if (expireEveryMs > 0) {
      qu.timers.interval(() => expire().catch((error) => bus.error(error, 'mirror.expire')), expireEveryMs);
    }

    const api = {
      ready,
      expire,
      /** @returns {string[]} sids this mirror serves. */
      spaces: async () => (await ready, env.keyring.sids()),
      /** @param {string} sid @returns {Promise<number>} stored envelope count. */
      count: async (sid) => (await storage.keys(`rec/${sid}/`)).length,
      /** @param {string} sid @returns {Promise<{records: number, bytes: number}>} */
      usage,
      /** @param {string} sid @returns {Promise<Map<number, string>>} epoch -> write key (hex). */
      writeKeys: async (sid) => new Map([...env.keyring.epochs(sid)].map(([e, k]) => [e, crypto.toHex(k)])),
      /** @param {string} sid @returns {Promise<string[]>} current admins (hex) */
      admins: async (sid) => (env.keyring.state(sid)?.admins.list ?? []).map((a) => crypto.toHex(a)),
    };
    qu.mirror = api;
    return api;
  };
}
