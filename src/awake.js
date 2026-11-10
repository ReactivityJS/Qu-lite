/**
 * AWAKE - one Screen Wake Lock per peer, shared by everyone who needs the
 * device to stay on (blobs.js transfers, background.js outbox fallback).
 * Each user sets a REASON on or off; the lock is held while any reason is
 * on AND a peer is connected AND the page is visible - offline it would
 * only drain the battery. The system drops the lock when the page is
 * hidden; it is taken again on return.
 *
 *   const awake = awakeOf(qu);  awake.set('upload', true);  awake.held
 */

/**
 * @param {object} qu
 * @param {{wakeLock?: object|null, document?: object|null}} [options] - only the first call's options count
 * @returns {{set: (reason: string, on: boolean) => Promise<void>, readonly held: boolean, readonly reasons: string[]}}
 */
export function awakeOf(qu, { wakeLock = globalThis.navigator?.wakeLock ?? null, document: doc = globalThis.document ?? null } = {}) {
  if (qu.awake) return qu.awake;
  const reasons = new Set();
  let lock = null;
  let requesting = false;
  let connected = qu.net?.links?.size ?? 0; // links opened before this helper existed
  const wanted = () => reasons.size > 0 && connected > 0;

  async function update() {
    if (!wakeLock) return;
    if (wanted() && !lock && !requesting && doc?.visibilityState !== 'hidden') {
      requesting = true;
      try {
        lock = await wakeLock.request('screen');
        lock.addEventListener?.('release', () => (lock = null));
        if (!wanted()) await release();
      } catch {
        lock = null; // denied (battery saver, not visible): the sync still runs while the page is open
      } finally {
        requesting = false;
      }
    } else if (!wanted() && lock) await release();
  }
  async function release() {
    const held = lock;
    lock = null;
    await held?.release?.().catch(() => {});
  }
  qu.bus.on('net.peer.up', () => {
    connected++;
    return update();
  });
  qu.bus.on('net.peer.down', () => {
    connected = Math.max(0, connected - 1);
    return update();
  });
  const onVisibility = () => update();
  doc?.addEventListener?.('visibilitychange', onVisibility);
  qu.onClose?.(() => {
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    reasons.clear();
    return release();
  });

  qu.awake = {
    async set(reason, on) {
      if (on) reasons.add(reason);
      else reasons.delete(reason);
      await update();
    },
    get held() {
      return lock !== null;
    },
    get reasons() {
      return [...reasons];
    },
  };
  return qu.awake;
}
