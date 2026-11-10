/**
 * STATUS - "online", "typing …", "sent ✓", "delivered ✓✓", "read" - without
 * any per-message overhead:
 *
 *   presence   ephemeral signal (signals.js) `presence {state}` every
 *              `interval` while connected, at once on connect / when
 *              tracking starts, `offline` on a clean leave. Someone is online
 *              while their last heartbeat is younger than 2.5 x interval. A
 *              newcomer's heartbeat is answered once (throttled), and every
 *              member re-announces when the member list changes, so a
 *              newcomer sees who is there without waiting a full interval.
 *   typing     ephemeral signal `typing {path}`, sent at most every
 *              `typingThrottleMs`, expires after `typingTtlMs`.
 *   sent       the envelope left the outbox: a mirror (or peer) stored it
 *              (`qu.syncState`).
 *   delivered  ONE cursor record per member and conversation, not per
 *   / read     message: `_receipts/<path>`, key = own alias,
 *              value {delivered: hlc, read: hlc}, encrypted, last-write-wins.
 *              `delivered` follows incoming records automatically (throttled),
 *              `read` is set by the app (`markRead`).
 *
 * HIDDEN APP: while the page is not visible (document.visibilityState, or
 * `qu.status.setHidden(true)` in other runtimes) the heartbeat slows to
 * `hiddenInterval` (5 min) - a backgrounded app costs ~1/15 of the data and
 * radio wake-ups. Every heartbeat carries its interval (`every`), receivers
 * keep someone online for 2.5 x that, so the slower beat does not flip them
 * offline. Becoming hidden announces at once (with the new interval),
 * becoming visible too. `hiddenInterval: 0` announces "offline" while
 * hidden instead. (Peers older than this treat a hidden peer as offline
 * after 2.5 x their own interval.)
 *
 * Privacy switches: `presence: false` (never announce yourself; still see
 * others), `readReceipts: false` (only "delivered" is sent).
 *
 *   const st = await qu.status(space)
 *   st.online()  st.isOnline(alias)  st.typing('chat')  st.sendTyping('chat')
 *   await st.markRead('chat')  await st.of(record) -> {sent, delivered, read, members}
 *
 * Needs records(), members(), sync() (for "sent"); installs signals().
 */
import { signals as signalsPlugin } from './signals.js';

const RECEIPTS = '_receipts/';

/**
 * @param {{interval?: number, presence?: boolean, readReceipts?: boolean, typingThrottleMs?: number, typingTtlMs?: number, receiptThrottleMs?: number}} [options]
 */
/** A remote's announced heartbeat interval is honoured up to this (a longer one could keep a vanished peer "online"). */
const MAX_EVERY = 30 * 60_000;

export function status({ interval = 20_000, hiddenInterval = 300_000, presence = true, readReceipts = true, typingThrottleMs = 3000, typingTtlMs = 5000, receiptThrottleMs = 2000 } = {}) {
  return (qu) => {
    if (typeof qu.members !== 'function') throw new Error('status(): install records() and members() first');
    const { bus } = qu;
    const signals = signalsPlugin()(qu);
    /** @type {Map<string, Promise<object>>} */
    const trackers = new Map();
    let connected = 0;
    /** After a clean leave nothing announces "online" by itself (heartbeat, replies) until we come back. */
    let away = false;
    const doc = globalThis.document;
    let hidden = doc?.visibilityState === 'hidden';
    /** The heartbeat interval right now (hidden: slower). */
    const every = () => (hidden ? hiddenInterval : interval);

    // ticks at the visible rate; each tracker beats when its current interval is due
    qu.timers.interval(() => {
      if (connected === 0 || (hidden && hiddenInterval === 0)) return;
      for (const t of trackers.values()) t.then((s) => s.beat()).catch(() => {});
    }, interval);

    /** Visible <-> hidden: announce at once, so the others learn the new interval (or that we left). */
    function setHidden(value) {
      if (Boolean(value) === hidden) return;
      hidden = Boolean(value);
      for (const t of trackers.values()) {
        // hidden: tell the slower interval (or leave); visible again: back, even after a leave
        const step = (s) => (!hidden ? s.announce('online') : hiddenInterval === 0 ? s.announce('offline') : s.announce('online', { auto: true }));
        t.then(step).catch(() => {});
      }
      bus.notify('qu.status.hidden', { hidden });
    }

    bus.on('net.peer.up', () => {
      connected++;
      for (const t of trackers.values()) t.then((s) => s.announce()).catch(() => {});
    });
    bus.on('net.peer.down', () => {
      connected = Math.max(0, connected - 1);
    });
    globalThis.addEventListener?.('pagehide', () => leave());
    doc?.addEventListener?.('visibilitychange', () => setHidden(doc.visibilityState === 'hidden'));

    function tracker(space) {
      if (!trackers.has(space.id)) trackers.set(space.id, createTracker(space));
      return trackers.get(space.id);
    }

    async function createTracker(space) {
      const sid = space.id;
      const members = await qu.members(space);
      const me = members.me;
      /** @type {Map<string, {lastSeen: number, state: string}>} */
      const seen = new Map();
      /** @type {Map<string, Map<string, number>>} path -> alias -> expires */
      const typers = new Map();
      let lastAnnounce = 0;
      /** alias -> when we last answered its "I am here" (one answer per newcomer) */
      const repliedTo = new Map();
      const lastTyping = new Map();
      /** pending cursor updates per path */
      const cursors = new Map();
      const timers = new Map();

      const signal = (type, value) => (connected > 0 ? signals.send(space, type, value).catch(() => {}) : Promise.resolve());

      /** @param {'online'|'offline'} [state] @param {{auto?: boolean}} [options] `auto`: heartbeat/reply, skipped while away */
      async function announce(state = 'online', { auto = false } = {}) {
        if (!presence) return;
        if (state === 'offline') away = true;
        else if (auto && away) return;
        else away = false;
        lastAnnounce = Date.now();
        await signal('presence', state === 'online' ? { state, every: every() } : { state });
      }

      /** Heartbeat: announce if the current interval is due (a little early is fine). */
      function beat() {
        if (Date.now() - lastAnnounce >= every() - Math.min(1000, interval / 4)) return announce('online', { auto: true });
      }

      bus.on(`qu.signal.${sid}.presence`, async ({ author, value, at }) => {
        if (author === me) return;
        // signals are verified concurrently: an older heartbeat may finish after a newer "offline"
        if (at < (seen.get(author)?.lastSeen ?? 0)) return;
        const wasOnline = isOnline(author);
        const announced = Number.isFinite(value?.every) ? Math.min(MAX_EVERY, Math.max(1, value.every)) : interval;
        seen.set(author, { lastSeen: at, state: value?.state === 'offline' ? 'offline' : 'online', every: announced });
        await bus.notify('qu.status.presence', { space: sid, alias: author, online: isOnline(author) });
        // a newcomer (or someone back) learns about us right away; the exchange
        // stops by itself once both sides see each other online
        if (!wasOnline && value?.state !== 'offline' && Date.now() - (repliedTo.get(author) ?? 0) > 1000) {
          repliedTo.set(author, Date.now());
          await announce('online', { auto: true });
        }
      });

      // A newcomer's first heartbeat may arrive before its member entry (it is
      // then refused); once the member list changes, everyone re-announces,
      // and the newcomer answers - so both sides see each other. Throttled to
      // one announce per 250 ms, but POSTPONED, never dropped: a change right
      // after an announce would otherwise leave both sides blind until the
      // next heartbeat interval.
      let reannounce = null;
      bus.on('qu.members.changed', ({ space: changed }) => {
        if (changed !== sid || reannounce) return;
        reannounce = setTimeout(() => {
          reannounce = null;
          announce('online', { auto: true }).catch(() => {});
        }, Math.max(0, lastAnnounce + 250 - Date.now()));
        reannounce.unref?.();
      });

      bus.on(`qu.signal.${sid}.typing`, async ({ author, value }) => {
        if (author === me || typeof value?.path !== 'string') return;
        if (!typers.has(value.path)) typers.set(value.path, new Map());
        typers.get(value.path).set(author, Date.now() + typingTtlMs);
        await bus.notify('qu.status.typing', { space: sid, path: value.path, typing: typing(value.path) });
        const timer = setTimeout(() => bus.notify('qu.status.typing', { space: sid, path: value.path, typing: typing(value.path) }), typingTtlMs + 10);
        timer.unref?.();
      });

      // delivered cursors follow incoming records; receipts of others raise an event
      bus.on(`qu.record.${sid}`, async (record) => {
        if (record.path.startsWith(RECEIPTS)) {
          if (record.key !== me) await bus.notify('qu.status.receipts', { space: sid, path: record.path.slice(RECEIPTS.length), alias: record.key });
          return;
        }
        if (record.local || record.path.startsWith('_') || record.author === me) return;
        bump(record.path, { delivered: record.hlc });
      });

      async function currentCursor(path) {
        return (await qu.get(space, RECEIPTS + path, me)) ?? { delivered: '', read: '' };
      }

      /** Raises my cursor for `path` (never lowers it), written after `receiptThrottleMs`. */
      function bump(path, { delivered = '', read = '' }) {
        const next = cursors.get(path) ?? { delivered: '', read: '' };
        if (delivered > next.delivered) next.delivered = delivered;
        if (read > next.read) next.read = read;
        if (next.read > next.delivered) next.delivered = next.read;
        cursors.set(path, next);
        if (timers.has(path)) return;
        const timer = setTimeout(() => flush(path).catch(() => {}), receiptThrottleMs);
        timer.unref?.();
        timers.set(path, timer);
      }

      async function flush(path) {
        timers.delete(path);
        const wanted = cursors.get(path);
        cursors.delete(path);
        if (!wanted) return;
        const stored = await currentCursor(path);
        const next = {
          delivered: wanted.delivered > stored.delivered ? wanted.delivered : stored.delivered,
          read: readReceipts && wanted.read > stored.read ? wanted.read : stored.read,
        };
        if (next.delivered === stored.delivered && next.read === stored.read) return;
        const role = members.role();
        if (role !== 'owner' && role !== 'admin' && role !== 'member') return;
        await qu.write(space, RECEIPTS + path, next, { key: me });
      }

      function isOnline(alias) {
        const entry = seen.get(alias);
        return Boolean(entry && entry.state === 'online' && Date.now() - entry.lastSeen < (entry.every ?? interval) * 2.5);
      }

      function typing(path) {
        const now = Date.now();
        return [...(typers.get(path) ?? [])].filter(([, until]) => until > now).map(([alias]) => alias);
      }

      const api = {
        space,
        /** @returns {Map<string, {lastSeen: number, state: string, online: boolean}>} */
        online: () => new Map([...seen].map(([alias, e]) => [alias, { ...e, online: isOnline(alias) }])),
        isOnline,
        typing,
        /** Tell the others I am typing in `path` (throttled). */
        async sendTyping(path) {
          if (!presence || Date.now() - (lastTyping.get(path) ?? 0) < typingThrottleMs) return;
          lastTyping.set(path, Date.now());
          await signal('typing', { path });
        },
        /**
         * Marks `path` delivered up to its newest record - for what arrived
         * before tracking started (live arrivals are covered automatically).
         */
        async markDelivered(path) {
          const latest = (await qu.query({ space, path, limit: 1, reverse: true }))[0];
          if (latest && latest.author !== me) bump(path, { delivered: latest.hlc });
        },
        /** Marks `path` read up to `hlc` (default: its newest record) - written immediately. */
        async markRead(path, hlc) {
          const latest = hlc ?? (await qu.query({ space, path, limit: 1, reverse: true }))[0]?.hlc;
          if (!latest) return;
          bump(path, { delivered: latest, read: readReceipts ? latest : '' });
          clearTimeout(timers.get(path));
          await flush(path);
        },
        /**
         * Delivery state of a record for the other active members.
         * @returns {Promise<{sent: boolean, delivered: string[], read: string[], members: number}>}
         */
        async of(record) {
          const others = members.list().filter((m) => m.alias !== record.author && ['owner', 'admin', 'member'].includes(m.role)).map((m) => m.alias);
          const marks = new Map((await qu.query({ space, path: RECEIPTS + record.path })).map((r) => [r.key, r.value ?? {}]));
          const reached = (field) => others.filter((alias) => (marks.get(alias)?.[field] ?? '') >= record.hlc);
          const sent = typeof qu.syncState === 'function' ? (await qu.syncState(sid, record.id)) === 'sent' : true;
          return { sent, delivered: reached('delivered'), read: reached('read'), members: others.length };
        },
        announce,
        /** Clean leave: tell the others I am gone. */
        leave: () => announce('offline'),
        beat,
      };

      await announce();
      return api;
    }

    async function leave() {
      for (const t of trackers.values()) await t.then((s) => s.leave()).catch(() => {});
    }

    const api = { tracker, leave, setHidden };
    qu.status = tracker;
    /** For runtimes without document.visibilityState (React Native, Electron, Node): the app says when it is in the background. */
    qu.status.setHidden = setHidden;
    qu.status.isHidden = () => hidden;
    qu.leave = leave;
    return api;
  };
}
