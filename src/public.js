/**
 * PUBLIC READS AND OFFLINE DELIVERY over plain HTTP - for readers that are
 * no member (a blog, a public profile, a forum read by guests) and for a
 * service worker that has no link (Background Sync, sw.js).
 *
 * At the RELAY (public-relay.js, installed by mirror.js):
 *
 *   GET  /q/<sid>/<path>?key=&limit=&before=&after=   public records of one path
 *        -> {sid, grants, records: [base64 envelope], next?}
 *   POST /q/in   body: envelopes (http.js packEnvelopes)  -> {results: [{id, status, reason?}]}
 *
 * A public record (`visibility: 'public'`) is signed but not encrypted, so
 * the relay can index it by path (`pub/<sid>/<path>/<hlc>/<id>`, written in
 * the record's own write set). It still serves the SEALED envelope plus the
 * space's grants: the reader checks both signatures itself and needs to
 * trust nobody - a relay can withhold records, never forge or alter them.
 * Private records are never served here.
 *
 * At the READER (no identity, no peer needed):
 *
 *   const posts = await fetchPublic('https://relay.example', sid, 'blog')
 *   const about = await fetchPublic('https://relay.example', sid, 'pages', { key: 'about' })
 *   const link  = publicLink('https://relay.example', sid, 'blog')   // .../q/<sid>/blog
 *   await fetchPublic(link)                                         // the same
 *
 * Who may WRITE is the space's business: a blog is a group whose only
 * members are its authors; an open space (members.js `open`) lets everyone.
 */
import * as crypto from './crypto.js';
import { peekEnvelope, readPublic, verifyEnvelope, envelopeId } from './envelope.js';
import { emptyGrantState, verifyGrants } from './space.js';
import { httpOrigin } from './net/http.js';

/** Bytes inside JSON: {"$b": base64}. */
export const encodeBytes = (value) =>
  value instanceof Uint8Array ? { $b: crypto.toBase64(value) } : Array.isArray(value) ? value.map(encodeBytes) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBytes(v)])) : value;
export const decodeBytes = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof value.$b === 'string' && Object.keys(value).length === 1
    ? crypto.fromBase64(value.$b)
    : Array.isArray(value) ? value.map(decodeBytes) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeBytes(v)])) : value;


/** `https://relay/q/<sid>/<path>` - shareable, and what `fetchPublic(link)` reads. */
export const publicLink = (relay, sid, path) => `${httpOrigin(relay)}/q/${sid}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Reads public records of one path from a relay and verifies every one
 * (grants chain, both signatures, sid and path). Keyed entries: only the
 * newest version per key; tombstones are left out.
 * @param {string} relay - relay url, or a `publicLink()`
 * @param {string} [sid]
 * @param {string} [path]
 * @param {{key?: string, limit?: number, before?: string, after?: string, fetch?: typeof fetch}} [options]
 * @returns {Promise<Array<{id: string, path: string, key: string|null, value: any, hlc: string, author: string, ts: number, epoch: number}> & {next?: string}>}
 */
export async function fetchPublic(relay, sid, path, options = {}) {
  if (typeof sid === 'object' && sid !== null) [options, sid, path] = [sid, undefined, undefined];
  if (sid === undefined) {
    const u = new URL(relay);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'q' || parts.length < 3) throw new Error('fetchPublic: expected a link .../q/<sid>/<path>');
    sid = parts[1];
    path = parts.slice(2).map(decodeURIComponent).join('/');
  }
  const { key, limit, before, after, fetch: fetchImpl = globalThis.fetch } = options;
  const q = new URLSearchParams();
  if (key !== undefined) q.set('key', key);
  if (limit !== undefined) q.set('limit', String(limit));
  if (before) q.set('before', before);
  if (after) q.set('after', after);
  const res = await fetchImpl(`${publicLink(relay, sid, path)}${q.size ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`fetchPublic: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const body = await res.json();
  const { state } = await verifyGrants(sid, decodeBytes(body.grants), emptyGrantState());
  const out = [];
  const newest = new Map();
  for (const text of body.records ?? []) {
    const bytes = crypto.fromBase64(text);
    let header;
    try {
      header = peekEnvelope(bytes);
    } catch {
      continue;
    }
    const writePub = state.epochs.get(header.epoch);
    if (header.sid !== sid || header.visibility !== 'public' || !writePub || !(await verifyEnvelope(bytes, writePub))) continue;
    const inner = readPublic(bytes);
    if (!inner || inner.p !== path) continue;
    const record = { id: await envelopeId(bytes), path: inner.p, key: inner.k ?? null, value: inner.v, hlc: inner.h, author: header.author, ts: header.ts, epoch: header.epoch, ...(inner.d ? { deleted: true } : {}) };
    if (record.key === null) out.push(record);
    else if (!newest.has(record.key) || newest.get(record.key).hlc < record.hlc) newest.set(record.key, record);
  }
  const result = [...out, ...[...newest.values()].filter((r) => !r.deleted)].sort((a, b) => (a.hlc < b.hlc ? 1 : -1));
  if (body.next) result.next = body.next;
  return result;
}
