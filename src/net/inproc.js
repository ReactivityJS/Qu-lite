/**
 * IN-PROCESS BRIDGE - the reference network bridge, used by tests. A bridge
 * is all a transport is in Qu Lite: it carries `net.out.<peer>.<type>` from
 * one bus to the other side, where it arrives as `net.in.<peer>.<type>`, and
 * announces `net.peer.up`/`net.peer.down`. Nothing above it knows whether
 * the wire is in-process, a WebSocket or a WebRTC channel.
 *
 * `stats` counts payload bytes per direction - the hook the later volume-
 * budget tests measure against.
 */

const sizeOf = (payload) => (payload?.bytes instanceof Uint8Array ? payload.bytes.length : new TextEncoder().encode(JSON.stringify(payload ?? null)).length);

/**
 * Connects two Qu instances. Delivery is asynchronous (one microtask hop),
 * like a real network.
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} a
 * @param {{bus: import('@qu/events').EventBus, peerId: string}} b
 * @returns {{stats: {aToB: number, bToA: number, messages: number}, disconnect: () => Promise<void>}}
 */
export function connectInProcess(a, b) {
  const stats = { aToB: 0, bToA: 0, messages: 0 };
  let open = true;

  const wire = (from, to, counter) =>
    from.bus.on(`net.out.${to.peerId}.*`, (payload, ctx) => {
      if (!open) return;
      const type = ctx.topic.split('.')[3];
      stats[counter] += sizeOf(payload);
      stats.messages++;
      queueMicrotask(() => {
        if (open) to.bus.emit(`net.in.${from.peerId}.${type}`, payload);
      });
    });

  const offs = [wire(a, b, 'aToB'), wire(b, a, 'bToA')];
  a.bus.notify('net.peer.up', { peer: b.peerId, via: 'inproc' });
  b.bus.notify('net.peer.up', { peer: a.peerId, via: 'inproc' });

  return {
    stats,
    async disconnect() {
      if (!open) return;
      open = false;
      for (const off of offs) off();
      await a.bus.notify('net.peer.down', { peer: b.peerId });
      await b.bus.notify('net.peer.down', { peer: a.peerId });
    },
  };
}
