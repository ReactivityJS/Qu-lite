/**
 * ENVELOPE (v2) - what a record is, on the wire, at a mirror and in every
 * local store. It is ALWAYS kept in this sealed form; both signatures sit
 * over the ciphertext, so any peer - member or not, relay or mirror, now or
 * later - can verify a stored record without being able to read it.
 *
 *   offset  size  field
 *   0       1     version (2)
 *   1       1     flags    bit 0: public (inner in clear, still signed)
 *   2       16    sid      opaque space id (space.js)
 *   18      8     shard    opaque HMAC tag of the path's first segment
 *   26      2     epoch    which epoch keys sealed it (u16 BE)
 *   28      4     ts       coarse time, MINUTES since epoch (u32 BE)
 *   32      32    author   the author's PUBLIC key - a per-space alias by
 *                          default, never the identity (space.authorFor)
 *   64      64    asig     Ed25519 by the author over header || ct
 *   128     64    osig     Ed25519 by the epoch's write key over header || ct || asig
 *   192     ...   ct       12-byte IV || AES-256-GCM(inner), AAD = header
 *                          (public records: the inner bytes themselves)
 *
 * asig proves WHO (as a pseudonym) wrote it, osig proves the writer holds
 * the space's current epoch key (membership) - a mirror that only knows the
 * write public keys can reject forgeries and spam without reading anything.
 *
 * INNER: JSON `{p: path, k: key|null, h: hlc, v: value}` plus optional
 * `t` (control type, e.g. 'gc' - see gc.js) and `d: 1` (tombstone: the
 * keyed entry was deleted) - path, key, precise time and value never leave
 * the ciphertext of a private record.
 *
 * The record id is `sha256(whole envelope)`: content-addressed.
 */
import * as crypto from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VERSION = 2;
const FLAG_PUBLIC = 1;
const HEADER_LEN = 64;
const ASIG = HEADER_LEN;
const OSIG = ASIG + 64;
const CT_OFFSET = OSIG + 64;

/** @param {Uint8Array} bytes @returns {Promise<string>} */
export async function envelopeId(bytes) {
  return crypto.toHex(await crypto.sha256(bytes));
}

/**
 * Parses only the public header - all a mirror/relay ever needs.
 * @param {Uint8Array} bytes
 * @returns {{version: number, visibility: 'public'|'private', sid: string, shard: string, epoch: number, ts: number, author: string}}
 */
export function peekEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < CT_OFFSET) throw new Error('envelope: too short');
  if (bytes[0] !== VERSION) throw new Error(`envelope: unsupported version ${bytes[0]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[0],
    visibility: bytes[1] & FLAG_PUBLIC ? 'public' : 'private',
    sid: crypto.toHex(bytes.subarray(2, 18)),
    shard: crypto.toHex(bytes.subarray(18, 26)),
    epoch: view.getUint16(26),
    ts: view.getUint32(28) * 60_000,
    author: crypto.toHex(bytes.subarray(32, 64)),
  };
}

/**
 * @param {import('./space.js').Space} space
 * @param {{path: string, key?: string|null, hlc: string, value: *, visibility?: 'private'|'public'}} record
 * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} author - see `space.authorFor(identity)`.
 * @returns {Promise<{bytes: Uint8Array, id: string}>}
 */
export async function sealEnvelope(space, { path, key = null, hlc, value, visibility = 'private', type, deleted = false }, author) {
  const epoch = space.epoch;
  const keys = space.epochKeys(epoch);
  if (!keys.writePriv) throw new Error(`envelope: no write key for space ${space.id}`);
  const isPublic = visibility === 'public';
  if (!isPublic && !keys.aesKey) throw new Error(`envelope: no encryption key for space ${space.id}`);

  const header = new Uint8Array(HEADER_LEN);
  const view = new DataView(header.buffer);
  header[0] = VERSION;
  header[1] = isPublic ? FLAG_PUBLIC : 0;
  header.set(space.sid, 2);
  header.set(await space.shardOf(path), 18);
  view.setUint16(26, epoch);
  view.setUint32(28, Math.floor(Number(hlc.slice(0, 13)) / 60_000));
  header.set(author.publicKey, 32);

  const fields = { p: path, k: key, h: hlc, v: value };
  if (type) fields.t = type;
  if (deleted) fields.d = 1;
  const inner = enc.encode(JSON.stringify(fields));
  let ct = inner;
  if (!isPublic) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, keys.aesKey, inner));
    ct = concat(iv, sealed);
  }

  const asig = await crypto.sign(concat(header, ct), author.privateKey);
  const osig = await crypto.sign(concat(header, ct, asig), keys.writePriv);
  const bytes = concat(header, asig, osig, ct);
  return { bytes, id: await envelopeId(bytes) };
}

/**
 * Verifies BOTH signatures on the sealed bytes - author (key in the header)
 * and membership (the epoch's write public key). Needs no secret: this is
 * what every peer and mirror runs before storing anything.
 * @param {Uint8Array} bytes
 * @param {Uint8Array} writePub
 * @returns {Promise<boolean>}
 */
export async function verifyEnvelope(bytes, writePub) {
  if (bytes.length < CT_OFFSET) return false;
  const header = bytes.subarray(0, HEADER_LEN);
  const asig = bytes.subarray(ASIG, OSIG);
  const osig = bytes.subarray(OSIG, CT_OFFSET);
  const ct = bytes.subarray(CT_OFFSET);
  const authorOk = await crypto.verify(concat(header, ct), asig, header.subarray(32, 64)).catch(() => false);
  if (!authorOk) return false;
  return crypto.verify(concat(header, ct, asig), osig, writePub).catch(() => false);
}

/**
 * Opens (reads) an envelope for a member: decrypts a private record with
 * the epoch key (header bound as AAD) or parses a public one. Signatures are
 * checked with `verify: true` (default) - pass false when the bytes come
 * from local storage that only ever holds verified envelopes.
 * @param {import('./space.js').Space} space
 * @param {Uint8Array} bytes
 * @param {{verify?: boolean}} [options]
 * @returns {Promise<{id: string, path: string, key: string|null, hlc: string, author: string, value: *, epoch: number, ts: number, visibility: string}>}
 */
export async function openEnvelope(space, bytes, { verify = true } = {}) {
  const outer = peekEnvelope(bytes);
  if (outer.sid !== space.id) throw new Error('envelope: belongs to another space');
  if (!space.hasEpoch(outer.epoch)) throw new Error(`envelope: unknown epoch ${outer.epoch}`);
  const keys = space.epochKeys(outer.epoch);
  if (verify && !(await verifyEnvelope(bytes, keys.writePub))) throw new Error('envelope: signature invalid');

  const header = bytes.subarray(0, HEADER_LEN);
  const ct = bytes.subarray(CT_OFFSET);
  let inner = ct;
  if (outer.visibility === 'private') {
    if (!keys.aesKey) throw new Error('envelope: no key to read this record');
    try {
      inner = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ct.subarray(0, 12), additionalData: header }, keys.aesKey, ct.subarray(12)));
    } catch {
      throw new Error('envelope: decryption failed');
    }
  }
  const { p, k, h, v, t, d } = JSON.parse(dec.decode(inner));
  if (crypto.toHex(await space.shardOf(p)) !== outer.shard) throw new Error('envelope: shard tag does not match path');

  const record = { id: await envelopeId(bytes), path: p, key: k, hlc: h, author: outer.author, value: v, epoch: outer.epoch, ts: outer.ts, visibility: outer.visibility };
  if (t) record.type = t;
  if (d) record.deleted = true;
  return record;
}

/**
 * The inner fields of a PUBLIC envelope, readable without any key - what
 * the blind layer (envelopes.js) needs to apply a drop list. Does not verify.
 * @param {Uint8Array} bytes
 * @returns {{p: string, k: string|null, h: string, v: *, t?: string}|null} null for private or malformed envelopes
 */
export function readPublic(bytes) {
  try {
    if (peekEnvelope(bytes).visibility !== 'public') return null;
    return JSON.parse(dec.decode(bytes.subarray(CT_OFFSET)));
  } catch {
    return null;
  }
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
