/**
 * LIMITS - inbound rate limits per connection, for a relay/mirror (or any
 * peer): two token buckets per peer, frames and bytes. A frame over the
 * limit is dropped (nothing is lost for good: an unacknowledged record stays
 * in the sender's outbox, an unfinished reconcile is retried), reported as
 * `net.limited`, and `strikes` drops within `windowMs` close the link.
 *
 *   qu.use(limits({ frames: {rate: 200, burst: 400}, bytes: {rate: 1 << 20, burst: 4 << 20} }))
 *
 * Hooks into every link through `qu.net.guard` (link.js).
 */
import { netOf } from './net/link.js';

/**
 * @param {{frames?: {rate: number, burst: number}, bytes?: {rate: number, burst: number}, strikes?: number, windowMs?: number, now?: () => number}} [options]
 *   rates per second.
 */
export function limits({ frames = { rate: 200, burst: 400 }, bytes = { rate: 1 << 20, burst: 4 << 20 }, strikes = 50, windowMs = 10_000, now = () => Date.now() } = {}) {
  return (qu) => {
    const net = netOf(qu);
    /** @type {Map<string, {frames: number, bytes: number, at: number, strikes: number[]}>} */
    const state = new Map();
    qu.bus.on('net.peer.down', ({ peer }) => state.delete(peer));

    net.guard = (peer, type, size) => {
      const t = now();
      let s = state.get(peer);
      if (!s) state.set(peer, (s = { frames: frames.burst, bytes: bytes.burst, at: t, strikes: [] }));
      const elapsed = (t - s.at) / 1000;
      s.at = t;
      s.frames = Math.min(frames.burst, s.frames + elapsed * frames.rate);
      s.bytes = Math.min(bytes.burst, s.bytes + elapsed * bytes.rate);
      if (s.frames >= 1 && s.bytes >= size) {
        s.frames -= 1;
        s.bytes -= size;
        return true;
      }
      s.strikes = s.strikes.filter((at) => t - at < windowMs);
      s.strikes.push(t);
      const close = s.strikes.length >= strikes;
      qu.bus.notify('net.limited', { peer, type, size, closed: close });
      return close ? 'close' : false;
    };
    return { state };
  };
}
