/**
 * FRAME CODEC - how a `net.out.<peer>.<type>` payload travels over a byte
 * stream (WebSocket, later WebRTC). Binary, no base64: every Uint8Array in
 * the payload is lifted out into a length-prefixed blob section and
 * replaced by `{"$b": index}` in the JSON part.
 *
 *   u8 typeLen | type (utf8) | u32 jsonLen | json | (u32 len | bytes)*
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

/** @param {Uint8Array} frame @returns {{type: string, payload: *}} */
export function decodeFrame(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  const typeLen = frame[offset++];
  const type = dec.decode(frame.subarray(offset, offset + typeLen));
  offset += typeLen;
  const jsonLen = view.getUint32(offset);
  offset += 4;
  const jsonText = dec.decode(frame.subarray(offset, offset + jsonLen));
  offset += jsonLen;
  const blobs = [];
  while (offset < frame.length) {
    const len = view.getUint32(offset);
    offset += 4;
    blobs.push(frame.slice(offset, offset + len));
    offset += len;
  }
  const payload = JSON.parse(jsonText, (_k, v) => (v && typeof v === 'object' && typeof v.$b === 'number' && Object.keys(v).length === 1 ? blobs[v.$b] : v));
  return { type, payload };
}
