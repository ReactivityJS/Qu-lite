/**
 * WRITE SET - collects the writes of one logical step (one envelope with
 * all its indexes and its outbox entry, one repair, ...) and commits them
 * with ONE `storage.batch()`: all or nothing, as far as the driver can
 * (memory, SQLite and IndexedDB batches are atomic; across several mounts,
 * each mount is atomic on its own).
 *
 * Decisions that depend on the committed state of other keys (which
 * version of a keyed entry is current) are registered with `locked()`: they
 * run right before the batch, inside the caller's per-space commit lock.
 *
 * Side effects that must only happen once the data is durable (bus
 * notifications, caches) are registered with `after()` and run after a
 * successful commit - never for a failed one.
 */
export function writeSet(storage) {
  const ops = [];
  const after = [];
  const locked = [];
  return {
    /** Outcome a `locked()` step may set (e.g. 'stored' | 'superseded'). */
    status: undefined,
    set(key, value) {
      ops.push({ op: 'set', key, value });
    },
    remove(key) {
      ops.push({ op: 'remove', key });
    },
    /** @param {() => *} fn - runs inside the commit lock, right before the batch; may add ops */
    locked(fn) {
      locked.push(fn);
    },
    /** @param {() => *} fn - runs after a successful commit */
    after(fn) {
      after.push(fn);
    },
    get ops() {
      return ops;
    },
    /** Runs the `locked()` steps, then writes all ops in one batch (no side effects yet). */
    async flush() {
      for (const fn of locked) await fn();
      if (ops.length) await storage.batch(ops);
    },
    /** Runs the `after()` side effects - only once `flush()` succeeded. */
    async settle() {
      for (const fn of after) await fn();
    },
    async commit() {
      await this.flush();
      await this.settle();
    },
  };
}
