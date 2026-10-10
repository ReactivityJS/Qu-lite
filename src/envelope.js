/**
 * ENVELOPE - what a record looks like on the wire and at a mirror. Only the
 * OUTER header is readable without the space's epoch key:
 *
 *   offset  size  field
 *   0       1     version (1)
 *   1       16    sid      opaque space id (space.js)
 *   17      8     shard    opaque HMAC tag of the path's first segment
 *   25      2     epoch    which epoch key sealed it (u16 BE)
 *   27      4     ts       coarse time, MINUTES since epoch (u32 BE)
 *   31      64    osig     Ed25519 by the epoch's write key over header||ct
 *   95      ...   ct       12-byte IV || AES-256-GCM(inner), AAD = header
 *
 * INNER (encrypted): `{b: body, s: sig}` where `body` is the JSON string
 * `{p: path, k: key|null, h: hlc, a: authorPubB64, v: value}` and `s` is the
 * author's Ed25519 signature over `sidHex + "\n" + body`. Path, key, precise
 * time, author and recipients are therefore never visible outside the space;
 * there is no per-recipient `to` list - one ciphertext per record.
 *
 * The record id is `sha256(whole envelope)`: content-addressed, so a
 * receiver can dedupe and later verify stored records without a key.
 */
import { QuCrypto } from '@qu/core';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const VERSION = 1;
const HEADER_LEN = 31;
const SIG_LEN = 64;
const CT_OFFSET = HEADER_LEN + SIG_LEN;

/** @param {Uint8Array} bytes @returns {Promise<string>} */
export async function envelopeId(bytes) {
  return QuCrypto.toHex(await QuCrypto.sha256(bytes));
}

/**
 * Parses only the public header - all a mirror/relay ever needs.
 * @param {Uint8Array} bytes
 * @returns {{version: number, sid: string, shard: string, epoch: number, ts: number}}
 */
export function peekEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < CT_OFFSET + 12 + 16) throw new Error('envelope: too short');
  if (bytes[0] !== VERSION) throw new Error(`envelope: unsupported version ${bytes[0]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[0],
    sid: QuCrypto.toHex(bytes.subarray(1, 17)),
    shard: QuCrypto.toHex(bytes.subarray(17, 25)),
    epoch: view.getUint16(25),
    ts: view.getUint32(27) * 60_000,
  };
}

/**
 * @param {import('./space.js').Space} space
 * @param {{path: string, key?: string|null, hlc: string, value: *}} record
 * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} author
 * @returns {Promise<{bytes: Uint8Array, id: string}>}
 */
export async function sealEnvelope(space, { path, key = null, hlc, value }, author) {
  const epoch = space.epoch;
  const keys = space.epochKeys(epoch);

  const body = JSON.stringify({ p: path, k: key, h: hlc, a: QuCrypto.toBase64(author.publicKey), v: value });
  const sig = await QuCrypto.sign(enc.encode(`${space.id}\n${body}`), author.privateKey);
  const inner = enc.encode(JSON.stringify({ b: body, s: QuCrypto.toBase64(sig) }));

  const header = new Uint8Array(HEADER_LEN);
  const view = new DataView(header.buffer);
  header[0] = VERSION;
  header.set(space.sid, 1);
  header.set(await space.shardOf(path), 17);
  view.setUint16(25, epoch);
  view.setUint32(27, Math.floor(Number(hlc.slice(0, 13)) / 60_000));

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, keys.aesKey, inner));
  const ct = new Uint8Array(iv.length + sealed.length);
  ct.set(iv, 0);
  ct.set(sealed, iv.length);

  const osig = await QuCrypto.sign(concat(header, ct), keys.writePriv);
  const bytes = concat(header, osig, ct);
  return { bytes, id: await envelopeId(bytes) };
}

/**
 * Checks ONLY the outer signature - what a mirror does to reject junk
 * without being able to read anything. Needs the epoch's write PUBLIC key.
 * @param {Uint8Array} bytes
 * @param {Uint8Array} writePub
 * @returns {Promise<boolean>}
 */
export async function verifyOuter(bytes, writePub) {
  const header = bytes.subarray(0, HEADER_LEN);
  const osig = bytes.subarray(HEADER_LEN, CT_OFFSET);
  const ct = bytes.subarray(CT_OFFSET);
  return QuCrypto.verify(concat(header, ct), osig, writePub);
}

/**
 * Full open for a member: outer signature, decryption (header bound as
 * AAD), author signature. Throws on any failure.
 * @param {import('./space.js').Space} space
 * @param {Uint8Array} bytes
 * @returns {Promise<{id: string, path: string, key: string|null, hlc: string, author: string, value: *, epoch: number, ts: number}>}
 */
export async function openEnvelope(space, bytes) {
  const outer = peekEnvelope(bytes);
  if (outer.sid !== space.id) throw new Error('envelope: belongs to another space');
  if (!space.hasEpoch(outer.epoch)) throw new Error(`envelope: unknown epoch ${outer.epoch}`);
  const keys = space.epochKeys(outer.epoch);

  if (!(await verifyOuter(bytes, keys.writePub))) throw new Error('envelope: outer signature invalid');

  const header = bytes.subarray(0, HEADER_LEN);
  const ct = bytes.subarray(CT_OFFSET);
  let inner;
  try {
    inner = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ct.subarray(0, 12), additionalData: header }, keys.aesKey, ct.subarray(12)));
  } catch {
    throw new Error('envelope: decryption failed');
  }

  const { b: body, s } = JSON.parse(dec.decode(inner));
  const { p, k, h, a, v } = JSON.parse(body);
  const authorPub = QuCrypto.fromBase64(a);
  if (!(await QuCrypto.verify(enc.encode(`${space.id}\n${body}`), QuCrypto.fromBase64(s), authorPub))) {
    throw new Error('envelope: author signature invalid');
  }
  if (await space.shardOf(p).then((tag) => QuCrypto.toHex(tag) !== outer.shard)) {
    throw new Error('envelope: shard tag does not match path');
  }

  return { id: await envelopeId(bytes), path: p, key: k, hlc: h, author: QuCrypto.toHex(authorPub), value: v, epoch: outer.epoch, ts: outer.ts };
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
