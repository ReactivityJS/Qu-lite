/**
 * HYBRID LOGICAL CLOCK - assigned by the WRITING client, offline, never by a
 * relay. Encoded as a fixed-width string so lexicographic order IS causal
 * order and it can be used directly as a storage key component:
 *
 *   `<13-digit wall ms>-<4-hex counter>`   e.g. `1760090000000-0003`
 *
 * Ties between two writers with the same HLC are broken by the author key
 * (see `records.js`), never by the clock itself.
 */
const MS_WIDTH = 13;
const COUNTER_WIDTH = 4;
const MAX_COUNTER = 0xffff;

/** @param {number} ms @param {number} [counter] @returns {string} */
export function formatHlc(ms, counter = 0) {
  return `${String(ms).padStart(MS_WIDTH, '0')}-${counter.toString(16).padStart(COUNTER_WIDTH, '0')}`;
}

/** @param {string} hlc @returns {{ms: number, counter: number}} */
export function parseHlc(hlc) {
  const match = /^(\d{13})-([0-9a-f]{4})$/.exec(hlc);
  if (!match) throw new Error(`parseHlc: not a valid HLC: "${hlc}"`);
  return { ms: Number(match[1]), counter: parseInt(match[2], 16) };
}

/**
 * @param {{now?: () => number, maxDriftMs?: number}} [options]
 *   `maxDriftMs` (default 5 min): a remote HLC further than this in the
 *   future is rejected by `recv()`, so one device with a wrong clock can't
 *   drag everyone's clock (and every LWW decision) forward.
 */
export function createClock({ now = Date.now, maxDriftMs = 5 * 60 * 1000 } = {}) {
  let lastMs = 0;
  let counter = 0;

  const advance = (ms) => {
    if (ms > lastMs) {
      lastMs = ms;
      counter = 0;
    } else if (++counter > MAX_COUNTER) {
      lastMs += 1;
      counter = 0;
    }
  };

  return {
    /** A new HLC for a local write; strictly greater than every HLC this clock has issued or received. */
    tick() {
      advance(now());
      return formatHlc(lastMs, counter);
    },
    /**
     * Folds a remote HLC in. Returns false (and changes nothing) if it is
     * further in the future than `maxDriftMs` - the caller rejects that record.
     * @param {string} remote
     * @returns {boolean}
     */
    recv(remote) {
      const { ms, counter: rc } = parseHlc(remote);
      const wall = now();
      if (ms > wall + maxDriftMs) return false;
      if (ms > lastMs || (ms === lastMs && rc > counter)) {
        lastMs = ms;
        counter = rc;
      }
      advance(wall);
      return true;
    },
    /** Wall-clock ms as this clock sees it (tests inject `now`). */
    now: () => now(),
    /** The last HLC issued/observed, without advancing. */
    peek() {
      return formatHlc(lastMs, counter);
    },
  };
}
