/**
 * WEBRTC TRANSPORT - direct browser-to-browser links (DataChannel) between
 * members of a space, as just another byte channel for `createLink`
 * (link.js). Everything above it - sync, records, signals - is unchanged.
 *
 * Who connects to whom (per tracked space, from `status` presence):
 *   'relay-only'  never - nobody learns your IP address (privacy default
 *                 for people who need it)
 *   'mesh'        every online member
 *   'auto'        every online member while the group online is small
 *                 (<= maxMesh incl. me), else `fanout` of them, picked by a
 *                 per-peer rendezvous hash so links spread across the group;
 *                 the relay always stays connected (durability, offline members)
 * The member with the smaller alias makes the offer, so two peers never
 * offer at the same time.
 *
 * Signaling travels as space SIGNALS (signals.js) `rtc {to, box}`: the box is
 * an anonymous sealed box to the target's alias X25519 key (from _members),
 * so the relay - and every other member - sees neither SDP nor ICE
 * candidates (i.e. nobody else learns IP addresses), only that a signal was
 * sent. Within the pair, IPs are exchanged by design: that is what a direct
 * link is.
 *
 *   qu.use(rtc({ mode: 'auto', iceServers: [{ urls: 'stun:stun.example.org' }] }))
 *   await qu.rtc.track(space)
 *
 * `RTCPeerConnectionImpl` is injectable (tests run a fake in Node).
 */
import * as crypto from '../crypto.js';
import { createLink } from './link.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * @param {{mode?: 'auto'|'mesh'|'relay-only', maxMesh?: number, fanout?: number, iceServers?: object[], connectTimeoutMs?: number, RTCPeerConnectionImpl?: typeof RTCPeerConnection}} [options]
 */
export function rtc({ mode = 'auto', maxMesh = 6, fanout = 3, iceServers = [], connectTimeoutMs = 15_000, RTCPeerConnectionImpl = globalThis.RTCPeerConnection } = {}) {
  return (qu) => {
    if (typeof qu.status !== 'function' || typeof qu.signal !== 'function') throw new Error('rtc(): install records(), members() and status() first');
    const { bus, identity } = qu;
    /** @type {Map<string, Promise<object>>} */
    const tracked = new Map();
    const state = { mode };

    async function track(space) {
      if (!tracked.has(space.id)) tracked.set(space.id, createTracker(space));
      return tracked.get(space.id);
    }

    async function createTracker(space) {
      const sid = space.id;
      const members = await qu.members(space);
      const status = await qu.status(space);
      const me = members.me;
      const myX = await space.aliasX(identity);
      /** @type {Map<string, {id: string, pc: RTCPeerConnection, link: object|null, pendingIce: object[], timer: *}>} alias -> session */
      const sessions = new Map();

      const signal = async (to, message) => {
        const target = members.list().find((m) => m.alias === to);
        if (!target?.xpub) return;
        const box = await crypto.sealTo(crypto.fromHex(target.xpub), enc.encode(JSON.stringify(message)));
        await qu.signal(space, 'rtc', { to, box: crypto.toBase64(box) });
      };

      /** Rendezvous order: every peer ranks the others differently, so a fanout spreads load. */
      const rank = (alias) => {
        let h = 2166136261;
        for (const ch of me + alias) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
        return h;
      };

      function wanted() {
        if (state.mode === 'relay-only' || !RTCPeerConnectionImpl) return new Set();
        const online = members
          .list()
          .filter((m) => !m.me && ['owner', 'admin', 'member'].includes(m.role) && status.isOnline(m.alias))
          .map((m) => m.alias);
        if (state.mode === 'mesh' || online.length + 1 <= maxMesh) return new Set(online);
        return new Set(online.sort((a, b) => rank(a) - rank(b)).slice(0, fanout));
      }

      function close(alias, reason) {
        const session = sessions.get(alias);
        if (!session) return;
        sessions.delete(alias);
        clearTimeout(session.timer);
        session.link?.closed();
        try {
          session.pc.close();
        } catch {}
        bus.notify('net.rtc.closed', { space: sid, alias, reason });
      }

      function newSession(alias, id) {
        close(alias, 'replaced');
        const pc = new RTCPeerConnectionImpl({ iceServers });
        const session = { id, pc, link: null, pendingIce: [] };
        session.timer = setTimeout(() => !session.link && close(alias, 'timeout'), connectTimeoutMs);
        session.timer.unref?.();
        pc.onicecandidate = (event) => {
          if (event.candidate) signal(alias, { kind: 'ice', session: id, candidate: event.candidate.toJSON?.() ?? event.candidate }).catch(() => {});
        };
        pc.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(pc.connectionState)) close(alias, pc.connectionState);
        };
        sessions.set(alias, session);
        return session;
      }

      function wire(alias, session, channel) {
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => {
          clearTimeout(session.timer);
          session.link = createLink(qu, { send: (bytes) => channel.readyState === 'open' && channel.send(bytes), close: () => close(alias, 'link'), via: 'webrtc' });
          bus.notify('net.rtc.open', { space: sid, alias });
        };
        channel.onmessage = (event) => session.link?.receive(new Uint8Array(event.data));
        channel.onclose = () => close(alias, 'channel closed');
      }

      async function flushIce(session) {
        for (const candidate of session.pendingIce.splice(0)) await session.pc.addIceCandidate(candidate).catch(() => {});
      }

      async function offer(alias) {
        const session = newSession(alias, crypto.toHex(crypto.randomBytes(8)));
        wire(alias, session, session.pc.createDataChannel('qu', { ordered: true }));
        await session.pc.setLocalDescription(await session.pc.createOffer());
        await signal(alias, { kind: 'offer', session: session.id, sdp: session.pc.localDescription.sdp });
      }

      bus.on(`qu.signal.${sid}.rtc`, async ({ author, value }) => {
        if (value?.to !== me || author === me || state.mode === 'relay-only' || !RTCPeerConnectionImpl) return;
        const plain = await crypto.openSealed(myX.privateKey, myX.publicKey, crypto.fromBase64(value.box ?? ''));
        if (!plain) return;
        let message;
        try {
          message = JSON.parse(dec.decode(plain));
        } catch {
          return;
        }
        try {
          if (message.kind === 'offer') {
            // accept any active member who chose us (their presence view may be ahead of ours)
            if (!['owner', 'admin', 'member'].includes(members.role(author))) return;
            const session = newSession(author, message.session);
            session.pc.ondatachannel = (event) => wire(author, session, event.channel);
            await session.pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
            await session.pc.setLocalDescription(await session.pc.createAnswer());
            await flushIce(session);
            await signal(author, { kind: 'answer', session: message.session, sdp: session.pc.localDescription.sdp });
          } else {
            const session = sessions.get(author);
            if (!session || session.id !== message.session) return;
            if (message.kind === 'answer') {
              await session.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
              await flushIce(session);
            } else if (message.kind === 'ice') {
              if (session.pc.remoteDescription) await session.pc.addIceCandidate(message.candidate).catch(() => {});
              else session.pendingIce.push(message.candidate);
            }
          }
        } catch (error) {
          close(author, error.message);
        }
      });

      /** Opens what should be open, closes what should not (called on presence/member changes). */
      async function reconcile() {
        const want = wanted();
        for (const alias of [...sessions.keys()]) if (!want.has(alias)) close(alias, 'not wanted');
        for (const alias of want) if (!sessions.has(alias) && me < alias) await offer(alias).catch((error) => close(alias, error.message));
      }
      const onChange = ({ space: changed }) => changed === sid && reconcile().catch(() => {});
      bus.on('qu.status.presence', onChange);
      bus.on('qu.members.changed', onChange);
      await reconcile();

      return {
        reconcile,
        /** @returns {Array<{alias: string, connected: boolean}>} */
        links: () => [...sessions].map(([alias, s]) => ({ alias, connected: Boolean(s.link) })),
        closeAll: (reason = 'closed') => [...sessions.keys()].forEach((alias) => close(alias, reason)),
      };
    }

    const api = {
      track,
      get mode() {
        return state.mode;
      },
      /** Switch at runtime; 'relay-only' closes every direct link. */
      async setMode(next) {
        state.mode = next;
        for (const t of tracked.values()) {
          const tracker = await t;
          if (next === 'relay-only') tracker.closeAll('relay-only');
          else await tracker.reconcile();
        }
      },
    };
    qu.rtc = api;
    return api;
  };
}
