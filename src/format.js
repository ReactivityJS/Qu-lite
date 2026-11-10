/**
 * STORAGE FORMAT - which layout the stored data has (`qu/format`), checked
 * when a peer opens its store (peer.js):
 *
 *   none     a new store (or one from before this marker): this format is written
 *   older    the MIGRATIONS from there up run in order, then the marker moves
 *   same     nothing to do
 *   newer    the start is refused (`QU_FORMAT_NEWER`): an older app version must
 *            not read, or worse write, data an update has already converted
 *
 * A future change of the layout adds one entry: `MIGRATIONS[1] = async (store) => {...}`
 * converts format 1 to 2, and `FORMAT` becomes 2. Each step must be safe to run
 * again after a crash (the marker moves only after it finished).
 */
export const FORMAT = 1;

/** @type {Record<number, (store: object) => Promise<void>>} from format n to n + 1 */
export const MIGRATIONS = {};

/**
 * @param {object} store - the root driver
 * @param {{migrations?: Record<number, Function>, format?: number}} [options] - for tests
 * @returns {Promise<{from: number|null, to: number}>}
 */
export async function checkFormat(store, { migrations = MIGRATIONS, format = FORMAT } = {}) {
  const from = await store.get('qu/format');
  if (from == null) {
    await store.set('qu/format', format);
    return { from: null, to: format };
  }
  if (!Number.isInteger(from)) throw Object.assign(new Error(`storage: unreadable format marker ${JSON.stringify(from)}`), { code: 'QU_FORMAT_NEWER' });
  if (from > format) throw Object.assign(new Error(`storage: written by a newer version (format ${from}, this one reads ${format}) - update the app`), { code: 'QU_FORMAT_NEWER', format: from });
  for (let n = from; n < format; n++) {
    if (!migrations[n]) throw Object.assign(new Error(`storage: no migration from format ${n}`), { code: 'QU_FORMAT_NEWER', format: from });
    await migrations[n](store);
    await store.set('qu/format', n + 1);
  }
  return { from, to: format };
}
