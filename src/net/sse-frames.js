/**
 * Byte framing shared by the SSE client and server. Client -> server POST
 * bodies carry one or more link frames as `u32 length || frame`; server ->
 * client events carry one frame each as base64 text (SSE is a text stream;
 * the 33 % overhead is the price of the fallback).
 */
export function packFrames(frames) {
  const out = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length);
    out.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return out;
}

export function unpackFrames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 4 + length > bytes.length) throw new Error('sse: truncated frame');
    frames.push(bytes.slice(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  if (offset !== bytes.length) throw new Error('sse: trailing bytes');
  return frames;
}

export const SESSION = /^[0-9a-f]{32}$/;
