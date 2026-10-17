/**
 * GC - the format and the rules of a DROP LIST, the one way records leave a
 * space for everyone (deletion, compaction of superseded versions).
 *
 * A drop list is an ordinary PUBLIC envelope (signed, not encrypted) at
 * path `<first segment>/_gc`, so it lands in the same shard as its targets
 * (partial sync carries it along). Its inner `{t: 'gc', v: <base64>}` lists
 * entries of 68 bytes:
 *
 *   id (32) || ts in minutes (4, u32 BE) || author (32)
 *
 * All three are already public in the target's header - a drop list only
 * adds THAT something was dropped, and by whom (an alias).
 *
 * Every peer - mirror included - checks and applies it blind (envelopes.js):
 * an entry counts if its signer may drop the target (`mayDrop`). The target
 * envelope is removed, its sync-index entry stays as a "gone" item (both
 * sides then hold the id: reconcile transfers nothing) and a gone marker
 * remembers the drop list, which is what a peer sends instead of the record.
 *
 * Drop lists and their markers expire after `GC_HORIZON_MS` - a protocol
 * constant, the same everywhere, cut at day boundaries so every peer drops
 * the same set. A device offline for longer would bring dropped entries
 * back - sync.js recognises such a STALE device and retires its old records
 * locally instead of pushing them.
 */
import * as crypto from './crypto.js';
import { inboxSidOf } from './space.js';

export const GC_SEGMENT = '_gc';
export const GC_TYPE = 'gc';
export const GC_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
/** Entries per drop list (8.7 KB of base64). */
export const GC_MAX_ENTRIES = 128;
const ENTRY = 68;
const DAY = 24 * 60 * 60 * 1000;

/** Drop lists older than this (ms) expire - day-aligned, so peers agree. */
export const gcCutoff = (now) => Math.floor((now - GC_HORIZON_MS) / DAY) * DAY;

/** The drop-list path for a record path: same first segment, same shard. */
export const gcPath = (path) => `${path.split('/')[0]}/${GC_SEGMENT}`;
export const isGcPath = (path) => typeof path === 'string' && path.split('/')[1] === GC_SEGMENT && path.split('/').length === 2;

/**
 * @param {Array<{id: string, ts: number, author: string}>} entries - ts in ms
 * @returns {string} base64
 */
export function encodeEntries(entries) {
  const out = new Uint8Array(entries.length * ENTRY);
  const view = new DataView(out.buffer);
  entries.forEach(({ id, ts, author }, i) => {
    out.set(crypto.fromHex(id), i * ENTRY);
    view.setUint32(i * ENTRY + 32, Math.floor(ts / 60_000));
    out.set(crypto.fromHex(author), i * ENTRY + 36);
  });
  return crypto.toBase64(out);
}

/** @returns {Array<{id: string, ts: number, author: string}>|null} null if malformed */
export function decodeEntries(text) {
  let bytes;
  try {
    bytes = crypto.fromBase64(text);
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length % ENTRY || bytes.length / ENTRY > GC_MAX_ENTRIES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = 0; at < bytes.length; at += ENTRY) {
    out.push({
      id: crypto.toHex(bytes.subarray(at, at + 32)),
      ts: view.getUint32(at + 32) * 60_000,
      author: crypto.toHex(bytes.subarray(at + 36, at + ENTRY)),
    });
  }
  return out;
}

/**
 * May `by` drop a record written by `author` in space `sid`? Decidable
 * without reading anything: its own record, the space's owner or an admin
 * (verified grant state), or the owner of an inbox.
 * @param {import('./space.js').GrantState|undefined} state
 * @param {string} sid
 * @param {string} by - hex alias
 * @param {string} author - hex alias
 */
export async function mayDrop(state, sid, by, author) {
  if (by === author) return true;
  const hex = (key) => (key ? crypto.toHex(key) : null);
  if (state && (hex(state.owner) === by || state.admins.list.some((a) => hex(a) === by))) return true;
  return crypto.toHex(await inboxSidOf(crypto.fromHex(by))) === sid;
}
