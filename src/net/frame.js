/**
 * FRAME CODEC - how a `net.out.<peer>.<type>` payload travels over a byte
 * stream (WebSocket, later WebRTC). Binary, no base64: every Uint8Array in
 * the payload is lifted out into a length-prefixed blob section and
 * replaced by `{"$b": index}` in the JSON part.
 *
 *   u8 typeLen | type (utf8) | u32 jsonLen | json | (u32 len | bytes)*
 *
 * Decoding is STRICT - frames come from untrusted peers: every length must
 * fit, nothing may trail, a `{"$b": i}` must name an existing blob. Any
 * violation throws (link.js reports it as `net.error` and drops the frame).
 * `peekFrameType()` reads only the type, so a rate limit can be applied
 * before the JSON is parsed.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {string} type @param {*} payload @returns {Uint8Array} */
export function encodeFrame(type, payload) {
  const blobs = [];
  const json = enc.encode(
    JSON.stringify(payload ?? null, (_k, v) => {
      if (v instanceof Uint8Array) {
        blobs.push(v);
        return { $b: blobs.length - 1 };
      }
      return v;
    })
  );
  const typeBytes = enc.encode(type);
  if (typeBytes.length > 255) throw new Error('frame: type too long');
  const size = 1 + typeBytes.length + 4 + json.length + blobs.reduce((n, b) => n + 4 + b.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = typeBytes.length;
  out.set(typeBytes, offset);
  offset += typeBytes.length;
  view.setUint32(offset, json.length);
  offset += 4;
  out.set(json, offset);
  offset += json.length;
  for (const blob of blobs) {
    view.setUint32(offset, blob.length);
    offset += 4;
    out.set(blob, offset);
    offset += blob.length;
  }
  return out;
}

const fatal = new TextDecoder('utf-8', { fatal: true });
const bad = (why) => {
  throw new Error(`frame: ${why}`);
};

/** The frame's type without decoding the rest. @param {Uint8Array} frame @returns {string} */
export function peekFrameType(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 5) bad('too short');
  const typeLen = frame[0];
  if (1 + typeLen + 4 > frame.length) bad('truncated type');
  return fatal.decode(frame.subarray(1, 1 + typeLen));
}

/** @param {Uint8Array} frame @returns {{type: string, payload: *}} */
export function decodeFrame(frame) {
  const type = peekFrameType(frame);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 1 + frame[0];
  const jsonLen = view.getUint32(offset);
  offset += 4;
  if (offset + jsonLen > frame.length) bad('truncated json');
  const jsonText = fatal.decode(frame.subarray(offset, offset + jsonLen));
  offset += jsonLen;
  const blobs = [];
  while (offset < frame.length) {
    if (offset + 4 > frame.length) bad('truncated blob length');
    const len = view.getUint32(offset);
    offset += 4;
    if (offset + len > frame.length) bad('truncated blob');
    blobs.push(frame.slice(offset, offset + len));
    offset += len;
  }
  const payload = JSON.parse(jsonText, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.$b === 'number' && Object.keys(v).length === 1) {
      if (!Number.isInteger(v.$b) || v.$b < 0 || v.$b >= blobs.length) bad('unknown blob');
      return blobs[v.$b];
    }
    return v;
  });
  return { type, payload };
}

/**
 * How many records a frame carries, for rate limits: a `recs` frame counts
 * one per blob (each record is one), every other frame 1. Reads only the
 * length prefixes - no JSON parsing. Malformed frames count 1 (decoding
 * rejects them later).
 * @param {Uint8Array} frame @returns {number}
 */
export function frameUnits(frame) {
  try {
    if (peekFrameType(frame) !== 'recs') return 1;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let offset = 1 + frame[0];
    offset += 4 + view.getUint32(offset);
    let units = 0;
    while (offset + 4 <= frame.length) {
      offset += 4 + view.getUint32(offset);
      units++;
    }
    return Math.max(1, units);
  } catch {
    return 1;
  }
}
