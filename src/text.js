/**
 * TEXT - collaborative plain text on top of records: an RGA sequence CRDT
 * (Lamport-ordered character ids), so concurrent edits from any number of
 * members - online or offline - converge to the same text without a server.
 *
 *   const doc = await qu.text(space, 'notes/main')
 *   doc.insert(5, 'Hallo'); doc.delete(0, 3); doc.value()
 *   doc.on(({ text, remote }) => ...)
 *
 * Records (all private, padded, synced like any other record):
 *
 *   <path>           log entries: one BATCH of ops per `batchMs` of typing
 *                    {v: 1, site, ops: [['i', c, rc, rs, text], ['d', c, s, n]]}
 *                      'i': insert `text` after char (rc, rs) (null = start);
 *                           its chars get ids (c, site), (c+1, site), ...
 *                      'd': delete the chars (c..c+n-1, s)
 *   <path>/_snap     keyed by the AUTHOR's alias (others can't write that
 *                    key): the author's full state as runs, with tombstones
 *                    but without deleted text (applying ops twice is harmless:
 *                    ids are deduplicated, deletes idempotent)
 *
 * A char id is (counter, site); site = the author's alias prefix + a random
 * per-session suffix (one identity on two devices must not collide), and
 * every op of a batch must carry its author's site - forgeries are ignored.
 * Insertion follows RGA: after its reference char, skipping every char with
 * a greater id. Applying ops in counter order (refs always have smaller
 * counters) gives the same result on every peer.
 *
 * Compaction: snapshots are unions of ops (each char keeps its reference),
 * so any set of them merges. Each member snapshots its OWN state and then
 * drops its OWN covered batches (drop lists, gc.js) - nothing can be lost,
 * whoever compacts when. Older own snapshots are superseded and compacted
 * like any keyed entry (compaction.js auto).
 */
const SNAP = '_snap';
const idKey = (c, s) => `${c}@${s}`;
/** RGA order: higher counter first, then site. @returns {boolean} a sorts after b's position (a > b) */
const greater = (a, b) => a.c > b.c || (a.c === b.c && a.s > b.s);

/**
 * The CRDT itself, independent of storage - exported for tests and tools.
 */
export class TextCrdt {
  /** @type {Array<{c: number, s: string, ch: string, del: boolean, rc: number|null, rs: string|null}>} */
  chars = [];
  #byId = new Map();
  #pending = []; // inserts whose reference is not known yet
  #pendingDeletes = new Set();
  clock = 0;

  get size() {
    return this.chars.length;
  }

  /** @returns {string} */
  value() {
    let out = '';
    for (const el of this.chars) if (!el.del) out += el.ch;
    return out;
  }

  /** @returns {boolean} false if its reference is still missing (kept pending) */
  #integrate(el) {
    const key = idKey(el.c, el.s);
    if (this.#byId.has(key)) return true;
    let i = 0;
    if (el.rc !== null) {
      const ref = this.#byId.get(idKey(el.rc, el.rs));
      if (!ref) return false;
      i = this.chars.indexOf(ref) + 1;
    }
    while (i < this.chars.length && greater(this.chars[i], el)) i++;
    if (this.#pendingDeletes.delete(key)) el.del = true;
    this.chars.splice(i, 0, el);
    this.#byId.set(key, el);
    if (el.c > this.clock) this.clock = el.c;
    return true;
  }

  /** Applies one op (from any site). */
  apply(op) {
    if (op[0] === 'i') {
      const [, c, rc, rs, text, site] = op;
      [...text].forEach((ch, k) => {
        const el = { c: c + k, s: site, ch, del: false, rc: k === 0 ? rc : c + k - 1, rs: k === 0 ? rs : site };
        if (!this.#integrate(el)) this.#pending.push(el);
      });
      this.#retry();
    } else if (op[0] === 'd') {
      const [, c, s, n] = op;
      for (let k = 0; k < n; k++) {
        const el = this.#byId.get(idKey(c + k, s));
        if (el) el.del = true;
        else this.#pendingDeletes.add(idKey(c + k, s));
      }
      if (c + n - 1 > this.clock) this.clock = c + n - 1;
    }
  }

  #retry() {
    let progress = true;
    while (progress && this.#pending.length) {
      progress = false;
      this.#pending = this.#pending.filter((el) => {
        const done = this.#integrate(el);
        if (done) progress = true;
        return !done;
      });
    }
  }

  /** Visible index -> the element there (null past the end). */
  #visible(index) {
    let seen = 0;
    for (const el of this.chars) {
      if (el.del) continue;
      if (seen === index) return el;
      seen++;
    }
    return null;
  }

  /** Local insert. @returns {Array} the op */
  insert(index, text, site) {
    if (!text) return null;
    const left = index > 0 ? this.#visible(index - 1) : null;
    if (index > 0 && !left) throw new RangeError('text: insert position out of range');
    const op = ['i', this.clock + 1, left?.c ?? null, left?.s ?? null, text, site];
    this.apply(op);
    return op;
  }

  /** Local delete. @returns {Array[]} ops, one per run of consecutive ids */
  delete(index, length) {
    const ops = [];
    let seen = 0;
    for (const el of this.chars) {
      if (el.del) continue;
      if (seen >= index + length) break;
      if (seen >= index) {
        el.del = true;
        const last = ops.at(-1);
        if (last && last[2] === el.s && last[1] + last[3] === el.c) last[3]++;
        else ops.push(['d', el.c, el.s, 1]);
      }
      seen++;
    }
    return ops;
  }

  /** A position that survives remote edits: the id of the char at `index` (or the end). */
  anchor(index) {
    const el = this.#visible(index);
    return el ? idKey(el.c, el.s) : null;
  }

  /** @returns {number} the visible index of an anchor (a deleted char: where it was) */
  indexOf(anchor) {
    if (anchor === null) return this.value().length;
    let seen = 0;
    for (const el of this.chars) {
      if (idKey(el.c, el.s) === anchor) return seen;
      if (!el.del) seen++;
    }
    return seen;
  }

  /** Runs for a snapshot: [c, s, rc, rs, text | deletedLength]. */
  runs() {
    const runs = [];
    for (const el of this.chars) {
      const last = runs.at(-1);
      const chained = last && last[1] === el.s && el.rc === last.end && el.rs === el.s && el.c === last.end + 1 && (typeof last[4] === 'number') === el.del;
      if (chained) {
        if (el.del) last[4]++;
        else last[4] += el.ch;
        last.end = el.c;
      } else {
        const run = [el.c, el.s, el.rc, el.rs, el.del ? 1 : el.ch];
        run.end = el.c;
        runs.push(run);
      }
    }
    return runs.map(([c, s, rc, rs, body]) => [c, s, rc, rs, body]);
  }

  /** Loads runs (a snapshot) - in counter order, like any ops. */
  static opsOfRuns(runs) {
    const ops = [];
    for (const [c, s, rc, rs, body] of runs) {
      const deleted = typeof body === 'number';
      const text = deleted ? '\u0000'.repeat(body) : body;
      ops.push(['i', c, rc, rs, text, s]);
      if (deleted) ops.push(['d', c, s, body]);
    }
    return ops;
  }
}

const opsOf = (value) => (value?.v === 1 && Array.isArray(value.ops) ? value.ops : []);
const siteOk = (site, author) => typeof site === 'string' && site.startsWith(author.slice(0, 12) + '.');

/**
 * @param {{batchMs?: number, snapshotEvery?: number}} [options]
 *   `batchMs`: local edits within this window become one record.
 *   `snapshotEvery`: own batches after which `compact()` runs by itself (0: never).
 */
export function text({ batchMs = 300, snapshotEvery = 200 } = {}) {
  return (qu) => {
    if (!qu.records) throw new Error('text(): install records() first');
    if (qu.text) return qu.text;
    const { bus } = qu;
    const records = qu.records;
    /** @type {Map<string, Promise<object>>} */
    const docs = new Map();

    // nobody may write another member's snapshot key (it would supersede theirs)
    bus.on('qu.accept', (record, ctx) => {
      if (record.path?.endsWith(`/${SNAP}`) && record.key !== record.author) {
        ctx.reason = 'not your snapshot';
        ctx.stop();
      }
    });

    async function open(spaceRef, path) {
      const space = records.spaceOf(spaceRef);
      if (path.split('/').includes(SNAP)) throw new Error(`text: ${SNAP} is reserved`);
      const me = await records.authorOf(space);
      const site = `${me.slice(0, 12)}.${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const crdt = new TextCrdt();
      const applied = new Set(); // batch record ids folded in
      const listeners = new Set();
      let queue = [];
      let timer = null;
      let ownSinceSnapshot = [];
      let closed = false;

      const emit = (remote) => {
        const value = crdt.value();
        for (const fn of listeners) fn({ text: value, remote });
      };

      /** Ops of a batch or snapshot record - only those its author may have written. */
      function applyRecord(record, ops) {
        const valid = ops.filter((op) => (op[0] === 'i' ? siteOk(op[5], record.author) : op[0] === 'd'));
        valid.sort((a, b) => a[1] - b[1]);
        for (const op of valid) crdt.apply(op);
      }
      const batchOps = (record) => opsOf(record.value).map((op) => (op[0] === 'i' ? [...op.slice(0, 5), record.value.site] : op));

      // initial state: every member's snapshot, then the batches they don't cover - all in counter order
      const snapshots = await qu.query({ space, path: `${path}/${SNAP}` });
      const batches = await qu.query({ space, path });
      const all = [];
      for (const snap of snapshots) {
        if (snap.key !== snap.author || !Array.isArray(snap.value?.runs)) continue;
        // a snapshot may hold anyone's chars (it is its author's full state) - but deletes and
        // inserts only as they came in, so its inserts are taken as they are
        all.push(...TextCrdt.opsOfRuns(snap.value.runs));
      }
      for (const batch of batches) {
        if (!siteOk(batch.value?.site, batch.author)) continue;
        applied.add(batch.id);
        all.push(...batchOps(batch));
        if (batch.author === me) ownSinceSnapshot.push(batch);
      }
      all.sort((a, b) => a[1] - b[1] || (a[0] === 'i' ? -1 : 1));
      for (const op of all) crdt.apply(op);

      const offRecord = bus.on(`qu.record.${space.id}`, (record) => {
        if (record.local || closed) return;
        if (record.path === path) {
          if (applied.has(record.id) || !siteOk(record.value?.site, record.author)) return;
          applied.add(record.id);
          applyRecord(record, batchOps(record));
          emit(true);
        } else if (record.path === `${path}/${SNAP}` && record.key === record.author && Array.isArray(record.value?.runs)) {
          const before = crdt.value();
          for (const op of TextCrdt.opsOfRuns(record.value.runs)) crdt.apply(op);
          if (crdt.value() !== before) emit(true);
        }
      });
      const unwatch = typeof qu.watch === 'function' ? await qu.watch({ space, path }).catch(() => null) : null;

      async function flush() {
        clearTimeout(timer);
        timer = null;
        if (!queue.length) return;
        const ops = queue.map((op) => (op[0] === 'i' ? op.slice(0, 5) : op));
        queue = [];
        const record = await records.write(space, path, { v: 1, site, ops });
        applied.add(record.id);
        ownSinceSnapshot.push(record);
        if (snapshotEvery > 0 && ownSinceSnapshot.length >= snapshotEvery) await compact();
      }

      const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => flush().catch((error) => bus.error?.(error)), batchMs);
        timer.unref?.();
      };

      /**
       * Writes my snapshot (everything I know) and drops my own batches it
       * covers. Others' batches stay until they compact (or an admin does).
       */
      async function compact() {
        await flush();
        const mine = ownSinceSnapshot;
        ownSinceSnapshot = [];
        await records.write(space, `${path}/${SNAP}`, { v: 1, runs: crdt.runs() }, { key: me });
        // my snapshot holds every op of my batches: they can go, everywhere
        if (mine.length) await records.dropList(space, mine.map((r) => ({ id: r.id, path: r.path, ts: r.ts, author: r.author })));
        return { dropped: mine.length, chars: crdt.size };
      }

      const doc = {
        path,
        site,
        value: () => crdt.value(),
        insert(index, str) {
          const op = crdt.insert(index, str, site);
          if (op) {
            queue.push(op);
            schedule();
            emit(false);
          }
        },
        delete(index, length) {
          const ops = crdt.delete(index, length);
          if (ops.length) {
            queue.push(...ops);
            schedule();
            emit(false);
          }
        },
        /** Replaces the whole text by `next`, as the smallest single edit (common prefix/suffix kept). */
        set(next) {
          const prev = crdt.value();
          let start = 0;
          while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
          let end = 0;
          while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
          if (prev.length - start - end > 0) doc.delete(start, prev.length - start - end);
          if (next.length - start - end > 0) doc.insert(start, next.slice(start, next.length - end));
        },
        anchor: (index) => crdt.anchor(index),
        indexOf: (anchor) => crdt.indexOf(anchor),
        /** @param {(change: {text: string, remote: boolean}) => void} fn @returns {() => void} */
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        flush,
        compact,
        stats: () => ({ chars: crdt.size, batches: applied.size, pendingOps: queue.length }),
        async close() {
          await flush();
          closed = true;
          offRecord();
          unwatch?.();
          docs.delete(`${space.id}/${path}`);
        },
      };
      return doc;
    }

    /**
     * Opens (once per space and path) a collaborative text.
     * @param {import('./space.js').Space|string} space
     * @param {string} path
     */
    function textDoc(space, path) {
      const key = `${typeof space === 'string' ? space : space.id}/${path}`;
      if (!docs.has(key)) docs.set(key, open(space, path).catch((error) => (docs.delete(key), Promise.reject(error))));
      return docs.get(key);
    }

    qu.text = textDoc;
    return textDoc;
  };
}
