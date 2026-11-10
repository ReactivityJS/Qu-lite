/**
 * PUSH (relay side) - wakes devices that are not connected, by Web Push
 * WITHOUT payload: the push only says "look", the service worker asks the
 * relay what it is about (sw.js) and shows it. No content ever goes through
 * Apple's, Google's or Mozilla's push service, and no payload encryption
 * (RFC 8291) is needed - only the VAPID signature (RFC 8292).
 *
 *   createRelay({ push: { subject: 'mailto:ops@example.org' } })
 *
 * HTTP (http.js routes, CORS for any origin):
 *
 *   GET  /push/key          -> {key}  VAPID public key (base64url) for pushManager.subscribe()
 *   POST /push/subscribe    {endpoint, peer?, spaces: [{sid, epoch, sig, author?, shards?}]}
 *   POST /push/unsubscribe  {endpoint, sids?}
 *   POST /push/pending      {endpoint} -> {spaces: [{sid, count, kind, at}]}   (and resets them)
 *   POST /push/ring         {sid, epoch, at, kind, sig, peer?}   wake the other members now (a call)
 *
 * MEMBERSHIP, BLIND: `sig` is a signature with the space's epoch WRITE key
 * over `qu-lite/push\n<sid>\n<endpoint>` (a ring: `qu-lite/ring\n<sid>\n<at>\n<kind>`)
 * - only members hold it, and the relay checks it with the write public key
 * it already has from the grants. It learns nothing new about the content.
 *
 * WHAT WAKES: a new record in a subscribed space, unless
 *   - its author is the subscriber itself (`author`: its alias there),
 *   - `shards` are given and the record's shard tag is not among them (the
 *     client lists the opaque tags of the paths it cares about, e.g. 'chat' -
 *     receipts, presence and profile edits then wake nobody),
 *   - the device is connected right now (`peer`: it gets the record live).
 * Pushes to one device are throttled (`minIntervalMs`, trailing): a burst of
 * 30 messages is one push with count 30. A ring is sent at once (urgency
 * high, short TTL). Subscriptions are kept in the relay's store; endpoints
 * the push service reports gone (404/410) are dropped.
 */
import * as crypto from './crypto.js';
import { route, json, readJson, httpError, rateLimit } from './net/http.js';
import { readPublic } from './envelope.js';
import { GC_TYPE } from './gc.js';
import { pushMessage, ringMessage } from './push.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const b64url = (bytes) => crypto.toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SID = /^[0-9a-f]{32}$/;
const HEX = /^[0-9a-f]+$/;

/**
 * @param {{subject?: string, minIntervalMs?: number, ttl?: number, ringTtl?: number, maxSubscriptions?: number, maxSpaces?: number, fetch?: typeof fetch}} [options]
 *   `subject`: contact for push services (mailto: or https:), Apple requires a real one.
 */
export function pushRelay({ subject = 'mailto:admin@example.org', minIntervalMs = 30_000, ttl = 24 * 3600, ringTtl = 60, maxSubscriptions = 100_000, maxSpaces = 256, fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return (qu) => {
    const { bus, storage } = qu;
    /** @type {Map<string, {endpoint: string, peer: string|null, spaces: Record<string, {author: string|null, shards: string[]|null}>}>} */
    const subs = new Map();
    const bySid = new Map();
    const pending = new Map(); // h -> Map(sid -> {count, kind, at})
    const lastSent = new Map();
    const timers = new Map();
    const seenRings = new Map();
    let vapid = null;
    const tokens = new Map(); // audience -> {jwt, exp}
    const writeLimit = rateLimit(50); // subscribe / unsubscribe / ring: requests/s, all clients together
    const pendingLimit = rateLimit(200);

    const hashOf = async (endpoint) => crypto.toHex(await crypto.sha256(enc.encode(endpoint))).slice(0, 32);
    const subKey = (h) => `push/subs/${h}`;
    function index(h, sub) {
      for (const sid of Object.keys(sub.spaces)) {
        if (!bySid.has(sid)) bySid.set(sid, new Set());
        bySid.get(sid).add(h);
      }
    }
    function unindex(h, sub) {
      for (const sid of Object.keys(sub?.spaces ?? {})) {
        bySid.get(sid)?.delete(h);
        if (!bySid.get(sid)?.size) bySid.delete(sid);
      }
    }
    async function drop(h) {
      unindex(h, subs.get(h));
      subs.delete(h);
      pending.delete(h);
      clearTimeout(timers.get(h));
      timers.delete(h);
      await storage.remove(subKey(h));
    }

    const ready = (async () => {
      let stored = await storage.get('push/vapid');
      if (!stored) {
        const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        stored = { jwk: await subtle.exportKey('jwk', pair.privateKey), pub: b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
        await storage.set('push/vapid', stored);
      }
      vapid = { key: await subtle.importKey('jwk', stored.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']), pub: stored.pub };
      for (const key of await storage.keys('push/subs/')) {
        const h = key.slice('push/subs/'.length);
        const sub = await storage.get(key);
        subs.set(h, sub);
        index(h, sub);
      }
      return vapid.pub;
    })();

    /** VAPID JWT (ES256) for one push service origin, reused for an hour. */
    async function vapidToken(endpoint) {
      const aud = new URL(endpoint).origin;
      const now = Math.floor(Date.now() / 1000);
      const cached = tokens.get(aud);
      if (cached && cached.exp - now > 3600) return cached.jwt;
      const exp = now + 12 * 3600;
      const part = (obj) => b64url(enc.encode(JSON.stringify(obj)));
      const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp, sub: subject })}`;
      const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, enc.encode(unsigned)));
      const jwt = `${unsigned}.${b64url(sig)}`;
      tokens.set(aud, { jwt, exp });
      return jwt;
    }

    async function send(h, { urgency = 'normal', time = ttl } = {}) {
      const sub = subs.get(h);
      if (!sub || qu.closed) return;
      lastSent.set(h, Date.now());
      try {
        const res = await fetchImpl(sub.endpoint, {
          method: 'POST',
          headers: { authorization: `vapid t=${await vapidToken(sub.endpoint)}, k=${vapid.pub}`, ttl: String(time), urgency, 'content-length': '0' },
        });
        await bus.notify('push.sent', { status: res.status, urgency });
        if (res.status === 404 || res.status === 410) await drop(h);
      } catch (error) {
        await bus.notify('push.failed', { reason: error.message });
      }
    }
    /** At most one push per device per `minIntervalMs`; the rest waits (trailing). */
    function schedule(h) {
      if (timers.has(h)) return;
      const wait = minIntervalMs - (Date.now() - (lastSent.get(h) ?? 0));
      if (wait <= 0) return void send(h);
      const timer = setTimeout(() => {
        timers.delete(h);
        send(h);
      }, wait);
      timer.unref?.();
      timers.set(h, timer);
    }
    qu.onClose?.(() => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    });
    const connected = (sub) => Boolean(sub.peer && qu.net?.links?.has(sub.peer));

    function mark(h, sid, kind) {
      if (!pending.has(h)) pending.set(h, new Map());
      const entry = pending.get(h).get(sid) ?? { count: 0, kind: 'message', at: 0 };
      entry.count++;
      entry.at = Date.now();
      if (kind === 'call') entry.kind = 'call';
      pending.get(h).set(sid, entry);
    }

    bus.on('qu.envelope.stored', ({ sid, header, bytes }) => {
      const list = bySid.get(sid);
      if (!list?.size) return;
      if (header.visibility === 'public' && readPublic(bytes)?.t === GC_TYPE) return; // a drop list wakes nobody
      for (const h of list) {
        const sub = subs.get(h);
        const want = sub?.spaces[sid];
        if (!want || want.author === header.author || connected(sub)) continue;
        if (want.shards && !want.shards.includes(header.shard)) continue;
        mark(h, sid, 'message');
        schedule(h);
      }
    });

    /** Checks a member signature with the space's epoch write key. */
    async function member(sid, epoch, message, sig) {
      const writePub = Number.isInteger(epoch) ? qu.keyring?.get(sid, epoch) : null;
      if (!writePub || typeof sig !== 'string') return false;
      try {
        return await crypto.verify(message, crypto.fromBase64(sig), writePub);
      } catch {
        return false;
      }
    }
    const validEndpoint = (endpoint) => {
      try {
        return typeof endpoint === 'string' && endpoint.length < 2048 && new URL(endpoint).protocol === 'https:';
      } catch {
        return false;
      }
    };

    route(qu, 'GET', '/push/key', async (req, res) => json(res, 200, { key: await ready }));

    route(qu, 'POST', '/push/subscribe', async (req, res) => {
      writeLimit();
      await ready;
      const body = await readJson(req);
      const { endpoint, peer = null, spaces } = body ?? {};
      if (!validEndpoint(endpoint) || !Array.isArray(spaces) || spaces.length > maxSpaces) throw httpError(400, 'expected {endpoint: https url, spaces: [...]}');
      const h = await hashOf(endpoint);
      if (!subs.has(h) && subs.size >= maxSubscriptions) throw httpError(503, 'too many subscriptions');
      const sub = subs.get(h) ?? { endpoint, peer: null, spaces: {} };
      const accepted = [];
      for (const s of spaces) {
        if (!SID.test(s?.sid ?? '') || !(await member(s.sid, s.epoch, pushMessage(s.sid, endpoint), s.sig))) continue;
        const shards = Array.isArray(s.shards) && s.shards.length <= 64 && s.shards.every((t) => typeof t === 'string' && t.length === 16 && HEX.test(t)) ? s.shards : null;
        const author = typeof s.author === 'string' && s.author.length === 64 && HEX.test(s.author) ? s.author : null;
        sub.spaces[s.sid] = { author, shards };
        accepted.push(s.sid);
      }
      if (Object.keys(sub.spaces).length > maxSpaces) throw httpError(400, 'too many spaces');
      sub.peer = typeof peer === 'string' && peer.length <= 128 ? peer : sub.peer;
      unindex(h, subs.get(h));
      subs.set(h, sub);
      index(h, sub);
      await storage.set(subKey(h), sub);
      json(res, 200, { accepted });
    });

    route(qu, 'POST', '/push/unsubscribe', async (req, res) => {
      writeLimit();
      await ready;
      const { endpoint, sids } = (await readJson(req)) ?? {};
      if (typeof endpoint !== 'string') throw httpError(400, 'expected {endpoint}');
      const h = await hashOf(endpoint);
      const sub = subs.get(h);
      if (sub && Array.isArray(sids)) {
        unindex(h, sub);
        for (const sid of sids) delete sub.spaces[sid];
        index(h, sub);
        if (Object.keys(sub.spaces).length) await storage.set(subKey(h), sub);
        else await drop(h);
      } else if (sub) await drop(h);
      json(res, 200, { ok: true });
    });

    route(qu, 'POST', '/push/pending', async (req, res) => {
      pendingLimit();
      await ready;
      const { endpoint } = (await readJson(req)) ?? {};
      if (typeof endpoint !== 'string') throw httpError(400, 'expected {endpoint}');
      const h = await hashOf(endpoint);
      const list = [...(pending.get(h) ?? new Map())].map(([sid, e]) => ({ sid, ...e }));
      pending.delete(h);
      json(res, 200, { spaces: list });
    });

    route(qu, 'POST', '/push/ring', async (req, res) => {
      writeLimit();
      await ready;
      const { sid, epoch, at, kind = 'call', sig, peer = null } = (await readJson(req)) ?? {};
      if (!SID.test(sid ?? '') || !Number.isSafeInteger(at) || Math.abs(Date.now() - at) > 120_000 || !['call', 'message'].includes(kind)) throw httpError(400, 'bad ring');
      if (!(await member(sid, epoch, ringMessage(sid, at, kind), sig))) throw httpError(403, 'not a member');
      const seen = `${sid}/${sig}`;
      if (seenRings.has(seen)) return json(res, 200, { woken: 0 });
      seenRings.set(seen, Date.now());
      for (const [k, t] of seenRings) if (Date.now() - t > 150_000) seenRings.delete(k);
      let woken = 0;
      for (const h of bySid.get(sid) ?? []) {
        const sub = subs.get(h);
        if (!sub || (peer && sub.peer === peer) || connected(sub)) continue;
        mark(h, sid, kind);
        woken++;
        if (kind === 'call') send(h, { urgency: 'high', time: ringTtl });
        else schedule(h);
      }
      json(res, 200, { woken });
    });

    const api = {
      ready,
      /** @returns {number} stored subscriptions */
      size: () => subs.size,
    };
    qu.pushRelay = api;
    return api;
  };
}
