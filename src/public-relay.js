/**
 * PUBLIC READS AND OFFLINE DELIVERY - the relay side (see public.js for the
 * reader and the format). Installed by mirror.js; Node and browser safe, but
 * only a relay ever serves HTTP.
 */
import * as crypto from './crypto.js';
import { peekEnvelope, readPublic, envelopeId } from './envelope.js';
import { GC_TYPE } from './gc.js';
import { route, json, httpError, readBody, unpackEnvelopes, rateLimit } from './net/http.js';
import { encodeBytes } from './public.js';

const pubPrefix = (sid, path) => `pub/${sid}/${encodeURIComponent(path)}/`;
const SID = /^[0-9a-f]{32}$/;
const MAX_LIMIT = 200;
const IN_MAX_BYTES = 4 << 20;
const IN_MAX_ENVELOPES = 512;

/**
 * Relay side: the path index and both routes. Called by mirror.js.
 * @param {object} qu
 * @param {{ingest: Function, keyring: object}} env - the envelope layer
 * @param {{allowed: (sid: string) => boolean}} policy
 */
export function publicRelay(qu, env, { allowed, inRate = 20, readRate = 200 }) {
  const { bus, storage } = qu;
  const inLimit = rateLimit(inRate); // POST /q/in: requests/s (each up to 512 envelopes)
  const readLimit = rateLimit(readRate);

  // index public records by path, atomically with the record
  bus.on('qu.envelope.stored', ({ sid, id, header, bytes, ws }) => {
    if (header.visibility !== 'public') return;
    const inner = readPublic(bytes);
    if (!inner || typeof inner.p !== 'string' || inner.t === GC_TYPE || typeof inner.h !== 'string') return;
    ws.set(`${pubPrefix(sid, inner.p)}${inner.h}/${id}`, 1);
  });

  route(qu, 'GET', '/q/', async (req, res, url) => {
    const rest = url.pathname.slice(3);
    const slash = rest.indexOf('/');
    const sid = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1));
    readLimit();
    if (!SID.test(sid) || !path) throw httpError(400, 'expected /q/<sid>/<path>');
    if (!allowed(sid) || !env.keyring.state(sid)) throw httpError(404, 'unknown space');
    const q = url.searchParams;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get('limit')) || 50));
    const key = q.get('key');
    const base = pubPrefix(sid, path);
    // newest first by default; `before`/`after` are HLC cursors
    const after = q.get('after');
    const before = q.get('before');
    const reverse = !after;
    const range = { gte: after ? `${base}${after}0` : base, lt: before ? `${base}${before}` : `${base}￿`, reverse };
    const records = [];
    let next = null;
    // keyed reads filter, so scan in pages until enough matched
    let cursor = range;
    for (let pages = 0; records.length < limit && pages < 20; pages++) {
      const page = await storage.range(base, { ...cursor, limit: limit * 2 });
      if (!page.length) break;
      for (const { key: k } of page) {
        const id = k.slice(k.lastIndexOf('/') + 1);
        const bytes = await storage.get(`rec/${sid}/${id}`);
        if (!bytes) {
          await storage.remove(k); // dropped or retired meanwhile
          continue;
        }
        if (key !== null && readPublic(bytes)?.k !== key) continue;
        records.push(crypto.toBase64(bytes));
        next = k.slice(base.length, k.lastIndexOf('/'));
        if (records.length >= limit) break;
      }
      const last = page[page.length - 1].key;
      cursor = reverse ? { ...cursor, lt: last } : { ...cursor, gte: `${last}\u0000` };
      if (page.length < limit * 2) {
        if (records.length < limit) next = null;
        break;
      }
    }
    const grants = (await storage.get(`mirror/grants/${sid}`)) ?? [];
    json(res, 200, { sid, path, grants: encodeBytes(grants), records, ...(next && records.length >= limit ? { next } : {}) });
  });

  route(qu, 'POST', '/q/in', async (req, res) => {
    inLimit();
    const list = unpackEnvelopes(await readBody(req, IN_MAX_BYTES));
    if (!list || list.length > IN_MAX_ENVELOPES) throw httpError(400, 'malformed');
    const results = [];
    for (const bytes of list) {
      let header;
      try {
        header = peekEnvelope(bytes);
      } catch {
        results.push({ status: 'rejected', reason: 'malformed' });
        continue;
      }
      if (!allowed(header.sid)) {
        results.push({ id: await envelopeId(bytes), status: 'rejected', reason: 'not served' });
        continue;
      }
      const outcome = await env.ingest(bytes.slice(), { from: undefined });
      results.push({ id: outcome.id, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
    }
    json(res, 200, { results });
  });
}

