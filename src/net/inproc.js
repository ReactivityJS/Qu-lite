/**
 * IN-PROCESS TRANSPORT - two Qu instances in one process, used by tests. It
 * goes through the same `createLink` as every real transport (handshake,
 * framing, bus wiring), so tests exercise the production path; only the
 * byte channel is a microtask hop instead of a socket.
 */
import { createLink } from './link.js';

/**
 * @param {{bus: import('../bus.js').Bus, peerId: string}} a
 * @param {{bus: import('../bus.js').Bus, peerId: string}} b
 * @returns {{stats: {aToB: number, bToA: number, messages: number}, ready: Promise<void>, disconnect: () => Promise<void>}}
 *   `ready` resolves once both sides completed the handshake (`net.peer.up`).
 */
export function connectInProcess(a, b) {
  const stats = { aToB: 0, bToA: 0, messages: 0 };
  let open = true;
  const ends = {};
  const channel = (to, counter) => (bytes) => {
    if (!open) return;
    stats[counter] += bytes.length;
    stats.messages++;
    queueMicrotask(() => open && ends[to].receive(bytes));
  };
  let up = 0;
  let markReady;
  const ready = new Promise((resolve) => (markReady = resolve));
  const onUp = () => ++up === 2 && markReady();
  ends.a = createLink(a, { send: channel('b', 'aToB'), via: 'inproc', onUp });
  ends.b = createLink(b, { send: channel('a', 'bToA'), via: 'inproc', onUp });

  return {
    stats,
    ready,
    async disconnect() {
      if (!open) return;
      open = false;
      ends.a.closed();
      ends.b.closed();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** Registry-friendly plugin form: `qu.use(inprocTransport({ peers: [otherQu] }))`. */
export function inprocTransport({ peers = [] } = {}) {
  return (qu) => {
    const links = peers.map((other) => connectInProcess(qu, other));
    return { links, close: () => Promise.all(links.map((l) => l.disconnect())) };
  };
}
